const express = require('express');
const { Telegraf, Markup } = require('telegraf');
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
// local clarification round-trip via the ask_user_clarification tool below,
// PLUS real Telegram inline buttons when the LLM supplies short options.
//
// IMPORTANT: we do NOT rely on the LLM always remembering to call that tool.
// In practice a model sometimes just answers a pending question in plain
// text instead of calling the tool (observed in production: it asked
// "quelle taille de banane ?" as plain content, no tool_call). If we only
// persisted history when the tool was explicitly called, that case would
// wipe the conversation and the next reply ("Moyenne") would arrive with
// zero context. So the rule is inverted: ALWAYS persist the conversation
// after a turn, and only clear it once a diary-mutating action has actually
// succeeded (or the turn hard-fails after exhausting retries) — see
// `terminalActionSucceeded` in the agent loop below.
// Keyed by Telegram chat.id. Expires after CONVERSATION_TTL_MS of inactivity
// so a forgotten thread doesn't linger forever (the instance is also
// ephemeral on Cloud Run, so this is best-effort, single-user memory only).
const conversations = new Map(); // chatId -> { messages: [...], updatedAt: number, pendingOptions?: string[] }
const CONVERSATION_TTL_MS = 15 * 60 * 1000; // 15 minutes

function getConversationEntry(chatId) {
  const existing = conversations.get(chatId);
  if (existing && Date.now() - existing.updatedAt < CONVERSATION_TTL_MS) {
    return existing;
  }
  return null;
}

