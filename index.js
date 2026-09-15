const express = require('express');
const { Telegraf } = require('telegraf');
const OpenAI = require('openai');
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { SSEClientTransport } = require("@modelcontextprotocol/sdk/client/sse.js");

const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SPARKY_API_URL = process.env.SPARKY_API_URL; 
const SPARKY_API_KEY = process.env.SPARKY_API_KEY;
const PORT = process.env.PORT || 8080;

// Désactivation de la réponse webhook automatique pour empêcher Cloud Run de geler le CPU
const bot = new Telegraf(TELEGRAM_TOKEN, {
  telegram: { webhookReply: false }
});

const openai = new OpenAI({ 
  apiKey: process.env.GEMINI_API_KEY,
  baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/"
});

const SYSTEM_PROMPT = `Tu es l'assistant nutritionnel personnel de l'utilisateur pour SparkyFitness.
Règle stricte de recherche pour ajouter un aliment, tu dois procéder dans cet ordre EXACT :
1. Utilise 'sparky_get_favorite_foods' pour vérifier si l'aliment est dans les favoris de l'utilisateur.
2. Si non trouvé, utilise 'sparky_search_food' pour chercher dans sa base locale (qui contient l'import Ciqual).
3. Si toujours non trouvé, utilise 'sparky_search_food' pour chercher spécifiquement dans OpenFoodFacts ou SwissFood.
4. Une fois le bon aliment trouvé, utilise 'sparky_manage_food' pour l'ajouter avec la bonne quantité.
Ne pose pas de questions, exécute les recherches silencieusement et logue le repas.`;

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
                foodName: { type: "string" },
                quantity: { type: "number" },
                unit: { type: "string" }
              },
              required: ["foodName", "quantity"]
            }
          }
        },
        required: ["action", "items"]
      }
    }
  }
];

// Configuration du client MCP
let mcpClient = null;

async function initMCPClient() {
  if (mcpClient) return mcpClient;

  // L'endpoint MCP de SparkyFitness est monté sur /mcp.
  // Note: Si le serveur utilise StreamableHTTPServerTransport sur la racine, 
  // l'URL SSE standard est souvent /sse ou la racine elle-même.
  const sseUrl = new URL(`${SPARKY_API_URL}/mcp`);

  const transport = new SSEClientTransport(sseUrl, {
    headers: {
      'Authorization': `Bearer ${SPARKY_API_KEY}`
    }
  });

  const client = new Client(
    { name: "sparky-telegram-bot", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  try {
    await client.connect(transport);
    console.log("Connecté au serveur MCP SparkyFitness");
    mcpClient = client;
    return client;
  } catch (error) {
    console.error("Échec de la connexion initiale au serveur MCP:", error);
    throw error;
  }
}

async function callSparkyMCP(toolName, parsedArguments) {
  try {
    const client = await initMCPClient();
    const result = await client.callTool({
      name: toolName,
      arguments: parsedArguments
    });
    return result;
  } catch (error) {
    console.error(`Erreur d'appel outil MCP [${toolName}]:`, error);
    // En cas d'erreur de connexion, on réinitialise le client pour la prochaine tentative
    mcpClient = null; 
    throw error;
  }
}

bot.on('text', async (ctx) => {
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
        
        // On utilise la nouvelle fonction callSparkyMCP qui gère le client MCP
        const mcpResult = await callSparkyMCP(toolCall.function.name, parsedArgs);

        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          // Le SDK renvoie un objet avec une propriété 'content'
          content: JSON.stringify(mcpResult.content || mcpResult)
        });

        if (toolCall.function.name === "sparky_manage_food") {
          isDone = true;
        }
      }
    }

    ctx.reply(finalReply);
  } catch (error) {
    console.error("Erreur du bot:", error);
    ctx.reply("❌ Une erreur est survenue lors de la synchronisation avec SparkyFitness.");
  }
});

const webhookPath = '/telegram-webhook';
app.post(webhookPath, (req, res, next) => {
  bot.handleUpdate(req.body, res).then(() => {
    if (!res.headersSent) res.sendStatus(200);
  }).catch(next);
});

app.get('/', (req, res) => res.send('Bot Telegram Sparky avec Gemini Actif !'));

app.listen(PORT, () => console.log(`Microservice démarré sur le port ${PORT}`));
