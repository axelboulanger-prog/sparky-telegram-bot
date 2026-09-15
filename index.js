const express = require('express');
const { Telegraf } = require('telegraf');
const OpenAI = require('openai');

const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SPARKY_API_URL = process.env.SPARKY_API_URL; 
const SPARKY_API_KEY = process.env.SPARKY_API_KEY;
const PORT = process.env.PORT || 8080;

// webhookReply: false force Telegraf à ne pas fermer la requête prématurément.
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
                food_name: { type: "string" }, // Clé en snake_case obligatoire
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

// Appel Stateless ultra-optimisé avec lecture de flux (SSE) multi-lignes
async function callSparkyMCP(toolCallId, toolName, parsedArguments) {
  const abortController = new AbortController();

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
    }),
    signal: abortController.signal
  });

  if (!mcpResponse.ok) {
    const errText = await mcpResponse.text();
    throw new Error(`Erreur MCP HTTP ${mcpResponse.status}: ${errText}`);
  }

  // Lecture manuelle du flux Server-Sent Events
  const reader = mcpResponse.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() || ''; // Garde le dernier morceau incomplet

      for (const block of blocks) {
        // Découpe le bloc en lignes pour ignorer "event: message" et cibler "data:"
        const lines = block.split('\n');
        for (const line of lines) {
          if (line.startsWith('data:')) {
            const dataStr = line.slice(5).trim();
            try {
              const parsed = JSON.parse(dataStr);
              // Dès qu'on reçoit la réponse de notre outil, on coupe la connexion !
              if (parsed.id === toolCallId) {
                abortController.abort(); // Tue la connexion pour libérer Cloud Run
                return parsed;
              }
            } catch (e) {
              // Ignore les erreurs de parsing sur les événements partiels
            }
          }
        }
      }
    }
  } catch (err) {
    // Une erreur "AbortError" est normale et voulue ici
    if (err.name !== 'AbortError') {
      throw err;
    }
  } finally {
    reader.releaseLock();
  }
  
  throw new Error("Aucune réponse JSON-RPC trouvée dans le flux SSE");
}

bot.on('text', async (ctx) => {
  const updateId = ctx.update.update_id;

  if (processedUpdates.has(updateId)) {
    return; // Ignore les retries de Telegram
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

app.post('/telegram-webhook', async (req, res, next) => {
  try {
    // Le await bloque Express pour empêcher Cloud Run de geler le CPU en mode gratuit
    await bot.handleUpdate(req.body);
    if (!res.headersSent) res.sendStatus(200);
  } catch(err) {
    console.error("Erreur Webhook:", err);
    if (!res.headersSent) res.sendStatus(500);
  }
});

app.get('/', (req, res) => res.send('Bot Telegram Sparky actif avec Stream SSE Abort !'));

app.listen(PORT, () => console.log(`Microservice Telegram démarré sur le port ${PORT}`));
