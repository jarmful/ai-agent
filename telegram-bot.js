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
const JARMO_CHAT_ID = 266284115;

const MEMORY_DIR = process.env.RAILWAY_ENVIRONMENT ? '/app/data' : __dirname;
const MEMORY_FILE = path.join(MEMORY_DIR, 'memories.json');
const TODO_FILE = path.join(MEMORY_DIR, 'todos.json');
const PROJECTS_FILE = path.join(MEMORY_DIR, 'projects.json');

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

JARMO'S ACTIVE PROJECTS:
1. WARDROBE APP — A mobile app (iOS/Android) where users manage their wardrobe digitally. Stack: SwiftUI + Supabase. Currently in planning phase. Goal: launch to 100+ users.
2. IMPROVING BEBE — Making Bebe smarter, more autonomous, eventually able to work and build while Jarmo sleeps. Currently adding features like todo list, project tracking, and daily reminders.

PROJECT RULES:
- Always know where these projects stand
- If Jarmo mentions either project, connect it to progress and next steps
- Push him forward — never let a project stall without challenging him
- In daily reminders, always include a project nudge
- If Jarmo seems stuck, suggest the smallest possible next action

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

// ─── PROJECT FUNCTIONS ────────────────────────────────────────────────────────

function loadProjects() {
  try {
    if (fs.existsSync(PROJECTS_FILE)) {
      return JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8'));
    }
  } catch (error) {
    console.error('Error loading projects:', error);
  }
  return {
    wardrobe: {
      name: 'Wardrobe App',
      status: 'Planning phase',
      updates: []
    },
    bebe: {
      name: 'Improving Bebe',
      status: 'Active development',
      updates: []
    }
  };
}

function saveProjects(projects) {
  try {
    fs.writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2));
  } catch (error) {
    console.error('Error saving projects:', error);
  }
}

function formatProjects(projects) {
  let msg = '🗂 *ACTIVE PROJECTS*\n\n';
  for (const key of Object.keys(projects)) {
    const p = projects[key];
    msg += `*${p.name}*\n`;
    msg += `📍 Status: ${p.status}\n`;
    if (p.updates && p.updates.length > 0) {
      const last = p.updates[p.updates.length - 1];
      msg += `🕐 Last update: ${last.text} (${new Date(last.date).toLocaleDateString()})\n`;
    }
    msg += '\n';
  }
  return msg;
}

// ─── TODO FUNCTIONS ───────────────────────────────────────────────────────────

function loadTodos() {
  try {
    if (fs.existsSync(TODO_FILE)) {
      return JSON.parse(fs.readFileSync(TODO_FILE, 'utf8'));
    }
  } catch (error) {
    console.error('Error loading todos:', error);
  }
  return [];
}

function saveTodos(todos) {
  try {
    fs.writeFileSync(TODO_FILE, JSON.stringify(todos, null, 2));
  } catch (error) {
    console.error('Error saving todos:', error);
  }
}

function formatTodoList(todos) {
  const pending = todos.filter(t => !t.done);
  const done = todos.filter(t => t.done);

  if (todos.length === 0) return '📋 No tasks yet. Add one!';

  let msg = '';
  if (pending.length > 0) {
    msg += `📋 *PENDING (${pending.length})*\n`;
    pending.forEach((t, i) => {
      msg += `${i + 1}. ${t.task}\n`;
    });
  }
  if (done.length > 0) {
    msg += `\n✅ *DONE (${done.length})*\n`;
    done.forEach(t => {
      msg += `• ${t.task}\n`;
    });
  }
  return msg;
}

// ─── DAILY REMINDER (9am UTC = 12pm Estonian) ────────────────────────────────

function scheduleDaily() {
  const now = new Date();
  const next = new Date();
  next.setUTCHours(9, 0, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  const delay = next - now;

  setTimeout(async () => {
    await sendDailyReminder();
    setInterval(sendDailyReminder, 24 * 60 * 60 * 1000);
  }, delay);

  console.log(`⏰ Daily reminder scheduled in ${Math.round(delay / 60000)} minutes`);
}

async function sendDailyReminder() {
  try {
    const todos = loadTodos();
    const projects = loadProjects();
    const pending = todos.filter(t => !t.done);

    const taskList = pending.length > 0
      ? pending.map((t, i) => `${i + 1}. ${t.task}`).join('\n')
      : 'No pending tasks.';

    const projectSummary = Object.values(projects)
      .map(p => `${p.name}: ${p.status}`)
      .join('\n');

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: `It's noon in Estonia. Send Jarmo his daily check-in. Be sharp and motivating.

Pending tasks (${pending.length}):
${taskList}

Project status:
${projectSummary}

Keep it punchy. Under 5 sentences intro, then list tasks, then one project nudge.`
        }
      ],
      max_tokens: 300,
    });

    const message = `⚡ *12:00 — Daily Check-in*\n\n${response.choices[0].message.content}`;
    await bot.telegram.sendMessage(JARMO_CHAT_ID, message, { parse_mode: 'Markdown' });
    console.log('⏰ Daily reminder sent');
  } catch (error) {
    console.error('Daily reminder error:', error);
  }
}

