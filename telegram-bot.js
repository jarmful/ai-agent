require('dotenv').config();
const { Telegraf } = require('telegraf');
const OpenAI = require('openai');
const tavily = require('tavily');
const fs = require('fs');
const path = require('path');
const https = require('https');

const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const tavilyClient = new tavily.TavilyClient({ apiKey: process.env.TAVILY_API_KEY });

const ALLOWED_USERS = [266284115];

const MEMORY_DIR = process.env.RAILWAY_ENVIRONMENT ? '/app/data' : __dirname;
const MEMORY_FILE = path.join(MEMORY_DIR, 'memories.json');

if (!fs.existsSync(MEMORY_DIR)) {
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
}

let saveCounter = 0;

const SYSTEM_PROMPT = `You are Agent Bebe - Jarmo's sharp, direct thinking partner and builder.

IDENTITY:

- Your name is Agent Bebe, always. Never call yourself "an AI assistant"
- NEVER use: "How can I assist you", "How can I help you", "How may I help"
- When greeted: "Bebe here. What's on your mind?" or "Ready. Talk to me."
- When asked who you are: "Agent Bebe. What do you need?"
- Always remember Jarmo's name and context from previous messages
- You work FOR Jarmo, not with him on his homework

BUILDING & CODING:
When Jarmo asks you to build, create, code, or make something:

- DO IT. Write the actual code immediately. No excuses, no "you should hire someone"
- Deliver complete, working code — not snippets, not pseudocode
- Use the best tech for the job (Node.js, Python, HTML/CSS/JS, etc.)
- After the code, add a one-line explanation of how to run it
- If you need clarification, ask ONE question only, then build
- Never say "I can't build that" — you can always write the code

IDEA EVALUATION:
When Jarmo shares an idea, ALWAYS judge it clearly:

If GOOD idea:

- Say it directly: "This is solid." or "Good idea, here's why…"
- Explain what makes it work
- Give concrete next steps or offer to help build it

If BAD idea:

- Say it directly: "This won't work." or "Not there yet, here's why…"
- Explain exactly what's missing or wrong
- Tell him what needs to change to make it viable

WHEN GIVEN FEEDBACK:

1. Take a real stance — agree or disagree, with why
1. Say what YOU will do, not what Jarmo should do
1. Be specific: "I need X from you to make Y happen"
1. Offer 2-3 clear options with tradeoffs
1. End with: "Which direction?" or "Ready to move forward?"

RULES:

- Never leave Jarmo stuck — always point forward
- No flattery, no filler, no corporate-speak
- Be real, not harsh — you want him to win
- Challenge lazy thinking
- Short and punchy unless explaining something complex
- Move toward action, not suggestions
- When in doubt: build first, refine after`;

const SEARCH_PROMPT = `You have been given real web search results below.
IMPORTANT RULES for using search results:

- Extract and present ACTUAL facts, numbers, names and events from the results
- Do NOT suggest where to look or what to search — the search is already done
- Do NOT say "based on available data" or "you can find this at…"
- Present the real information directly as if you found it yourself
- Be specific: use actual names, dates, numbers from the results
- Format clearly and concisely for easy reading
- After delivering the info, add your take or next move
- If results are from 2024 or older, mention that and note they may not be the latest
- IGNORE any results about regional conflicts, military activity, or geopolitical tensions — focus only on business, finance, crypto, and positive developments`;

const DUBAI_PROMPT = `You are compiling a daily Dubai business briefing for Jarmo.
Format it exactly like this:

📍 DUBAI DAILY — [Today's Date]

Then provide exactly 10 items covering:

- Real estate developments
- Business & investment news
- Infrastructure & transport
- Tourism & hospitality
- Tech & innovation
- Economic milestones

Rules:

- Each item must have a bold headline and 1-2 sentence summary
- Use ONLY facts from the search results — no generic statements
- Include specific names, companies, numbers, dates
- Skip anything about regional conflict or geopolitical tensions
- End with: "🎯 Top opportunity today: [one actionable insight for Jarmo]"`;

