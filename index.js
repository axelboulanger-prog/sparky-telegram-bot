const express = require('express');
const { Telegraf } = require('telegraf');
const OpenAI = require('openai');

const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SPARKY_API_URL = process.env.SPARKY_API_URL; 
const SPARKY_API_KEY = process.env.SPARKY_API_KEY;
const PORT = process.env.PORT || 8080;

const bot = new Telegraf(TELEGRAM_TOKEN);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Définition de l'outil basé sur tes schémas Zod (sans charger tout le contexte)
const tools = [{
  type: "function",
  function: {
    name: "sparky_manage_food",
    description: "Ajoute ou gère une entrée de nourriture dans le journal de l'utilisateur.",
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
}];

bot.on('text', async (ctx) => {
  try {
    const userMessage = ctx.message.text;
    await ctx.sendChatAction('typing');

    // 1. LLM allégé pour structurer le JSON
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: `Logue ceci dans mon journal : ${userMessage}` }],
      tools: tools,
      tool_choice: { type: "function", function: { name: "sparky_manage_food" } }
    });

    const toolCall = completion.choices[0].message.tool_calls[0];
    const parsedArguments = JSON.parse(toolCall.function.arguments);

    // 2. Envoi direct au backend (Cloud Run API Principale) via MCP
    const mcpResponse = await fetch(`${SPARKY_API_URL}/api/mcp`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SPARKY_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "sparky_manage_food",
          arguments: parsedArguments
        }
      })
    });

    if (!mcpResponse.ok) {
      throw new Error(`Erreur API: ${mcpResponse.statusText}`);
    }

    ctx.reply(`✅ Repas ajouté avec succès dans SparkyFitness !`);
  } catch (error) {
    console.error("Erreur:", error);
    ctx.reply("❌ Une erreur est survenue lors de l'ajout.");
  }
});

// Endpoint pour le Webhook Telegram
const webhookPath = `/telegraf/${bot.secretPathComponent()}`;
app.post(webhookPath, (req, res, next) => {
  bot.handleUpdate(req.body, res).then(() => {
    if (!res.headersSent) res.sendStatus(200);
  }).catch(next);
});

// Route de santé (Healthcheck pour Cloud Run)
app.get('/', (req, res) => res.send('Bot Telegram Actif !'));

app.listen(PORT, () => {
  console.log(`Microservice bot démarré sur le port ${PORT}`);
});
