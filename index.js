const express = require('express');
const { Telegraf } = require('telegraf');
const OpenAI = require('openai');

const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SPARKY_API_URL = process.env.SPARKY_API_URL; 
const SPARKY_API_KEY = process.env.SPARKY_API_KEY;
const PORT = process.env.PORT || 8080;

// webhookReply: false force Telegraf à ne pas répondre de lui-même à la requête HTTP,
// ce qui nous permet de la garder ouverte manuellement.
const bot = new Telegraf(TELEGRAM_TOKEN, {
  telegram: { webhookReply: false }
});

const openai = new OpenAI({ 
  apiKey: process.env.GEMINI_API_KEY,
  baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/"
});

// Cache en mémoire pour bloquer les retries de Telegram (Idempotence)
// Si Cloud Run redémarre, le cache est vidé, mais ce n'est pas grave pour de l'anti-retry à court terme.
const processedUpdates = new Set();

const SYSTEM_PROMPT = `Tu es l'assistant nutritionnel personnel de l'utilisateur pour SparkyFitness.
Règle stricte de recherche pour ajouter un aliment, tu dois procéder dans cet ordre EXACT :
1. Utilise 'sparky_get_favorite_foods' pour vérifier si l'aliment est dans les favoris.
2. Si non trouvé, utilise 'sparky_search_food' pour chercher dans sa base locale.
3. Si toujours non trouvé, utilise 'sparky_search_food' pour chercher dans OpenFoodFacts ou SwissFood.
4. Une fois trouvé, utilise 'sparky_manage_food' pour l'ajouter avec la bonne quantité.
Exécute les recherches silencieusement et logue le repas.`;

// CORRECTION CRITIQUE ZOD : foodName -> food_name
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
                food_name: { type: "string" }, // Backend Cloud Run attend du snake_case
                quantity: { type: "number" },
                unit: { type: "string" }
              },
              required: ["food_name", "quantity"] // Mise à jour de la clé requise
            }
          }
        },
        required: ["action", "items"]
      }
    }
  }
];

// Appel stateless strict
async function callSparkyMCP(toolCallId, toolName, parsedArguments) {
  const mcpResponse = await fetch(`${SPARKY_API_URL}/mcp`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SPARKY_API_KEY}`,
      'Content-Type': 'application/json',
      'mcp-protocol-version': '2024-11-05',
      'Accept': 'application/json' // Plus propre sans le text/event-stream qui est pour le SSE natif
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: toolCallId,
      method: "tools/call",
      params: { name: toolName, arguments: parsedArguments }
    })
  });

  if (!mcpResponse.ok) {
    const errText = await mcpResponse.text();
    throw new Error(`Erreur MCP (${mcpResponse.status}): ${errText}`);
  }
  
  return await mcpResponse.json();
}

bot.on('text', async (ctx) => {
  const updateId = ctx.update.update_id;

  // 1. MÉCANISME D'IDEMPOTENCE (ANTI-RETRY)
  if (processedUpdates.has(updateId)) {
    console.log(`[Anti-Doublon] Update ${updateId} déjà traité. Ignoré.`);
    return; // On coupe court, on ne fait rien.
  }
  
  // On enregistre cet update
  processedUpdates.add(updateId);
  // Nettoyage pour éviter les fuites de mémoire (Garde les 500 derniers)
  if (processedUpdates.size > 500) {
    const firstItem = processedUpdates.values().next().value;
    processedUpdates.delete(firstItem);
  }

  try {
    const userMessage = ctx.message.text;
    
    // On notifie Telegram que le bot est en train d'écrire
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
        
        console.log(`Execution de ${toolCall.function.name}...`);
        const mcpResult = await callSparkyMCP(toolCall.id, toolCall.function.name, parsedArgs);

        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: JSON.stringify(mcpResult.result || mcpResult)
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

// 2. GESTION DU WEBHOOK SANS FREEZE CPU
app.post(webhookPath, async (req, res, next) => {
  try {
    // Le "await" est crucial : Express bloque la requête HTTP entrante
    // tant que bot.on('text') n'a pas fini de tourner.
    // Cela empêche Cloud Run de couper le CPU car la requête est considérée comme "Active".
    await bot.handleUpdate(req.body);
    
    // Une fois Gemini et MCP terminés, on relâche la connexion pour Telegram.
    if (!res.headersSent) {
      res.sendStatus(200);
    }
  } catch(err) {
    console.error("Erreur Webhook:", err);
    if (!res.headersSent) res.sendStatus(500);
  }
});

app.get('/', (req, res) => res.send('Bot Telegram Sparky avec Gemini Actif !'));

app.listen(PORT, () => console.log(`Microservice démarré sur le port ${PORT}`));
