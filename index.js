const express = require('express');
const { Telegraf } = require('telegraf');
const OpenAI = require('openai');

const app = express();
app.use(express.json());

// Variables d'environnement (à configurer sur Google Cloud Run)
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SPARKY_API_URL = process.env.SPARKY_API_URL; // Ex: https://sparky-api-xxxxx-ew.a.run.app (SANS slash à la fin)
const SPARKY_API_KEY = process.env.SPARKY_API_KEY;
const PORT = process.env.PORT || 8080;

// Configuration Telegraf optimisée pour Cloud Run
// webhookReply: false empêche Telegraf de fermer la requête HTTP prématurément
const bot = new Telegraf(TELEGRAM_TOKEN, {
  telegram: { webhookReply: false }
});

// Initialisation de Gemini via la compatibilité OpenAI SDK
const openai = new OpenAI({ 
  apiKey: process.env.GEMINI_API_KEY,
  baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/"
});

// Cache d'idempotence pour éviter de traiter 2x les webhooks dupliqués de Telegram
const processedUpdates = new Set();

const SYSTEM_PROMPT = `Tu es l'assistant nutritionnel personnel de l'utilisateur pour SparkyFitness.
Pour ajouter un aliment, procède strictement dans cet ordre :
1. Utilise 'sparky_manage_favorites' avec l'action 'list_favorites' pour chercher dans les favoris.
2. Si non trouvé, utilise 'sparky_search_food' pour chercher le produit dans la base.
3. Utilise 'sparky_manage_food' pour loguer le repas. L'action est généralement 'log_food'.

Règle CRUCIALE pour sparky_manage_food : 
Tu DOIS renseigner le paramètre racine "meal_type" (valeurs acceptées : collation, breakfast, lunch, dinner, snack). Déduis-le de la demande de l'utilisateur ou du moment de la journée.

IMPORTANT : Analyse le retour des outils. Si un outil renvoie une "Error", lis attentivement les champs attendus manquants ou invalides, corrige tes paramètres, et relance l'outil de manière autonome. Confirme à l'utilisateur uniquement quand l'ajout a réussi.`;

// Schémas des outils MCP 
const tools = [
  {
    type: "function",
    function: {
      name: "sparky_manage_favorites",
      description: "Gère les favoris de l'utilisateur. Utilise l'action 'list_favorites' pour récupérer la liste.",
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
      description: "Ajoute l'aliment final dans le journal. Assure-toi d'inclure le meal_type à la racine et le food_id dans les items.",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", description: "L'action à effectuer (ex: log_food)" },
          meal_type: { type: "string", description: "Le type de repas cible (ex: collation, breakfast, lunch, dinner)" }, // <-- PLACÉ À LA RACINE POUR NEON/ZOD
          entry_date: { type: "string", description: "Date (YYYY-MM-DD). Utiliser 'today' si c'est pour aujourd'hui." },
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                food_id: { type: "string" },
                food_name: { type: "string" },
                quantity: { type: "number" },
                unit: { type: "string" }
              }
            }
          }
        },
        required: ["action", "meal_type", "items"] // <-- REQUIS PAR LE BACKEND
      }
    }
  }
];

// Extracteur SSE (Server-Sent Events) adapté à ton architecture Cloud Run -> API Principal
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

  // Traitement robuste du flux SSE
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
      } catch (e) {
        // Continue if parsing single chunk fails
      }
    }
  }

  try {
    return JSON.parse(responseText);
  } catch (e) {
    throw new Error(`Aucune réponse JSON-RPC valide trouvée.\nPayload: ${responseText.substring(0, 150)}...`);
  }
}

// Handler Principal Telegram
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

    // Boucle de l'Agent Autonome (limite de sécurité : 6 itérations max)
    for (let i = 0; i < 6 && !isDone; i++) {
      const completion = await openai.chat.completions.create({
        model: "gemini-2.5-flash",
        messages: messages,
        tools: tools,
        tool_choice: "auto"
      });

      const responseMessage = completion.choices[0].message;
      messages.push(responseMessage);

      // Si l'IA n'appelle aucun outil, le raisonnement est fini
      if (!responseMessage.tool_calls || responseMessage.tool_calls.length === 0) {
        if (responseMessage.content) finalReply = responseMessage.content;
        isDone = true;
        break;
      }

      // Exécution des outils requis par l'IA
      for (const toolCall of responseMessage.tool_calls) {
        const parsedArgs = JSON.parse(toolCall.function.arguments);
        console.log(`[Agent MCP] Invocation de ${toolCall.function.name}...`);
        
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
            console.warn(`[Alerte Backend] L'outil ${toolCall.function.name} a échoué : ${toolResponseText}`);
          }

          // On nourrit l'IA avec le résultat brut de l'API (succès ou erreur Zod)
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: toolResponseText 
          });

        } catch (mcpError) {
          console.error(`[Erreur Réseau/MCP]`, mcpError);
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: `Error: ${mcpError.message}`
          });
        }
      }
    }

    // Réponse finale renvoyée sur Telegram
    await ctx.reply(finalReply);
  } catch (error) {
    console.error("Erreur fatale du bot:", error);
    await ctx.reply("❌ Une erreur technique est survenue lors de la synchronisation avec le cloud SparkyFitness.");
  }
});

// Route d'ingestion Webhook pour Cloud Run
app.post('/telegram-webhook', async (req, res, next) => {
  try {
    await bot.handleUpdate(req.body);
    if (!res.headersSent) res.sendStatus(200);
  } catch(err) {
    console.error("Erreur traitement Webhook:", err);
    if (!res.headersSent) res.sendStatus(500);
  }
});

app.get('/', (req, res) => res.send('SparkyFitness Telegram Microservice - Statut: Opérationnel'));

app.listen(PORT, () => console.log(`[DevOps] Microservice Telegram démarré sur le port ${PORT}`));
