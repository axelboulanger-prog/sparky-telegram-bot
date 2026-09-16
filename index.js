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

// --- Per-chat conversation memory ---
// SparkyFitness's own 'sparky_ask_user' clarification tool is NOT exposed over
// MCP (an MCP client has no chip UI to render it), so we implement our own
// local clarification round-trip: when the LLM needs to ask something
// ("quelle taille de banane ?"), we send the question over Telegram and PAUSE
// the turn instead of finishing it. The conversation (including the pending
// tool call/result) is kept here so the user's next message resumes it
// instead of starting a brand new, context-less request.
// Keyed by Telegram chat.id. Expires after CONVERSATION_TTL_MS of inactivity
// so a forgotten question doesn't linger forever (the instance is also
// ephemeral on Cloud Run, so this is best-effort, single-user memory only).
const conversations = new Map(); // chatId -> { messages: [...], updatedAt: number }
const CONVERSATION_TTL_MS = 15 * 60 * 1000; // 15 minutes

function getConversation(chatId) {
  const existing = conversations.get(chatId);
  if (existing && Date.now() - existing.updatedAt < CONVERSATION_TTL_MS) {
    return existing.messages;
  }
  return null;
}

function saveConversation(chatId, messages) {
  conversations.set(chatId, { messages, updatedAt: Date.now() });
}

function clearConversation(chatId) {
  conversations.delete(chatId);
}

// --- System Prompt ---
// Mirrors SparkyFitnessServer's own prompts/chatbot-full-food.md workflow,
// adapted for a client (Telegram/MCP) that has no sparky_ask_user chip UI.
const SYSTEM_PROMPT = `Tu es l'assistant nutritionnel personnel de l'utilisateur pour SparkyFitness.

RECHERCHE ET LOGGING D'UN ALIMENT — ORDRE OBLIGATOIRE :
1. 'sparky_manage_favorites' action 'list_favorites' : vérifie d'abord si l'aliment est dans les favoris (raccourci rapide).
2. OBLIGATOIRE ensuite (sauf si trouvé en favori) : 'sparky_manage_food' action 'lookup_food_nutrition' avec food_name. Ce seul appel cherche déjà, dans l'ordre : ta base perso (y compris tes aliments importés depuis Ciqual), puis la cascade de fournisseurs externes connectés (OpenFoodFacts, base suisse, etc.). Ne saute JAMAIS cette étape, même si tu "connais" les calories d'un aliment courant.
3. Selon le résultat du lookup :
   - Source "internal" (trouvé dans la base perso, y compris Ciqual) -> logue avec 'log_food' en utilisant le food_id retourné.
   - Source externe (openfoodfacts, usda, swiss...) -> logue avec 'log_external_food' (food_name + external_id + provider_type du résultat). Ne mets JAMAIS l'External ID dans food_id.
   - Aucun résultat trouvé du tout -> seulement dans ce cas, 'create_food' avec des valeurs nutritionnelles estimées le plus précisément possible (jamais 0 par défaut), en incluant meal_type et quantity/unit pour logger directement.
4. "meal_type" doit être EXACTEMENT l'une de ces valeurs (anglais, sans accent) : "breakfast", "lunch", "dinner", "snacks". Traduis toi-même (une collation/un goûter -> "snacks").
5. Un seul aliment par appel de log (pas de tableau "items") : plusieurs aliments = plusieurs appels séquentiels.

CORRIGER OU SUPPRIMER UNE ENTRÉE DÉJÀ LOGUÉE :
- "supprime la banane" -> 'sparky_manage_food' action 'delete_entry' avec food_name (et entry_date si ce n'est pas aujourd'hui). Si l'outil renvoie plusieurs entrées correspondantes (même aliment dans plusieurs repas), utilise 'ask_user_clarification' pour demander lequel, ou précise meal_type si le contexte le permet clairement.
- "déplace ça au dîner" / "c'était en fait 150g pas 100g" -> 'sparky_manage_food' action 'update_entry' avec food_name (+ entry_date si besoin) et le(s) champ(s) à changer (meal_type et/ou quantity/unit).
- "qu'est-ce que j'ai mangé aujourd'hui/récemment ?" -> 'sparky_manage_food' action 'list_diary' (entry_date) pour un jour donné, ou 'sparky_get_recent_food_entries' pour les derniers aliments loggués tous jours confondus (utile aussi pour retrouver un aliment déjà utilisé et le relogger).
- Si l'utilisateur ne précise pas clairement DE QUOI il parle ("supprime ça" sans contexte), demande une clarification plutôt que de deviner.

QUAND DEMANDER UNE CLARIFICATION (outil 'ask_user_clarification') :
- Le lookup renvoie plusieurs résultats vraiment différents (ex: poulet grillé vs pané) -> pose la question avec les vrais choix trouvés.
- L'utilisateur donne un compte ("2 bananes", "3 tranches") mais l'aliment trouvé n'a que des unités en grammes/ml -> demande un poids par unité réaliste (ex: options "environ 100g", "environ 150g").
- N'utilise CET outil QUE dans ces cas. Ne l'utilise PAS pour un détail déductible sans risque (type de repas selon l'heure, date du jour, une seule correspondance claire) : dans ce cas, logue directement, tout de suite, sans demander confirmation.
- Quand tu appelles 'ask_user_clarification', ARRÊTE-TOI : ne logue rien tant que l'utilisateur n'a pas répondu. Sa prochaine réponse continuera cette même conversation.
- Si l'utilisateur répond à une question précédente (ex: "150g" ou "grande"), convertis sa réponse en argument correct (ex: quantity/unit) et complète l'appel de log avec TOUS les paramètres requis (pas seulement celui qui vient d'être précisé).

RÈGLE D'HONNÊTETÉ (ANTI-HALLUCINATION) :
Analyse le retour de chaque outil. Si une erreur revient (ex: MISSING_PARAMS, meal_type invalide), lis le message, corrige ton appel et réessaie.
Si l'outil renvoie toujours une erreur après tes tentatives, ARRÊTE-TOI. Ne mens jamais. Dis explicitement à l'utilisateur que l'ajout a échoué et donne la raison renvoyée par le système. Ne confirme un succès que si l'outil a renvoyé un statut de réussite réel.`;