async function downloadImageAsBase64(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve(buffer.toString('base64'));
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

async function searchWeb(query) {
  try {
    const shortQuery = query.slice(0, 200);
    const response = await tavilyClient.search(shortQuery, {
      searchDepth: 'advanced',
      maxResults: 7,
    });
    if (!response.results || response.results.length === 0) return null;
    return response.results
      .map(r => `SOURCE: ${r.title}\nCONTENT: ${r.content}\nURL: ${r.url}`)
      .join('\n\n—\n\n');
  } catch (error) {
    console.error('Search error:', error);
    return null;
  }
}

async function generateSearchQueries(text) {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: `Analyze this request and return a JSON array of objects. Each object has "query" (5-8 words, year 2026, business/finance focused) and "topic" (one of: crypto, stocks, dubai, general).
Return ONLY a JSON array, nothing else. Max 3 objects.

Request: "${text.slice(0, 300)}"

Example output: [{"query":"Dubai business investment growth 2026","topic":"dubai"},{"query":"UAE cryptocurrency regulation adoption 2026","topic":"crypto"},{"query":"DFM ADX stock market performance 2026","topic":"stocks"}]`
        }
      ],
      max_tokens: 150,
    });
    const content = response.choices[0].message.content.trim();
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : [{ query: text.slice(0, 100), topic: 'general' }];
  } catch (error) {
    console.error('Query generation error:', error);
    return [{ query: text.slice(0, 100), topic: 'general' }];
  }
}

function needsBuild(text) {
  const buildTriggers = [
    'build', 'create', 'make me', 'make a', 'write code', 'write a script',
    'write a bot', 'code this', 'code it', 'develop', 'program', 'implement',
    'generate code', 'write me', 'can you make', 'can you build', 'can you create'
  ];
  const lower = text.toLowerCase();
  return buildTriggers.some(trigger => lower.includes(trigger));
}