function saveConversation(chatId, messages, pendingOptions) {
  conversations.set(chatId, { messages, updatedAt: Date.now(), pendingOptions });
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

QUAND ET COMMENT DEMANDER UNE CLARIFICATION — RÈGLE ABSOLUE :
- Dès qu'il te manque une information pour logger/modifier/supprimer quelque chose EN TOUTE SÉCURITÉ (taille/portion ambiguë, plusieurs aliments correspondants très différents, plusieurs entrées du journal correspondant au même nom, unité incompatible avec ce que l'utilisateur a donné), tu DOIS appeler l'outil 'ask_user_clarification'. C'est INTERDIT de simplement écrire la question en texte libre sans appeler cet outil, même si le message final ressemble à une question — l'utilisateur ne verra pas de boutons cliquables si tu ne passes pas par l'outil, et cela casse le fil de la conversation.
- Quand il existe un petit nombre de choix clairs (2 à 4), fournis-les TOUJOURS dans le paramètre "options" de l'outil (ex: options: ["Petite (~100g)", "Moyenne (~120g)", "Grosse (~150g)"]) pour qu'ils s'affichent en boutons Telegram. Ne les mets pas seulement dans le texte de la question.
- N'utilise CET outil QUE quand c'est réellement nécessaire. Ne l'utilise PAS pour un détail déductible sans risque (type de repas selon l'heure, date du jour, une seule correspondance claire) : dans ce cas, logue directement, tout de suite, sans demander confirmation.
- Quand tu appelles 'ask_user_clarification', ARRÊTE-TOI : ne logue rien tant que l'utilisateur n'a pas répondu. Sa prochaine réponse (qu'il ait tapé du texte ou appuyé sur un bouton) continuera cette même conversation, avec tout le contexte précédent (y compris l'aliment dont vous parliez).
- Quand l'utilisateur répond à une question précédente (ex: "150g", "grande", ou le clic sur un bouton "Moyenne (~120g)"), convertis sa réponse en argument correct (ex: quantity/unit) et complète l'appel de log avec TOUS les paramètres requis (pas seulement celui qui vient d'être précisé) — ne redemande pas ce que tu sais déjà du contexte.

RÈGLE D'HONNÊTETÉ (ANTI-HALLUCINATION) :
Analyse le retour de chaque outil. Si une erreur revient (ex: MISSING_PARAMS, meal_type invalide, unité/portion non reconnue), lis le message, et si tu peux la corriger seul (ex: reformuler meal_type), corrige et réessaie. Si l'erreur nécessite une info que seul l'utilisateur connaît (ex: taille/portion), utilise 'ask_user_clarification' — n'invente jamais une valeur.
Si l'outil renvoie toujours une erreur après tes tentatives, ARRÊTE-TOI. Ne mens jamais. Dis explicitement à l'utilisateur que l'ajout a échoué et donne la raison renvoyée par le système. Ne confirme un succès que si l'outil a renvoyé un statut de réussite réel.`;

// --- Local (bot-only) clarification tool ---
// This name is never sent to SparkyFitness's MCP endpoint — it is intercepted
// and handled entirely inside the Telegram bot (see the agent loop below).
const ASK_USER_CLARIFICATION = 'ask_user_clarification';

// Actions that represent a diary mutation actually completing. Once one of
// these succeeds, the "task" the user asked for is done, and we reset the
// conversation so the next message starts a fresh, cheap (few-token) turn.
const TERMINAL_FOOD_ACTIONS = new Set(['log_food', 'log_external_food', 'create_food', 'update_entry', 'delete_entry']);

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
      description: "Recherche nutritionnelle (action 'lookup_food_nutrition', cherche dans la base perso incl. Ciqual PUIS la cascade de fournisseurs externes), logue un aliment déjà en base ('log_food'), logue un match externe ('log_external_food'), crée un aliment estimé en dernier recours ('create_food'), ou gère le journal existant ('list_diary', 'delete_entry', 'update_entry'). UN SEUL aliment par appel.",
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
      description: "Pose une question de clarification à l'utilisateur via Telegram AVANT de logger quoi que ce soit, uniquement quand une info nécessaire est réellement ambiguë. OBLIGATOIRE d'utiliser cet outil (jamais une question en texte libre) dès qu'une clarification est nécessaire.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "La question à poser, en français, courte." },
          options: {
            type: "array",
            items: { type: "string" },
            description: "2 à 4 choix courts affichés comme boutons Telegram (ex: ['Petite (~100g)', 'Moyenne (~120g)', 'Grosse (~150g)']). Fournis ce champ dès qu'un petit nombre d'options discrètes existe."
          }
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

// --- Core agent turn ---
// Shared by both the plain-text handler and the inline-button (callback_query)
// handler, so a button tap resumes the exact same conversation/loop as typing
// an answer would. Returns { replyText, options } — options is set only when
// the LLM asked a clarification with discrete choices (renders as buttons).
async function runAgentTurn(chatId, userMessageText) {
  // Resume a paused/ongoing conversation for this chat if one exists,
  // otherwise start fresh. See the comment above `conversations` for why we
  // persist by default rather than only when the ask tool was called.
  const existing = getConversationEntry(chatId);
  let messages;
  if (existing) {
    messages = existing.messages;
    messages.push({ role: "user", content: userMessageText });
  } else {
    messages = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userMessageText }
    ];
  }

  let isDone = false;
  let terminalActionSucceeded = false;
  let pendingOptions;
  let finalReply = "Je n'ai pas réussi à terminer cette action après plusieurs tentatives, peux-tu reformuler ?";

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
         messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: `Error: Invalid JSON arguments format.`
        });
        continue; // Skip execution if arguments are unparseable
      }

      // Local clarification tool: never forwarded to SparkyFitness's MCP.
      // Send the question over Telegram (as buttons if options were given)
      // and pause the whole turn so the user's next message/button tap can
      // resume this exact conversation.
      if (toolCall.function.name === ASK_USER_CLARIFICATION) {
        finalReply = parsedArgs.question || "Peux-tu préciser ?";
        if (Array.isArray(parsedArgs.options) && parsedArgs.options.length > 0) {
          pendingOptions = parsedArgs.options.slice(0, 4).map(String);
        }
        messages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: "Question posée à l'utilisateur. En attente de sa réponse."
        });
        isDone = true;
        break; // Stop processing further tool calls in this turn.
      }

      console.log(`[Agent MCP] Invocation de ${toolCall.function.name}...`);

      try {
        const mcpResult = await callSparkyMCP(toolCall.id, toolCall.function.name, parsedArgs);

        let toolResponseText = "";
        let callFailed = true;

        // The SparkyFitnessServer MCP implementation wraps content in `result.content[0].text`
        // or sets `isError: true` and includes the error string in the text.
        if (mcpResult.result && mcpResult.result.content && mcpResult.result.content.length > 0) {
          toolResponseText = mcpResult.result.content[0].text;
          callFailed = !!mcpResult.result.isError;
          if (callFailed) {
            console.warn(`[Alerte Backend] L'outil ${toolCall.function.name} a renvoyé une erreur logique: ${toolResponseText}`);
          }
        } else if (mcpResult.error) {
          // Handle JSON-RPC level errors
          toolResponseText = `Error: ${mcpResult.error.message}`;
          console.error(`[Erreur RPC] L'outil ${toolCall.function.name} a échoué :`, mcpResult.error);
        } else {
          toolResponseText = JSON.stringify(mcpResult);
        }

        // Track whether a diary mutation genuinely completed, so we know
        // whether to reset the conversation at the end of this turn.
        if (
          !callFailed &&
          toolCall.function.name === 'sparky_manage_food' &&
          TERMINAL_FOOD_ACTIONS.has(parsedArgs.action)
        ) {
          terminalActionSucceeded = true;
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
  // Default is to KEEP the conversation (even a plain, tool-less final reply
  // might be a question the LLM forgot to route through ask_user_clarification —
  // see the big comment above `conversations`). We only wipe it once a diary
  // mutation has actually completed.
  if (terminalActionSucceeded) {
    clearConversation(chatId);
  } else {
    saveConversation(chatId, messages, pendingOptions);
  }

  return { replyText: finalReply, options: pendingOptions };
}

