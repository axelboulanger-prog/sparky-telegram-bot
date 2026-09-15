const express = require('express');
const { Telegraf } = require('telegraf');
const OpenAI = require('openai');

const app = express();
app.use(express.json());

// --- Configuration Variables ---
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SPARKY_API_URL = process.env.SPARKY_API_URL; // Ex: https://sparky-api-xxxxx-ew.a.run.app
const SPARKY_API_KEY = process.env.SPARKY_API_KEY;
const PORT = process.env.PORT || 8080;

// --- Telegraf Initialization ---
// webhookReply: false is CRITICAL for Cloud Run. It prevents Telegraf from
// immediately closing the HTTP response, which would terminate the Cloud Run
// instance's CPU allocation before the LLM can finish its work.
const bot = new Telegraf(TELEGRAM_TOKEN, {
  telegram: { webhookReply: false }
});

// --- LLM Initialization ---
// We use the OpenAI SDK to interact with Gemini via the Google API
const openai = new OpenAI({ 
  apiKey: process.env.GEMINI_API_KEY,
  baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/"
});

// --- Idempotency Cache ---
// Telegram can re-send webhooks if it thinks they failed. We cache update IDs
// to avoid processing the same message twice (which would result in duplicate LLM calls/food entries).
const processedUpdates = new Set();

// --- System Prompt ---
// This is the core instruction set for the LLM. It defines its persona, its workflow,
// and CRITICALLY, its anti-hallucination constraints.
const SYSTEM_PROMPT = `Tu es l'assistant nutritionnel personnel de l'utilisateur pour SparkyFitness.
Pour ajouter un aliment, procède strictement dans cet ordre :
1. Utilise 'sparky_manage_favorites' avec l'action 'list_favorites' pour chercher dans les favoris.
2. Si non trouvé, utilise 'sparky_manage_food' avec l'action 'search_food' (paramètre food_name) pour chercher le produit dans la base et récupérer son food_id.
3. Utilise 'sparky_manage_food' avec l'action 'log_food' pour loguer CHAQUE aliment. Un seul aliment est loggué par appel : si l'utilisateur mentionne plusieurs aliments, appelle 'log_food' une fois par aliment, séquentiellement.

Règles CRUCIALES pour sparky_manage_food (action 'log_food') :
- "food_name" (ou "food_id" si tu l'as trouvé via search_food) est OBLIGATOIRE à la racine de l'appel. Il n'y a PAS de tableau "items" : chaque aliment = un appel séparé avec ses propres food_name/quantity/unit.
- Le paramètre racine "meal_type" doit être EXACTEMENT l'une de ces valeurs (en anglais, sans accent) : "breakfast", "lunch", "dinner", "snacks". Toute autre valeur (ex: "collation", "goûter", "snack" au singulier) sera rejetée. Traduis toi-même la demande de l'utilisateur vers l'une de ces 4 valeurs (ex: une collation/un goûter -> "snacks").

RÈGLE D'HONNÊTETÉ (ANTI-HALLUCINATION) :
Analyse le retour de chaque outil. Si un outil renvoie une erreur (ex: MISSING_PARAMS, meal_type invalide), lis le message d'erreur, corrige ton appel et réessaie. 
Si après tes tentatives l'outil renvoie toujours une erreur, tu DOIS ARRÊTER LE PROCESSUS. Ne mens jamais. Dis explicitement à l'utilisateur que l'ajout a échoué et donne-lui la raison renvoyée par le système. Ne confirme un succès que si l'outil a renvoyé un statut de réussite réel.`;

// --- MCP Tool Definitions ---
// These schemas must match the expectations of the SparkyFitnessServer MCP implementation.
// Making properties explicitly `required` forces the LLM to provide them.
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
      name: "sparky_manage_food",
      description: "Recherche un aliment (action 'search_food') ou logue UN SEUL aliment dans le journal (action 'log_food'). Pour plusieurs aliments, appelle cet outil plusieurs fois.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["search_food", "log_food"],
            description: "'search_food' pour chercher un food_id par nom, 'log_food' pour loguer un aliment dans le journal."
          },
          // -- search_food --
          food_name: {
            type: "string",
            description: "Nom de l'aliment. Requis pour 'search_food' ; requis pour 'log_food' si food_id est absent."
          },
          search_type: {
            type: "string",
            enum: ["exact", "broad"],
            description: "Pour 'search_food' : type de recherche (défaut: broad)."
          },
          // -- log_food --
          food_id: {
            type: "string",
            description: "UUID de l'aliment (obtenu via 'search_food'). Alternative à food_name pour 'log_food'."
          },
          quantity: {
            type: "number",
            description: "Quantité consommée (défaut: 1)."
          },
          unit: {
            type: "string",
            description: "Unité (ex: 'g', 'piece', 'serving'). Défaut: unité de la portion de l'aliment."
          },
          meal_type: {
            type: "string",
            enum: ["breakfast", "lunch", "dinner", "snacks"],
            description: "Type de repas cible, requis pour 'log_food'. Valeurs strictes en anglais uniquement."
          },
          entry_date: {
            type: "string",
            description: "Date (YYYY-MM-DD). Omettre pour aujourd'hui."
          }
        },
        required: ["action"]
      }
    }
  }
];

