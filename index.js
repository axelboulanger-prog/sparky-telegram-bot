const express = require('express');
const { Telegraf } = require('telegraf');
const OpenAI = require('openai');

const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SPARKY_API_URL = process.env.SPARKY_API_URL; 
const SPARKY_API_KEY = process.env.SPARKY_API_KEY;
const PORT = process.env.PORT || 8080;

// Désactivation de la réponse webhook pour empêcher Cloud Run de geler le CPU
// La route Express gardera la connexion HTTP ouverte jusqu'à la fin de la requête Gemini + MCP
const bot = new Telegraf(TELEGRAM_TOKEN, {
  telegram: { webhookReply: false }
});

const openai = new OpenAI({ 
  apiKey: process.env.GEMINI_API_KEY,
  baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/"
});

// Cache en mémoire pour bloquer les retries de Telegram (Idempotence)
const processedUpdates = new Set();

const SYSTEM_PROMPT = `Tu es l'assistant nutritionnel personnel de l'utilisateur pour SparkyFitness.
Règle stricte de recherche pour ajouter un aliment, tu dois procéder dans cet ordre EXACT :
1. Utilise 'sparky_get_favorite_foods' pour vérifier si l'aliment est dans les favoris.
2. Si non trouvé, utilise 'sparky_search_food' pour chercher dans sa base locale.
3. Si toujours non trouvé, utilise 'sparky_search_food' pour chercher dans OpenFoodFacts ou SwissFood.
4. Une fois trouvé, utilise 'sparky_manage_food' pour l'ajouter avec la bonne quantité.
Exécute les recherches silencieusement et logue le repas.`;

const tools = [
  {
    type: "function",
    function: {
      name: "sparky_get_favorite_foods",
      description: "Récupère la liste des aliments favoris de l'utilisateur.",
      parameters: { type: "object", properties: {}, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "sparky_search_food",
      description: "Recherche un aliment dans la base de données ou via des fournisseurs externes.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Le nom de l'aliment à chercher" }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "sparky_manage_food",
      description: "Ajoute l'aliment final dans le journal de l'utilisateur.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["add"] },
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                food_name: { type: "string" }, // Clé corrigée (snake_case pour SparkyFitnessServer)
                quantity: { type: "number" },
                unit: { type: "string" }
              },
              required: ["food_name", "quantity"]
            }
          }
        },
        required: ["action", "items"]
      }
    }
  }
];

// Fonction client MCP gérant proprement le Server-Sent Events (SSE) attendu par SparkyFitnessServer
async function callSparkyMCP(toolName, parsedArguments) {
  // Import dynamique pour éviter les conflits ESM/CommonJS sous Node 20
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');

  // L'endpoint racine SSE de SparkyFitnessServer est /mcp
  const transport = new SSEClientTransport(
    new URL(`${SPARKY_API_URL}/mcp`),
    {
      requestInit: {
        headers: { 'Authorization': `Bearer ${SPARKY_API_KEY}` }
      },
      eventSourceInit: {
        headers: { 'Authorization': `Bearer ${SPARKY_API_KEY}` }
      }
    }
  );

  const mcpClient = new Client(
    { name: "sparky-telegram-bot", version: "1.0.0" },
    { capabilities: {} }
  );

  try {
    await mcpClient.connect(transport);
    
    // Le SDK Client s'occupe de générer le JSON-RPC "id" en interne
    const result = await mcpClient.callTool({
      name: toolName,
      arguments: parsedArguments
    });
    
    return result;
  } finally {
    // Crucial sur Cloud Run : fermer le flux SSE pour libérer la mémoire et le thread
    try {
      await transport.close();
    } catch (err) {
      console.error("Erreur lors de la fermeture du transport MCP:", err);
    }
  }
}

bot.on('text', async (ctx) => {
  const updateId = ctx.update.update_id;

  // 1. MÉCANISME D'IDEMPOTENCE (ANTI-RETRY)
  if (processedUpdates.has(updateId)) {
    console.log(`[Anti-Doublon] Update ${updateId} déjà traité par Cloud Run. Ignoré.`);
    return;
  }
  
  processedUpdates.add(updateId);
  if (processedUpdates.size > 500) {
    const firstItem = processedUpdates.values().next().value;
    processedUpdates.delete(firstItem);
  }

  try {
    const userMessage = ctx.message.text;
    await ctx.sendChatAction('typing');

    let messages = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `Logue ce repas : ${userMessage}` }
    ];

    let isDone = false;
    let finalReply = "✅ Repas traité avec succès !";

    for (let i = 0; i < 5 && !isDone; i++) {
      const completion = await openai.chat.completions.create({
        model: "gemini-2.5-flash",
        messages: messages,
        tools: tools,
        tool_choice: "auto"
      });

      const responseMessage = completion.choices[0].message;
      messages.push(responseMessage);

      if (!responseMessage.tool_calls || responseMessage.tool_calls.length === 0) {
        if (responseMessage.content) finalReply = responseMessage.content;
        isDone = true;
        break;
      }

      for (const toolCall of responseMessage.tool_calls) {
        const parsedArgs = JSON.parse(toolCall.function.arguments);
        
        console.log(`[MCP] Appel de l'outil ${toolCall.function.name}...`);
        
        // Plus besoin de passer toolCall.id manuellement
        const mcpResult = await callSparkyMCP(toolCall.function.name, parsedArgs);

        // Le format natif de contenu de retour MCP
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(mcpResult.content || mcpResult)
        });

        if (toolCall.function.name === "sparky_manage_food") {
          isDone = true;
        }
      }
    }

    await ctx.reply(finalReply);
  } catch (error) {
    console.error("Erreur du bot:", error);
    await ctx.reply("❌ Une erreur est survenue lors de la synchronisation avec SparkyFitness.");
  }
});

const webhookPath = '/telegram-webhook';

app.post(webhookPath, async (req, res, next) => {
  try {
    // On attend explicitement la fin du processing. 
    // Cloud Run garde le CPU alloué car la requête Express reste "active".
    await bot.handleUpdate(req.body);
    
    if (!res.headersSent) res.sendStatus(200);
  } catch(err) {
    console.error("Erreur Webhook:", err);
    if (!res.headersSent) res.sendStatus(500);
  }
});

app.get('/', (req, res) => res.send('Bot Telegram Sparky avec Gemini Actif et MCP SSE !'));

app.listen(PORT, () => console.log(`Microservice Telegram démarré sur le port ${PORT}`));