async function sendAgentReply(ctx, chatId, userMessageText) {
  const { replyText, options } = await runAgentTurn(chatId, userMessageText);
  if (options && options.length > 0) {
    await ctx.reply(replyText, Markup.inlineKeyboard(
      options.map((label, idx) => Markup.button.callback(label, `opt:${idx}`))
    ));
  } else {
    await ctx.reply(replyText);
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
    await ctx.sendChatAction('typing');
    await sendAgentReply(ctx, chatId, ctx.message.text);
  } catch (error) {
    console.error("Erreur fatale du bot:", error);
    clearConversation(chatId);
    await ctx.reply("❌ Une erreur technique est survenue lors de la synchronisation avec le cloud SparkyFitness.");
  }
});

// --- Inline button handler ---
// Fires when the user taps one of the buttons rendered from an
// ask_user_clarification call's "options". We resolve the button back to its
// label text and feed it into the SAME agent loop as if the user had typed
// that label, so the LLM sees a normal, contextful answer.
bot.on('callback_query', async (ctx) => {
  const updateId = ctx.update.update_id;
  if (processedUpdates.has(updateId)) return;
  processedUpdates.add(updateId);
  if (processedUpdates.size > 500) {
    processedUpdates.delete(processedUpdates.values().next().value);
  }

  const chatId = ctx.chat.id;
  const data = ctx.callbackQuery.data || "";

  try {
    await ctx.answerCbQuery(); // stop the button's loading spinner

    const entry = getConversationEntry(chatId);
    const match = /^opt:(\d+)$/.exec(data);
    if (!entry || !entry.pendingOptions || !match) {
      await ctx.reply("Cette question n'est plus d'actualité (trop de temps a passé ou une autre action a eu lieu entretemps) — peux-tu reformuler ta demande ?");
      return;
    }
    const chosenLabel = entry.pendingOptions[Number(match[1])];
    if (chosenLabel === undefined) {
      await ctx.reply("Option invalide, peux-tu reformuler ?");
      return;
    }

    // Remove the keyboard from the original question so it can't be tapped twice.
    try { await ctx.editMessageReplyMarkup(undefined); } catch (e) { /* message may be too old to edit; ignore */ }

    await ctx.sendChatAction('typing');
    await sendAgentReply(ctx, chatId, chosenLabel);
  } catch (error) {
    console.error("Erreur fatale du bot (callback_query):", error);
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