// --- MCP Caller ---
// This function handles the HTTP POST to the SparkyFitnessServer MCP endpoint
// and robustly parses the Server-Sent Events (SSE) response stream.
async function callSparkyMCP(toolCallId, toolName, parsedArguments) {
  // We send a request to the /mcp endpoint. Based on SparkyFitnessServer.ts,
  // this endpoint expects Bearer auth and the mcp-protocol-version header.
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

  // Robust SSE parsing
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
        console.warn("[MCP] Erreur de parsing d'un chunk SSE:", e);
      }
    }
  }

  // Fallback if the response wasn't formatted as strict SSE chunks
  try {
    return JSON.parse(responseText);
  } catch (e) {
    throw new Error(`Aucune réponse JSON-RPC valide trouvée.\nPayload: ${responseText.substring(0, 150)}...`);
  }
}

// --- Telegram Message Handler ---
// This is the core logic loop. It receives a message, passes it to the LLM,
// executes any requested tools, feeds the results back to the LLM, and repeats
// until the LLM provides a final text response.
bot.on('text', async (ctx) => {
  const updateId = ctx.update.update_id;
  if (processedUpdates.has(updateId)) return;
  
  processedUpdates.add(updateId);
  // Keep cache size manageable
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

    // Agent Loop (Max 6 iterations to prevent infinite loops if the LLM gets stuck)
    for (let i = 0; i < 6 && !isDone; i++) {
      const completion = await openai.chat.completions.create({
        model: "gemini-2.5-flash",
        messages: messages,
        tools: tools,
        tool_choice: "auto"
      });

      const responseMessage = completion.choices[0].message;
      messages.push(responseMessage);

      // If there are no tool calls, the LLM has generated its final response.
      if (!responseMessage.tool_calls || responseMessage.tool_calls.length === 0) {
        if (responseMessage.content) finalReply = responseMessage.content;
        isDone = true;
        break;
      }

      // Execute requested tools sequentially (or you could use Promise.all for parallel execution if tools are independent)
      for (const toolCall of responseMessage.tool_calls) {
        let parsedArgs;
        try {
           parsedArgs = JSON.parse(toolCall.function.arguments);
        } catch (e) {
           console.error(`[Agent MCP] Erreur de parsing JSON pour les arguments de l'outil ${toolCall.function.name}:`, e);
           // Feed the JSON parsing error back to the LLM
           messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: `Error: Invalid JSON arguments format.`
          });
          continue; // Skip execution if arguments are unparseable
        }
        
        console.log(`[Agent MCP] Invocation de ${toolCall.function.name}...`);
        
        try {
          const mcpResult = await callSparkyMCP(toolCall.id, toolCall.function.name, parsedArgs);

          let toolResponseText = "";
          
          // The SparkyFitnessServer MCP implementation wraps content in `result.content[0].text`
          // or sets `isError: true` and includes the error string in the text.
          if (mcpResult.result && mcpResult.result.content && mcpResult.result.content.length > 0) {
            toolResponseText = mcpResult.result.content[0].text;
            // The MCP server marks logical failures (like DB constraints or Zod validation) with isError
            if (mcpResult.result.isError) {
              console.warn(`[Alerte Backend] L'outil ${toolCall.function.name} a renvoyé une erreur logique: ${toolResponseText}`);
            }
          } else if (mcpResult.error) {
             // Handle JSON-RPC level errors
            toolResponseText = `Error: ${mcpResult.error.message}`;
            console.error(`[Erreur RPC] L'outil ${toolCall.function.name} a échoué :`, mcpResult.error);
          } else {
            toolResponseText = JSON.stringify(mcpResult);
          }

          // Feed the raw API result (success or error) back to the LLM so it can decide the next step
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: toolResponseText 
          });

        } catch (mcpError) {
          console.error(`[Erreur Réseau/MCP] lors de l'appel à ${toolCall.function.name}:`, mcpError);
          // If the network call failed, tell the LLM so it knows it didn't succeed.
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: `Error: ${mcpError.message}`
          });
        }
      }
    }

    // Send final reply back to Telegram
    await ctx.reply(finalReply);
    
  } catch (error) {
    console.error("Erreur fatale du bot:", error);
    await ctx.reply("❌ Une erreur technique est survenue lors de la synchronisation avec le cloud SparkyFitness.");
  }
});

// --- Webhook Route ---
// Express route that receives updates from Telegram (configured in Cloud Run)
app.post('/telegram-webhook', async (req, res, next) => {
  try {
    await bot.handleUpdate(req.body);
    // Send 200 OK immediately if not already sent. Cloud Run requires a quick response.
    // The webhookReply: false config ensures Telegraf hasn't already sent a response.
    if (!res.headersSent) res.sendStatus(200);
  } catch(err) {
    console.error("Erreur traitement Webhook:", err);
    if (!res.headersSent) res.sendStatus(500);
  }
});

// Health check endpoint
app.get('/', (req, res) => res.send('SparkyFitness Telegram Microservice - Statut: Opérationnel'));

// --- Server Start ---
app.listen(PORT, () => console.log(`[DevOps] Microservice Telegram démarré sur le port ${PORT}`));
