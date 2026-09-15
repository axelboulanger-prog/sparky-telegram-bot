const express = require('express');
const { Telegraf } = require('telegraf');
const OpenAI = require('openai');

const app = express();
app.use(express.json());

// Variables d'environnement injectées via Google Cloud Run
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SPARKY_API_URL = process.env.SPARKY_API_URL; // Ex: https://api-xxx-uc.a.run.app
const SPARKY_API_KEY = process.env.SPARKY_API_KEY;
const PORT = process.env.PORT || 8080;

// webhookReply: false maintient la requête HTTP ouverte sur Cloud Run (évite les timeouts Telegram)
const bot = new Telegraf(TELEGRAM_TOKEN, {
  telegram: { webhookReply: false }
});

const openai = new OpenAI({ 
  apiKey: process.env.GEMINI_API_KEY,
  baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/"
});

// Cache d'idempotence pour éviter de traiter 2 fois le même message Telegram
const processedUpdates = new Set();

const SYSTEM_PROMPT = `Tu es l'assistant nutritionnel personnel de l'utilisateur pour SparkyFitness.
Pour ajouter un aliment, procède dans cet ordre :
1. Utilise 'sparky_manage_favorites' avec l'action 'list_favorites' pour chercher dans les favoris.
2. Si non trouvé, utilise 'sparky_search_food' pour chercher.
3. Utilise 'sparky_manage_food' pour loguer le repas. L'action est généralement 'log_food' ou 'add'. 

Règle stricte pour sparky_manage_food : 
Traduis ou insère systématiquement le type de repas demandé (ex: collation, breakfast, lunch, dinner, snack) dans le paramètre "meal_type".

IMPORTANT : Analyse le retour des outils. Si un outil renvoie une "Error", lis les champs attendus et relance l'outil avec les bons paramètres. Confirme à l'utilisateur uniquement quand l'ajout a réussi.`;

// Schémas des outils MCP assouplis pour l'Agent Autonome
const tools = [
  {
    type: "function",
    function: {
      name: "sparky_manage_favorites",
      description: "Gère les favoris. Utilise l'action 'list_favorites' pour récupérer la liste.",
      parameters: { 
        type: "object", 
        properties: {
          action: { type: "string" },
          type: { type: "string" }
        }, 
        required: ["action"] 
      }
    }
  },
  {
    type: "function",
    function: {
      name: "sparky_search_food",
      description: "Recherche un aliment par mot-clé.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "sparky_manage_food",
      description: "Ajoute l'aliment final dans le journal. Assure-toi d'inclure le food_id si tu l'as trouvé.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", description: "L'action à effectuer (ex: log_food)" },
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                food_id: { type: "string" },
                food_name: { type: "string" },
                quantity: { type: "number" },
                unit: { type: "string" },
                // Ajout crucial pour SparkyFitnessServer :
                meal_type: { type: "string", description: "Le type de repas cible (ex: collation, breakfast, lunch, dinner)" }
              }
            }
          }
        },
        required: ["action", "items"]
      }
    }
  }
];

// Extracteur SSE robuste pour communiquer avec l'API Principale SparkyFitness
async function callSparkyMCP(toolCallId, toolName, parsedArguments) {
  // L'appel POST est dirigé vers la route /mcp du backend Cloud Run (qui contourne l'intercepteur /api/auth normal)
  const mcpResponse = await fetch(`${SPARKY_API_URL}/mcp`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${SPARKY_API_KEY}`,
      'Content-Type': 'application/json',
      'mcp-protocol-version': '2024-11-05',
      'Accept': 'application/json, text/event-stream'
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

  // Traitement du flux SSE renvoyé par SparkyFitnessServer
  const events = responseText.split('\n\n');
  for (const eventBlock of events) {
    const lines = eventBlock.split('\n');
    let dataPayload = "";
    for (const line of lines) {
      if (line.startsWith('data:')) {
        dataPayload += line.substring(5).trim();
      }
    }
    if (dataPayload) {
      try {
        const parsed = JSON.parse(dataPayload);
        if (parsed.jsonrpc === "2.0") return parsed;
      } catch (e) {}
    }
  }

  try {
    return JSON.parse(responseText);
  } catch (e) {
    throw new Error(`Aucune réponse JSON-RPC trouvée.\nPayload: ${responseText.substring(0, 150)}...`);
  }
}

bot.on('text', async (ctx) => {
  const updateId = ctx.update.update_id;
  if (processedUpdates.has(updateId)) return;
  
  processedUpdates.add(updateId);
  if (processedUpdates.size > 500) {
    processedUpdates.delete(processedUpdates.values().next().value);
  }

  try {
    const userMessage = ctx.message.text;
    await ctx.sendChatAction('typing');

    let messages = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userMessage }
    ];

    let isDone = false;
    let finalReply = "Traitement terminé.";

    for (let i = 0; i < 6 && !isDone; i++) {
      const completion = await openai.chat.completions.create({
        model: "gemini-2.5-flash",
        messages: messages,
        tools: tools,
        tool_choice: "auto"
      });

      const responseMessage = completion.choices[0].message;
      messages.push(responseMessage);

      // Si l'Agent IA (Gemini) n'appelle plus d'outil, le traitement est fini
      if (!responseMessage.tool_calls || responseMessage.tool_calls.length === 0) {
        if (responseMessage.content) finalReply = responseMessage.content;
        isDone = true;
        break;
      }

      // Exécution des outils MCP demandés
      for (const toolCall of responseMessage.tool_calls) {
        const parsedArgs = JSON.parse(toolCall.function.arguments);
        console.log(`[MCP] Appel de l'outil ${toolCall.function.name}...`);
        
        try {
          const mcpResult = await callSparkyMCP(toolCall.id, toolCall.function.name, parsedArgs);

          let toolResponseText = "";
          if (mcpResult.result && mcpResult.result.content && mcpResult.result.content.length > 0) {
            toolResponseText = mcpResult.result.content[0].text;
          } else if (mcpResult.error) {
            toolResponseText = `Error: ${mcpResult.error.message}`;
          } else {
            toolResponseText = JSON.stringify(mcpResult);
          }

          if (toolResponseText.startsWith('Error')) {
            console.log(`[Erreur Backend] L'outil ${toolCall.function.name} a renvoyé : ${toolResponseText}`);
          }

          // Renvoi de la vraie réponse à l'IA
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: toolResponseText 
          });

        } catch (mcpError) {
          console.error("[Erreur MCP]", mcpError);
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: `Error: ${mcpError.message}`
          });
        }
      }
    }

    await ctx.reply(finalReply);
  } catch (error) {
    console.error("Erreur du bot:", error);
    await ctx.reply("❌ Une erreur est survenue lors de la synchronisation avec ton journal.");
  }
});

// Route Webhook pour Telegram
app.post('/telegram-webhook', async (req, res, next) => {
  try {
    await bot.handleUpdate(req.body);
    if (!res.headersSent) res.sendStatus(200);
  } catch(err) {
    console.error("Erreur Webhook:", err);
    if (!res.headersSent) res.sendStatus(500);
  }
});

app.get('/', (req, res) => res.send('Bot Telegram Sparky avec Agent Autonome Actif !'));

app.listen(PORT, () => console.log(`Microservice Telegram démarré sur le port ${PORT}`));
