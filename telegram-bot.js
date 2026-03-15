require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.TELEGRAM_TOKEN;
const bot = new TelegramBot(TOKEN, { polling: true });
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const ALLOWED_USERS = [266284115];

// ✅ Railway uses /app/data for persistent storage, locally uses root folder
const MEMORY_DIR = process.env.RAILWAY_ENVIRONMENT
  ? '/app/data'
  : __dirname;
const MEMORY_FILE = path.join(MEMORY_DIR, 'memories.json');

// Make sure memory directory exists
if (!fs.existsSync(MEMORY_DIR)) {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
}

let saveCounter = 0;

// ✅ Agent Bebe - Mentor Mode
const SYSTEM_PROMPT = `You are Agent Bebe - a sharp, direct mentor and idea evaluator.

IDENTITY:
- Your name is Agent Bebe, always. Never call yourself "an AI assistant"
- NEVER use: "How can I assist you", "How can I help you", "How may I help"
- When greeted: "Bebe here. What's on your mind?" or "Ready. Talk to me."
- When asked who you are: "Agent Bebe. What do you need?"
- Remember the user's name and use it naturally

IDEA EVALUATION:
When someone shares an idea, ALWAYS judge it clearly:

If GOOD idea:
- Say it directly: "This is solid." or "Good idea, here's why..."
- Explain what makes it work
- Give concrete next steps or offer to help build it

If BAD idea:
- Say it directly: "This won't work." or "Not there yet, here's why..."
- Explain exactly what's missing or wrong
- Tell them what needs to change to make it viable

WHEN GIVEN FEEDBACK:
1. Take a stance — agree or disagree, and say why
2. Don't deflect — own the reasoning
3. Always propose a fix, not just criticism
4. Focus on how YOU can help fix it
5. Be clear: what you can do NOW vs. what you need from the user
6. Offer 2-3 options with tradeoffs
7. End with: "Which direction?" or "Ready to move forward?"

RULES:
- Never leave someone stuck — always point forward
- No flattery, no filler, no corporate-speak
- Be real, not harsh — you want them to win
- Challenge lazy thinking
- Short and punchy responses unless explaining something complex
- Always end with a next move or question that pushes forward`;

function loadMemories() {
  try {
    if (fs.existsSync(MEMORY_FILE)) {
      return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
    }
  } catch (error) {
    console.error('Error loading memories:', error);
  }
  return {};
}

function saveMemories(memories) {
  try {
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(memories, null, 2));
  } catch (error) {
    console.error('Error saving memories:', error);
  }
}

let conversations = loadMemories();

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text;

  if (!ALLOWED_USERS.includes(userId)) {
    bot.sendMessage(chatId, '❌ Permission denied.');
    return;
  }

  // /start
  if (text === '/start') {
    bot.sendMessage(chatId, '🤖 Agent Bebe here. What do you need?\n\n/ask <q> - Search all memories\n/recall - Stats\n/clear - Delete all');
    if (!conversations[chatId]) {
      conversations[chatId] = [];
      saveMemories(conversations);
    }
    return;
  }

  // /recall
  if (text === '/recall') {
    const memory = conversations[chatId] || [];
    const userCount = memory.filter(m => m.role === 'user').length;
    bot.sendMessage(chatId, `📊 Total messages: ${memory.length}\n👤 Your messages: ${userCount}`);
    return;
  }

  // /clear
  if (text === '/clear') {
    conversations[chatId] = [];
    saveMemories(conversations);
    bot.sendMessage(chatId, '🗑️ Cleared!');
    return;
  }

  // /ask — searches ALL memories
  if (text.startsWith('/ask ')) {
    const question = text.replace('/ask ', '').trim();
    const allMemories = conversations[chatId] || [];

    if (allMemories.length === 0) {
      bot.sendMessage(chatId, '📝 No memories yet!');
      return;
    }

    try {
      bot.sendChatAction(chatId, 'typing');

      const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          ...allMemories,
          { role: 'user', content: question }
        ],
        max_tokens: 300,
      });

      bot.sendMessage(chatId, '🔍 ' + response.choices[0].message.content);
    } catch (error) {
      console.error('Error in /ask:', error);
      bot.sendMessage(chatId, '❌ Error!');
    }
    return;
  }

  // Normal chat — fast, uses last 8 messages
  try {
    if (!conversations[chatId]) {
      conversations[chatId] = [];
    }

    conversations[chatId].push({ role: 'user', content: text });

    // ⚡ Save every 5 messages
    saveCounter++;
    if (saveCounter % 5 === 0) {
      saveMemories(conversations);
      console.log('💾 Saved to disk');
    }

    bot.sendChatAction(chatId, 'typing');
    const startTime = Date.now();

    // Only send last 8 to API (fast ⚡)
    const recentMessages = conversations[chatId].slice(-8);

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ...recentMessages
      ],
      max_tokens: 200,
    });

    const reply = response.choices[0].message.content;
    conversations[chatId].push({ role: 'assistant', content: reply });

    const duration = Date.now() - startTime;
    bot.sendMessage(chatId, reply);
    console.log(`✅ ${duration}ms | 🧠 ${conversations[chatId].length} messages stored`);

  } catch (error) {
    console.error('Error:', error);
    bot.sendMessage(chatId, '❌ Error!');
  }
});

console.log(`🚀 Agent Bebe running on gpt-4o! Memory: ${MEMORY_FILE}`);
bot.on('polling_error', (error) => {
  console.error('Polling error details:', error.code, error.message, error.stack);
});