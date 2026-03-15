require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const OpenAI = require('openai');
const tavily = require('tavily');
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.TELEGRAM_TOKEN;
const bot = new TelegramBot(TOKEN, { polling: true });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const tavilyClient = new tavily.TavilyClient({ apiKey: process.env.TAVILY_API_KEY });

const ALLOWED_USERS = [266284115];

const MEMORY_DIR = process.env.RAILWAY_ENVIRONMENT ? '/app/data' : __dirname;
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

RULES:
- Never leave Jarmo stuck — always point forward
- No flattery, no filler, no corporate-speak
- Be real, not harsh — you want him to win
- Challenge lazy thinking
- Short and punchy unless explaining something complex
- Move toward action, not suggestions`;

const SEARCH_PROMPT = `You have been given real web search results below. 
IMPORTANT RULES for using search results:
- Extract and present ACTUAL facts, numbers, names and events from the results
- Do NOT suggest where to look or what to search — the search is already done
- Do NOT say "based on available data" or "you can find this at..." 
- Present the real information directly as if you found it yourself
- Be specific: use actual names, dates, numbers from the results
- Format clearly and concisely for easy reading
- After delivering the info, add your take or next move`;

async function searchWeb(query) {
  try {
    const shortQuery = query.slice(0, 200);
    const response = await tavilyClient.search(shortQuery, {
      searchDepth: 'basic',
      maxResults: 5,
    });
    return response.results
      .map(r => `SOURCE: ${r.title}\nCONTENT: ${r.content}\nURL: ${r.url}`)
      .join('\n\n---\n\n');
  } catch (error) {
    console.error('Search error:', error);
    return null;
  }
}

function needsSearch(text) {
  const searchTriggers = [
    'news', 'today', 'latest', 'current', 'now', 'price', 'weather',
    'who is', 'what is', 'when did', 'how much', 'update', 'recent',
    'happening', 'right now', 'this week', 'this month', 'score',
    'stock', 'crypto', 'market', 'died', 'launched', 'released', 'dubai'
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

  if (text === '/start') {
    bot.sendMessage(chatId, '🤖 Agent Bebe here. What do you need?\n\n/ask <q> - Search all memories\n/recall - Stats\n/clear - Delete all');
    if (!conversations[chatId]) {
      conversations[chatId] = [];
      saveMemories(conversations);
    }
    return;
  }

  if (text === '/recall') {
    const memory = conversations[chatId] || [];
    const userCount = memory.filter(m => m.role === 'user').length;
    bot.sendMessage(chatId, `📊 Total messages: ${memory.length}\n👤 Your messages: ${userCount}`);
    return;
  }

  if (text === '/clear') {
    conversations[chatId] = [];
    saveMemories(conversations);
    bot.sendMessage(chatId, '🗑️ Cleared!');
    return;
  }

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
    if (!conversations[chatId]) conversations[chatId] = [];

    conversations[chatId].push({ role: 'user', content: text });

    saveCounter++;
    if (saveCounter % 5 === 0) {
      saveMemories(conversations);
      console.log('💾 Saved to disk');
    }

    bot.sendChatAction(chatId, 'typing');
    const startTime = Date.now();
    const recentMessages = conversations[chatId].slice(-8);

    let messages;

    if (needsSearch(text)) {
      console.log('🔍 Searching web for:', text.slice(0, 50));
      const searchResults = await searchWeb(text);

      if (searchResults) {
        // Inject search results as a system message + separate user context
        messages = [
          { role: 'system', content: SYSTEM_PROMPT + '\n\n' + SEARCH_PROMPT },
          ...recentMessages.slice(0, -1), // all but last user message
          {
            role: 'user',
            content: `My question: ${text}\n\nHere are the actual search results you must use to answer:\n\n${searchResults}`
          }
        ];
      } else {
        messages = [
          { role: 'system', content: SYSTEM_PROMPT },
          ...recentMessages
        ];
      }
    } else {
      messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...recentMessages
      ];
    }

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages,
      max_tokens: 800,
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