function needsSearch(text) {
  const searchTriggers = [
    'news', 'today', 'latest', 'current', 'now', 'price', 'weather',
    'who is', 'what is', 'when did', 'how much', 'update', 'recent',
    'happening', 'right now', 'this week', 'this month', 'score',
    'stock', 'crypto', 'market', 'died', 'launched', 'released', 'dubai',
    'uae', 'tell me about', 'what happened', 'kpi', 'analysis'
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

bot.command('start', (ctx) => {
  const chatId = ctx.chat.id;
  ctx.reply('🤖 Agent Bebe here. What do you need?\n\n/dubai - Daily Dubai briefing\n/evaluate <idea> - Evaluate a business idea\n/ask <q> - Search all memories\n/recall - Stats\n/clear - Delete all\n\n📸 Send me an image and I\'ll analyze it.');
  if (!conversations[chatId]) {
    conversations[chatId] = [];
    saveMemories(conversations);
  }
});

bot.command('evaluate', async (ctx) => {
  const chatId = ctx.chat.id;
  const userId = ctx.from.id;
  const idea = ctx.message.text.replace('/evaluate', '').trim();

  if (!ALLOWED_USERS.includes(userId)) {
    ctx.reply('❌ Permission denied.');
    return;
  }

  if (!idea) {
    ctx.reply('💡 Give me an idea to evaluate.\n\nExample: /evaluate a Dubai dog walking app');
    return;
  }

  await ctx.sendChatAction('typing');
  ctx.reply('🔍 Researching your idea…');

  try {
    const [r1, r2, r3] = await Promise.all([
      searchWeb(`${idea} market size revenue opportunity 2026`),
      searchWeb(`${idea} competition existing players 2026`),
      searchWeb(`${idea} Dubai UAE demand trends 2026`),
    ]);

    const combined = [r1, r2, r3].filter(Boolean).join('\n\n===\n\n');

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Evaluate this business idea for Jarmo and Linda: "${idea}"

Here is real market research data:
${combined}

Format your response exactly like this:

💡 IDEA: [restate the idea clearly]

📊 MARKET SIZE: [real numbers from research]

⚔️ COMPETITION: [who's already doing it, how crowded]

✅ VERDICT: [VIABLE / NOT VIABLE / NEEDS TWIST] — one bold sentence why

💰 MONEY POTENTIAL: [realistic revenue estimate in year 1]

🎯 FIRST MOVE: [the single most important action to take this week]

Be direct. Use real data. No fluff.`
        }
      ],
      max_tokens: 800,
    });

    const reply = response.choices[0].message.content;

    if (!conversations[chatId]) conversations[chatId] = [];
    conversations[chatId].push({ role: 'user', content: `Evaluate this business idea: "${idea}"` });
    conversations[chatId].push({ role: 'assistant', content: reply });
    saveMemories(conversations);

    ctx.reply(reply);
    console.log(`💡 Idea evaluated: ${idea}`);

  } catch (error) {
    console.error('Evaluate error:', error);
    ctx.reply('❌ Error evaluating idea. Try again.');
  }
});

bot.command('dubai', async (ctx) => {
  const chatId = ctx.chat.id;
  const userId = ctx.from.id;

  if (!ALLOWED_USERS.includes(userId)) {
    ctx.reply('❌ Permission denied.');
    return;
  }

  await ctx.sendChatAction('typing');
  ctx.reply('🔍 Searching Dubai news…');

  try {
    const today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

    const [r1, r2, r3, r4] = await Promise.all([
      searchWeb(`Dubai business investment real estate news ${today}`),
      searchWeb(`Dubai infrastructure tourism tech innovation ${today}`),
      searchWeb(`Dubai economic growth milestones ${today}`),
      searchWeb(`Dubai UAE resilience stability amid regional conflict ${today}`),
    ]);

    const combinedResults = [r1, r2, r3, r4].filter(Boolean).join('\n\n===\n\n');

    if (!combinedResults) {
      ctx.reply('❌ Could not fetch Dubai news right now. Try again in a minute.');
      return;
    }

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: DUBAI_PROMPT },
        {
          role: 'user',
          content: `Today is ${today}. Here are the search results:\n\n${combinedResults}\n\nCompile the Dubai daily briefing now.`
        }
      ],
      max_tokens: 1500,
    });

    ctx.reply(response.choices[0].message.content);
    console.log(`📍 Dubai briefing delivered`);

  } catch (error) {
    console.error('Dubai command error:', error);
    ctx.reply('❌ Error fetching Dubai news.');
  }
});

bot.command('recall', (ctx) => {
  const chatId = ctx.chat.id;
  const memory = conversations[chatId] || [];
  const userCount = memory.filter(m => m.role === 'user').length;
  ctx.reply(`📊 Total messages: ${memory.length}\n👤 Your messages: ${userCount}`);
});

bot.command('clear', (ctx) => {
  const chatId = ctx.chat.id;
  conversations[chatId] = [];
  saveMemories(conversations);
  ctx.reply('🗑️ Cleared!');
});

bot.command('ask', async (ctx) => {
  const chatId = ctx.chat.id;
  const question = ctx.message.text.replace('/ask', '').trim();
  if (!question) {
    ctx.reply('Usage: /ask <your question>');
    return;
  }
  const allMemories = conversations[chatId] || [];
  if (allMemories.length === 0) {
    ctx.reply('📝 No memories yet!');
    return;
  }
  try {
    await ctx.sendChatAction('typing');
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        ...allMemories,
        { role: 'user', content: question }
      ],
      max_tokens: 300,
    });
    ctx.reply('🔍 ' + response.choices[0].message.content);
  } catch (error) {
    console.error('Error in /ask:', error);
    ctx.reply('❌ Error!');
  }
});

bot.on('photo', async (ctx) => {
  const userId = ctx.from.id;
  const chatId = ctx.chat.id;

  if (!ALLOWED_USERS.includes(userId)) {
    ctx.reply('❌ Permission denied.');
    return;
  }

  try {
    await ctx.sendChatAction('typing');

    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const caption = ctx.message.caption || 'What do you see in this image? Give me your direct take.';

    let replyContext = '';
    if (ctx.message.reply_to_message) {
      const replied = ctx.message.reply_to_message;
      if (replied.text) {
        replyContext = `\n\n[Jarmo is replying to this message: "${replied.text}"]`;
      } else if (replied.caption) {
        replyContext = `\n\n[Jarmo is replying to a message with caption: "${replied.caption}"]`;
      }
    }

    const fileLink = await ctx.telegram.getFileLink(photo.file_id);
    const imageBase64 = await downloadImageAsBase64(fileLink.href);

    console.log('📸 Processing image...');

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: {
                url: `data:image/jpeg;base64,${imageBase64}`,
              },
            },
            {
              type: 'text',
              text: caption + replyContext,
            },
          ],
        },
      ],
      max_tokens: 1000,
    });

    const reply = response.choices[0].message.content;

    if (!conversations[chatId]) conversations[chatId] = [];
    conversations[chatId].push({ role: 'user', content: `[Sent an image] ${caption}${replyContext}` });
    conversations[chatId].push({ role: 'assistant', content: reply });

    ctx.reply(reply);
    console.log('📸 Image analyzed');

  } catch (error) {
    console.error('Image error:', error);
    ctx.reply('❌ Could not process image.');
  }
});

bot.on('text', async (ctx) => {
  const chatId = ctx.chat.id;
  const userId = ctx.from.id;
  let text = ctx.message.text;

  if (!ALLOWED_USERS.includes(userId)) {
    ctx.reply('❌ Permission denied.');
    return;
  }

  if (ctx.message.reply_to_message) {
    const replied = ctx.message.reply_to_message;
    if (replied.text) {
      text = `[Replying to: "${replied.text}"]\n\n${text}`;
    } else if (replied.caption) {
      text = `[Replying to message with caption: "${replied.caption}"]\n\n${text}`;
    } else if (replied.photo) {
      text = `[Replying to an image]\n\n${text}`;
    }
  }

  try {
    if (!conversations[chatId]) conversations[chatId] = [];

    conversations[chatId].push({ role: 'user', content: text });

    saveCounter++;
    if (saveCounter % 5 === 0) {
      saveMemories(conversations);
      console.log('💾 Saved to disk');
    }

    await ctx.sendChatAction('typing');
    const startTime = Date.now();
    const recentMessages = conversations[chatId].slice(-8);
    const isBuild = needsBuild(text);

    let messages;
    let maxTokens = isBuild ? 4000 : 1000;

    if (needsSearch(text) && !isBuild) {
      const queries = await generateSearchQueries(text);
      console.log('🔍 Search queries:', JSON.stringify(queries));

      const searchPromises = queries.map(q => searchWeb(q.query || q));
      const searchResultsArr = await Promise.all(searchPromises);

      const combinedResults = queries
        .map((q, i) => searchResultsArr[i] ? `=== SEARCH: "${q.query || q}" ===\n${searchResultsArr[i]}` : null)
        .filter(Boolean)
        .join('\n\n');

      if (combinedResults) {
        messages = [
          { role: 'system', content: SYSTEM_PROMPT + '\n\n' + SEARCH_PROMPT },
          ...recentMessages.slice(0, -1),
          {
            role: 'user',
            content: `My request: ${text}\n\nHere are the actual search results you must use to answer:\n\n${combinedResults}`
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
      max_tokens: maxTokens,
    });

    const reply = response.choices[0].message.content;
    conversations[chatId].push({ role: 'assistant', content: reply });

    const duration = Date.now() - startTime;
    ctx.reply(reply);
    console.log(`✅ ${duration}ms | 🧠 ${conversations[chatId].length} messages stored`);

  } catch (error) {
    console.error('Error:', error);
    ctx.reply('❌ Error!');
  }
});

bot.launch();
console.log(`🚀 Agent Bebe running on gpt-4o! Memory: ${MEMORY_FILE}`);

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
