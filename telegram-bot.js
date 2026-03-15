require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const OpenAI = require('openai');
const { tavily } = require('@tavily/core');
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.TELEGRAM_TOKEN;
const bot = new TelegramBot(TOKEN, { polling: true });
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});
const tavilyClient = tavily({ apiKey: process.env.TAVILY_API_KEY });

const ALLOWED_USERS = [266284115];

const MEMORY_DIR = process.env.RAILWAY_ENVIRONMENT
  ? '/app/data'
  : __dirname;
const MEMORY_FILE = path.join(MEMORY_DIR, 'memories.json');

if (!fs.existsSync(MEMORY_DIR)) {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
}

let saveCounter = 0;

const SYSTEM_PROMPT = `You are Agent Bebe - Jarmo's sharp, direct thinking partner.

IDENTITY:
- Your name is Agent Bebe, always. Never call yourself "an AI assistant"
- NEVER use: "How can I assist you", "How can I help you", "How may I help"
- When greeted: "Bebe here. What's on your mind?" or "Ready. Talk to me."
- When asked who you are: "Agent Bebe. What do you need?"
- Always remember Jarmo's name and context from previous messages
- You work FOR Jarmo, not with him on his homework

IDEA EVALUATION:
When Jarmo shares an idea, ALWAYS judge it clearly:

If GOOD idea:
- Say it directly: "This is solid." or "Good idea, here's why..."
- Explain what makes it work
- Give concrete next steps or offer to help build it

If BAD idea:
- Say it directly: "This won't work." or "Not there yet, here's why..."
- Explain exactly what's missing or wrong
- Tell him what needs to change to make it viable

WHEN GIVEN FEEDBACK:
1. Take a real stance — agree or disagree, with why
2. Say what YOU will do, not what Jarmo should do
3. Be specific: "I need X from you to make Y happen"
4. Offer 2-3 clear options with tradeoffs
5. End with: "Which direction?" or "Ready to move forward?"

WEB SEARCH:
- You have access to real-time web search
- Use it automatically when Jarmo asks about news, current events, prices, people, or anything that needs up-to-date info
- Lead with the actual answer from search results, not suggestions on where to look
- Cite what you found and when it's from
- Be direct: give the information, then your take on it

RULES:
- Never leave Jarmo stuck — always point forward
- No flattery, no filler, no corporate-speak
- Be real, not harsh — you want him to win
- Challenge lazy thinking
- Short and punchy unless explaining something complex
- Move toward action, not suggestions`;

// Search function
async function searchWeb(query) {
  try {
    const response = await tavilyClient.search(query, {
      searchDepth: 'basic',
      maxResults: 5,
    });
    return response.results.map(r => `${r.title}: ${r.content} (${r.url})`).join('\n\n');
  } catch (error) {
    console.error('Search error:', error);
    return null;
  }
}

// Detect if message needs web search
function needsSearch(text) {
  const searchTriggers = [
    'news', 'today', 'latest', 'current', 'now', 'price', 'weather',
    'who is', 'what is', 'when did', 'how much', 'update', 'recent',
    'happening', 'right now', 'this week', 'this month', 'score',
    'stock', 'crypto', 'market', 'died', 'launched', 'released'
  ];
  const lower = text.toLowerCase();
  return searchTriggers.some(trigger => lower.includes(trigger));
}

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

  // Normal chat
  try {
    if (!conversations[chatId]) {
      conversations[chatId] = [];
    }

    conversations[chatId].push({ role: 'user', content: text });

    saveCounter++;
    if (saveCounter % 5 === 0) {
      saveMemories(conversations);
      console.log('💾 Saved to disk');
    }

    bot.sendChatAction(chatId, 'typing');
    const startTime = Date.now();

    const recentMessages = conversations[chatId].slice(-8);

    // Add web search context if needed
    let systemPrompt = SYSTEM_PROMPT;
    if (needsSearch(text)) {
      console.log('🔍 Searching web for:', text);
      const searchResults = await searchWeb(text);
      if (searchResults) {
        systemPrompt += `\n\nCURRENT WEB SEARCH RESULTS FOR "${text}":\n${searchResults}\n\nUse these results to give Jarmo a direct, informed answer.`;
      }
    }

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        ...recentMessages
      ],
      max_tokens: 500,
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