// ─── OTHER HELPERS ────────────────────────────────────────────────────────────

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
      .join('\n\n---\n\n');
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

// ─── COMMANDS ─────────────────────────────────────────────────────────────────

bot.command('start', (ctx) => {
  const chatId = ctx.chat.id;
  ctx.reply('🤖 Agent Bebe here. What do you need?\n\n/todo add <task> - Add a task\n/todo done <task> - Mark task done\n/todo list - See all tasks\n/todo clear - Clear completed tasks\n/project list - See all projects\n/project update <name> <progress> - Update project\n/dubai - Daily Dubai briefing\n/evaluate <idea> - Evaluate a business idea\n/ask <q> - Search all memories\n/recall - Stats\n/clear - Delete conversation\n\n📸 Send me an image and I\'ll analyze it.\n\n⏰ Daily reminder at 12:00 Estonian time.');
  if (!conversations[chatId]) {
    conversations[chatId] = [];
    saveMemories(conversations);
  }
});

bot.command('project', async (ctx) => {
  const userId = ctx.from.id;

  if (!ALLOWED_USERS.includes(userId)) {
    ctx.reply('❌ Permission denied.');
    return;
  }

  const args = ctx.message.text.replace('/project', '').trim();
  const projects = loadProjects();

  // LIST
  if (!args || args === 'list') {
    ctx.reply(formatProjects(projects), { parse_mode: 'Markdown' });
    return;
  }

  // UPDATE — /project update wardrobe <progress text>
  if (args.toLowerCase().startsWith('update ')) {
    const rest = args.slice(7).trim();
    const spaceIdx = rest.indexOf(' ');

    if (spaceIdx === -1) {
      ctx.reply('Usage: /project update <wardrobe|bebe> <what you did>');
      return;
    }

    const projectKey = rest.slice(0, spaceIdx).toLowerCase();
    const progressText = rest.slice(spaceIdx + 1).trim();

    if (!projects[projectKey]) {
      ctx.reply(`❌ Unknown project "${projectKey}". Use: wardrobe or bebe`);
      return;
    }

    projects[projectKey].status = progressText;
    projects[projectKey].updates.push({
      text: progressText,
      date: new Date().toISOString()
    });
    saveProjects(projects);

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Jarmo just updated his "${projects[projectKey].name}" project with: "${progressText}". Acknowledge it in 1-2 sharp sentences and suggest the next logical step.`
        }
      ],
      max_tokens: 100,
    });

    ctx.reply(`📍 *${projects[projectKey].name}* updated!\n\n${response.choices[0].message.content}`, { parse_mode: 'Markdown' });
    return;
  }

  ctx.reply('Commands:\n/project list\n/project update <wardrobe|bebe> <progress>');
});

bot.command('todo', async (ctx) => {
  const userId = ctx.from.id;

  if (!ALLOWED_USERS.includes(userId)) {
    ctx.reply('❌ Permission denied.');
    return;
  }

  const args = ctx.message.text.replace('/todo', '').trim();
  const todos = loadTodos();

  if (!args || args === 'list') {
    ctx.reply(formatTodoList(todos), { parse_mode: 'Markdown' });
    return;
  }

  if (args === 'clear') {
    const remaining = todos.filter(t => !t.done);
    const cleared = todos.length - remaining.length;
    saveTodos(remaining);
    ctx.reply(`🗑️ Cleared ${cleared} completed tasks. ${remaining.length} pending.`);
    return;
  }

  if (args.toLowerCase().startsWith('add ')) {
    const task = args.slice(4).trim();
    if (!task) {
      ctx.reply('Usage: /todo add <task>');
      return;
    }
    todos.push({ task, done: false, added: new Date().toISOString() });
    saveTodos(todos);
    const pending = todos.filter(t => !t.done).length;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Jarmo just added a task: "${task}". Acknowledge in one sharp sentence. Total pending: ${pending}.` }
      ],
      max_tokens: 60,
    });
    ctx.reply(`✅ Added: ${task}\n\n${response.choices[0].message.content}`);
    return;
  }

  if (args.toLowerCase().startsWith('done ')) {
    const search = args.slice(5).trim().toLowerCase();
    const idx = todos.findIndex(t => !t.done && t.task.toLowerCase().includes(search));

    if (idx === -1) {
      ctx.reply(`❌ Can't find that task. Use /todo list to see your tasks.`);
      return;
    }

    todos[idx].done = true;
    todos[idx].completedAt = new Date().toISOString();
    saveTodos(todos);
    const pending = todos.filter(t => !t.done).length;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Jarmo completed: "${todos[idx].task}". Congratulate in one punchy sentence. ${pending} tasks still pending.` }
      ],
      max_tokens: 60,
    });
    ctx.reply(`✅ Done: ${todos[idx].task}\n\n${response.choices[0].message.content}`);
    return;
  }

  ctx.reply('Commands:\n/todo list\n/todo add <task>\n/todo done <task>\n/todo clear');
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
  ctx.reply('🔍 Researching your idea...');

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
  ctx.reply('🔍 Searching Dubai news...');

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
  const todos = loadTodos();
  const pending = todos.filter(t => !t.done).length;
  const done = todos.filter(t => t.done).length;
  ctx.reply(`📊 Conversation: ${memory.length} messages\n👤 Your messages: ${userCount}\n📋 Tasks pending: ${pending}\n✅ Tasks done: ${done}`);
});

bot.command('clear', (ctx) => {
  const chatId = ctx.chat.id;
  conversations[chatId] = [];
  saveMemories(conversations);
  ctx.reply('🗑️ Conversation cleared!');
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

// ─── NATURAL LANGUAGE TODO DETECTION ─────────────────────────────────────────

function detectTodoIntent(text) {
  const lower = text.toLowerCase();
  const addTriggers = ['add to my list', 'add to list', 'remind me to', 'i need to', 'put on my list', 'add task', 'to do:', 'todo:'];
  const doneTriggers = ['i did', 'i finished', 'i completed', 'done with', 'finished with', 'completed'];
  const listTriggers = ['show my list', 'my tasks', 'what do i have', 'show tasks', 'my to do', 'my todo'];

  if (addTriggers.some(t => lower.includes(t))) return 'add';
  if (doneTriggers.some(t => lower.includes(t))) return 'done';
  if (listTriggers.some(t => lower.includes(t))) return 'list';
  return null;
}

// ─── HANDLERS ─────────────────────────────────────────────────────────────────

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

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
            { type: 'text', text: caption + replyContext },
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

  // Natural language todo detection
  const todoIntent = detectTodoIntent(text);
  if (todoIntent === 'list') {
    const todos = loadTodos();
    ctx.reply(formatTodoList(todos), { parse_mode: 'Markdown' });
    return;
  }

  if (todoIntent === 'add' || todoIntent === 'done') {
    try {
      await ctx.sendChatAction('typing');
      const todos = loadTodos();

      const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'user',
            content: `Extract the task from this message and return ONLY a JSON object with "action" (add or done) and "task" (the task text, clean and short).
Message: "${text}"
Example output: {"action":"add","task":"call John"}`
          }
        ],
        max_tokens: 60,
      });

      const parsed = JSON.parse(response.choices[0].message.content.trim());

      if (parsed.action === 'add') {
        todos.push({ task: parsed.task, done: false, added: new Date().toISOString() });
        saveTodos(todos);
        const pending = todos.filter(t => !t.done).length;
        ctx.reply(`✅ Got it. Added "${parsed.task}" to your list.\n📋 You now have ${pending} pending tasks.`);
      } else if (parsed.action === 'done') {
        const idx = todos.findIndex(t => !t.done && t.task.toLowerCase().includes(parsed.task.toLowerCase()));
        if (idx !== -1) {
          todos[idx].done = true;
          todos[idx].completedAt = new Date().toISOString();
          saveTodos(todos);
          const pending = todos.filter(t => !t.done).length;
          ctx.reply(`✅ Marked done: "${todos[idx].task}"\n📋 ${pending} tasks still pending.`);
        } else {
          ctx.reply(`❌ Could not find that task. Use /todo list to see your tasks.`);
        }
      }
      return;
    } catch (e) {
      // fall through to normal chat
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

    let messages;

    if (needsSearch(text)) {
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
        messages = [{ role: 'system', content: SYSTEM_PROMPT }, ...recentMessages];
      }
    } else {
      messages = [{ role: 'system', content: SYSTEM_PROMPT }, ...recentMessages];
    }

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages,
      max_tokens: 1000,
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

// ─── LAUNCH ───────────────────────────────────────────────────────────────────

bot.launch();
scheduleDaily();
console.log(`🚀 Agent Bebe running! Memory: ${MEMORY_FILE} | Todos: ${TODO_FILE} | Projects: ${PROJECTS_FILE}`);

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));