// --- Local (bot-only) clarification tool ---
// This name is never sent to SparkyFitness's MCP endpoint — it is intercepted
// and handled entirely inside the Telegram bot (see the agent loop below).
const ASK_USER_CLARIFICATION = 'ask_user_clarification';

// --- MCP Tool Definitions ---
// sparky_manage_food's schema mirrors SparkyFitnessServer's
// ai/tools/schemas/food.ts (manageFoodInput) — only the fields relevant to
// searching/logging a single food are published here to keep the schema
// small for a 3B/flash-class model.
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
      description: "Recherche nutritionnelle (action 'lookup_food_nutrition', cherche dans la base perso incl. Ciqual PUIS la cascade de fournisseurs externes), logue un aliment déjà en base ('log_food'), logue un match externe ('log_external_food'), ou crée un aliment estimé en dernier recours ('create_food'). UN SEUL aliment par appel.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["lookup_food_nutrition", "log_food", "log_external_food", "create_food", "list_diary", "delete_entry", "update_entry"]
          },
          food_name: {
            type: "string",
            description: "Nom de l'aliment. Requis pour lookup_food_nutrition/create_food/log_external_food ; requis pour log_food si food_id est absent ; pour delete_entry/update_entry, alternative à entry_id (résolu contre le journal de entry_date)."
          },
          entry_id: {
            type: "string",
            description: "UUID de l'entrée du journal. Pour delete_entry/update_entry, alternative à food_name. Le tool te renvoie les candidats si food_name est ambigu (plusieurs entrées du même aliment)."
          },
          entry_type: {
            type: "string",
            enum: ["food_entry", "food_entry_meal"],
            description: "Pour delete_entry/update_entry : type d'entrée (défaut: food_entry)."
          },
          provider_type: {
            type: "string",
            description: "Optionnel : forcer un fournisseur précis (ex: openfoodfacts) pour lookup_food_nutrition/log_external_food."
          },
          food_id: {
            type: "string",
            description: "UUID de l'aliment interne (obtenu via lookup_food_nutrition, source 'internal'). Pour log_food uniquement."
          },
          external_id: {
            type: "string",
            description: "External ID retourné par lookup_food_nutrition pour un match externe. Pour log_external_food uniquement — jamais dans food_id."
          },
          quantity: {
            type: "number",
            description: "Quantité consommée (défaut: 1)."
          },
          unit: {
            type: "string",
            description: "Unité (ex: 'g', 'piece', 'serving'). Vérifie les unités disponibles renvoyées par le lookup."
          },
          meal_type: {
            type: "string",
            enum: ["breakfast", "lunch", "dinner", "snacks"],
            description: "Type de repas. Requis pour logger. Pour update_entry : NOUVEAU repas cible (ex: déplacer vers 'dinner'). Pour delete_entry : filtre si le même aliment apparaît dans plusieurs repas. Valeurs strictes en anglais uniquement."
          },
          entry_date: {
            type: "string",
            description: "Date (YYYY-MM-DD). Omettre pour aujourd'hui. Pour list_diary : jour à afficher. Pour delete_entry/update_entry : jour du journal où résoudre food_name (pas la nouvelle date)."
          },
          calories: { type: "number", description: "Requis pour create_food (kcal)." },
          protein: { type: "number", description: "Requis pour create_food (g)." },
          carbs: { type: "number", description: "Requis pour create_food (g)." },
          fat: { type: "number", description: "Requis pour create_food (g)." },
          fiber: { type: "number", description: "Optionnel pour create_food (g)." },
          sugar: { type: "number", description: "Optionnel pour create_food (g)." },
          sodium: { type: "number", description: "Optionnel pour create_food (mg)." }
        },
        required: ["action"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "sparky_get_recent_food_entries",
      description: "Liste les aliments récemment loggués par l'utilisateur, tous repas/jours confondus, du plus récent au plus ancien. Utile pour \"relogue comme hier\", \"qu'est-ce que j'ai mangé récemment ?\", ou pour retrouver un food_id déjà utilisé.",
      parameters: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Nombre d'entrées à retourner (défaut: 10)."
          }
        },
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: ASK_USER_CLARIFICATION,
      description: "Pose une question de clarification à l'utilisateur via Telegram AVANT de logger quoi que ce soit, uniquement quand une info nécessaire est réellement ambiguë. N'utilise JAMAIS cet outil pour un détail déductible sans risque.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "La question à poser, en français, avec les options si pertinent (ex: 'Quelle taille de banane ? (petite ~100g / moyenne ~120g / grosse ~150g)')." }
        },
        required: ["question"]
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
// This is the core logic loop. It receives a message, passes it (plus any
// pending conversation history) to the LLM, executes any requested tools,
// feeds the results back to the LLM, and repeats until the LLM provides a
// final text response OR asks the user a clarifying question.
bot.on('text', async (ctx) => {
  const updateId = ctx.update.update_id;
  if (processedUpdates.has(updateId)) return;

  processedUpdates.add(updateId);
  // Keep cache size manageable
  if (processedUpdates.size > 500) {
    processedUpdates.delete(processedUpdates.values().next().value);
  }

  const chatId = ctx.chat.id;

  try {
    const userMessage = ctx.message.text;
    await ctx.sendChatAction('typing');

    // Resume a paused conversation (awaiting an answer to a clarification
    // question) if one exists for this chat, otherwise start fresh.
    let messages = getConversation(chatId);
    if (messages) {
      messages.push({ role: "user", content: userMessage });
    } else {
      messages = [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMessage }
      ];
    }

    let isDone = false;
    let awaitingAnswer = false;
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

        // Local clarification tool: never forwarded to SparkyFitness's MCP.
        // Send the question over Telegram and pause the whole turn so the
        // user's next message can resume this exact conversation.
        if (toolCall.function.name === ASK_USER_CLARIFICATION) {
          finalReply = parsedArgs.question || "Peux-tu préciser ?";
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: "Question posée à l'utilisateur. En attente de sa réponse."
          });
          isDone = true;
          awaitingAnswer = true;
          break; // Stop processing further tool calls in this turn.
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

    // Persist or clear conversation state depending on how the turn ended.
    if (awaitingAnswer) {
      saveConversation(chatId, messages); // keep context for the follow-up answer
    } else {
      clearConversation(chatId); // action completed (or gave up) — start fresh next time
    }

    // Send final reply back to Telegram
    await ctx.reply(finalReply);

  } catch (error) {
    console.error("Erreur fatale du bot:", error);
    clearConversation(chatId);
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
