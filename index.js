const express = require('express');
const { Telegraf } = require('telegraf');
const OpenAI = require('openai');

const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SPARKY_API_URL = process.env.SPARKY_API_URL; 
const SPARKY_API_KEY = process.env.SPARKY_API_KEY;
const PORT = process.env.PORT || 8080;

// webhookReply: false est VITAL sur Cloud Run. Cela permet à Express de maintenir 
// la requête ouverte et d'empêcher le CPU de passer en "throttle" (0%).
const bot = new Telegraf(TELEGRAM_TOKEN, {
  telegram: { webhookReply: false }
});

const openai = new OpenAI({ 
  apiKey: process.env.GEMINI_API_KEY,
  baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/"
});

// Cache d'idempotence : évite d'insérer des doublons dans Neon si Telegram fait un retry
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
                food_name: { type: "string" }, // CORRECTION CRITIQUE: snake_case obligatoire pour le Zod du backend
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

// Extracteur SSE Stateless (Server-Sent Events) optimisé pour Cloud Run
async function callSparkyMCP(toolCallId, toolName, parsedArguments) {
  const mcpResponse = await fetch(`${SPARKY_API_URL}/mcp`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SPARKY_API_KEY}`,
      'Content-Type': 'application/json',
      'mcp-protocol-version': '2024-11-05',
      'Accept': 'application/json, text/event-stream' // Requis par le backend SparkyFitness
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: toolCallId,
      method: "tools/call",
      params: { name: toolName, arguments: parsedArguments }
    })
  });

  const responseText = await mcpResponse.text();

  if (!mcpResponse.ok) {
    throw new Error(`Erreur MCP HTTP ${mcpResponse.status}: ${responseText}`);
  }

  // Le serveur SparkyFitness utilise StreamableHTTPServerTransport.
  // Il écrit un flux SSE puis ferme la connexion (200 OK).
  // Nous extrayons manuellement la ligne contenant le JSON-RPC "data: {...}"
  const lines = responseText.split('\n');
  let dataPayload = "";
  
  for (const line of lines) {
    if (line.startsWith('data:')) {
      dataPayload += line.substring(5).trim();
    }
  }

  if (dataPayload) {
    try {
      return JSON.parse(dataPayload);
    } catch (e) {
      throw new Error(`Erreur de parsing JSON de la réponse MCP : ${e.message}`);
    }
  }

  // Fallback au cas où une future mise à jour backend renverrait du JSON standard
  try {
    return JSON.parse(responseText);
  } catch (e) {
    throw new Error(`Aucune réponse JSON-RPC trouvée.\nPayload reçu: ${responseText}`);
  }
}

bot.on('text', async (ctx) => {
  const updateId = ctx.update.update_id;

  // 1. MÉCANISME D'IDEMPOTENCE
  if (processedUpdates.has(updateId)) return;
  
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

      // S'il n'y a plus d'appel d'outils, Gemini a fini son raisonnement
      if (!responseMessage.tool_calls || responseMessage.tool_calls.length === 0) {
        if (responseMessage.content) finalReply = responseMessage.content;
        isDone = true;
        break;
      }

      for (const toolCall of responseMessage.tool_calls) {
        const parsedArgs = JSON.parse(toolCall.function.arguments);
        console.log(`[MCP] Appel de l'outil ${toolCall.function.name}...`);
        
        const mcpResult = await callSparkyMCP(toolCall.id, toolCall.function.name, parsedArgs);

        // 2. EXTRACTION DU TEXTE BRUT POUR LE LLM
        // L'adaptateur MCP de SparkyFitness renvoie: { result: { content: [{ type: 'text', text: "..." }] } }
        let toolResponseText = "";
        if (mcpResult.result && mcpResult.result.content && mcpResult.result.content.length > 0) {
          toolResponseText = mcpResult.result.content[0].text;
        } else if (mcpResult.error) {
          toolResponseText = `Error: ${mcpResult.error.message}`;
        } else {
          toolResponseText = JSON.stringify(mcpResult);
        }

        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: toolResponseText // On donne le texte clair à Gemini pour qu'il comprenne le résultat
        });

        // Dès que l'aliment est géré en base Neon, on arrête la boucle
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

app.post('/telegram-webhook', async (req, res, next) => {
  try {
    // 3. AWAIT BLOQUANT
    // Maintient la connexion Express ouverte jusqu'à la fin des requêtes API/Gemini.
    // Garantit que le CPU de Cloud Run reste éveillé en mode "allocated only during request".
    await bot.handleUpdate(req.body);
    if (!res.headersSent) res.sendStatus(200);
  } catch(err) {
    console.error("Erreur Webhook:", err);
    if (!res.headersSent) res.sendStatus(500);
  }
});

app.get('/', (req, res) => res.send('Bot Telegram Sparky avec Extracteur SSE et Cache Idempotent actifs !'));

app.listen(PORT, () => console.log(`Microservice Telegram démarré sur le port ${PORT}`));
