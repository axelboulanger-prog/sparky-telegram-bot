const express = require('express');
const { Telegraf } = require('telegraf');
const OpenAI = require('openai');

const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SPARKY_API_URL = process.env.SPARKY_API_URL; 
const SPARKY_API_KEY = process.env.SPARKY_API_KEY;
const PORT = process.env.PORT || 8080;

// webhookReply: false maintient le Webhook ouvert pour éviter que Cloud Run ne gèle le CPU
const bot = new Telegraf(TELEGRAM_TOKEN, {
  telegram: { webhookReply: false }
});

const openai = new OpenAI({ 
  apiKey: process.env.GEMINI_API_KEY,
  baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/"
});

const processedUpdates = new Set();

// LE NOUVEAU PROMPT : Oblige Gemini à utiliser le nom exact de l'outil du backend
const SYSTEM_PROMPT = `Tu es l'assistant nutritionnel personnel de l'utilisateur pour SparkyFitness.
Règle stricte de recherche pour ajouter un aliment, tu dois procéder dans cet ordre EXACT :
1. Utilise 'sparky_manage_favorites' avec l'action 'list_favorites' pour vérifier si l'aliment est dans les favoris.
2. Si non trouvé, utilise 'sparky_search_food' pour chercher dans sa base locale.
3. Si toujours non trouvé, utilise 'sparky_search_food' pour chercher dans OpenFoodFacts ou SwissFood.
4. Une fois trouvé, utilise 'sparky_manage_food' pour l'ajouter avec la bonne quantité.
Exécute les recherches silencieusement et logue le repas.`;

// LES BONS OUTILS : Strictement alignés sur les schémas Zod de SparkyFitnessServer
const tools = [
  {
    type: "function",
    function: {
      name: "sparky_manage_favorites", // Le nom exact côté backend
      description: "Gère les favoris de l'utilisateur. Utilise l'action 'list_favorites' pour récupérer la liste des aliments favoris.",
      parameters: { 
        type: "object", 
        properties: {
          action: { type: "string", enum: ["list_favorites", "add_favorite", "remove_favorite"] },
          type: { type: "string", enum: ["food", "meal"] },
          id: { type: "string" }
        }, 
        required: ["action"] 
      }
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
                food_name: { type: "string" }, // snake_case obligatoire
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

// Parseur SSE ultra-robuste adapté à Cloud Run et au Model Context Protocol
async function callSparkyMCP(toolCallId, toolName, parsedArguments) {
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

  // SparkyFitnessServer répond avec un flux d'événements (SSE)
  const lines = responseText.split('\n');
  let currentData = [];

  for (const line of lines) {
    if (line.startsWith('data:')) {
      // On retire "data:" et le premier espace pour nettoyer le JSON
      currentData.push(line.replace(/^data:\s?/, ''));
    } else if (line.trim() === '') {
      // Une ligne vide marque la fin d'un bloc d'événement
      if (currentData.length > 0) {
        const payload = currentData.join('\n');
        try {
          const parsed = JSON.parse(payload);
          // On s'assure de retourner la réponse JSON-RPC
          if (parsed.jsonrpc === "2.0") return parsed;
        } catch (e) {
          // Ignore les erreurs de parse sur les événements partiels
        }
        currentData = []; // Réinitialisation pour le prochain bloc
      }
    }
  }

  // Cas où le backend coupe la connexion sans ligne vide à la fin
  if (currentData.length > 0) {
    const payload = currentData.join('\n');
    try {
      const parsed = JSON.parse(payload);
      if (parsed.jsonrpc === "2.0") return parsed;
    } catch (e) {}
  }

  // Repli si le backend a envoyé un JSON pur (sans SSE)
  try {
    return JSON.parse(responseText);
  } catch (e) {
    throw new Error(`Aucune réponse JSON-RPC trouvée.\nPayload reçu: ${responseText.substring(0, 150)}...`);
  }
}

bot.on('text', async (ctx) => {
  const updateId = ctx.update.update_id;

  // Anti-doublon en mémoire RAM
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

      if (!responseMessage.tool_calls || responseMessage.tool_calls.length === 0) {
        if (responseMessage.content) finalReply = responseMessage.content;
        isDone = true;
        break;
      }

      for (const toolCall of responseMessage.tool_calls) {
        const parsedArgs = JSON.parse(toolCall.function.arguments);
        console.log(`[MCP] Appel de l'outil ${toolCall.function.name}...`);
        
        const mcpResult = await callSparkyMCP(toolCall.id, toolCall.function.name, parsedArgs);

        // Traduction de l'enveloppe complexe de SparkyFitnessServer pour l'IA
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
          content: toolResponseText 
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

app.post('/telegram-webhook', async (req, res, next) => {
  try {
    await bot.handleUpdate(req.body);
    if (!res.headersSent) res.sendStatus(200);
  } catch(err) {
    console.error("Erreur Webhook:", err);
    if (!res.headersSent) res.sendStatus(500);
  }
});

app.get('/', (req, res) => res.send('Bot Telegram Actif (Version Corrigée)'));

app.listen(PORT, () => console.log(`Microservice démarré sur le port ${PORT}`));
