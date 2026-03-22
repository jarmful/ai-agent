require('dotenv').config();
const { Telegraf } = require('telegraf');
const OpenAI = require('openai');
const tavily = require('tavily');
const https = require('https');
const { Pool } = require('pg');

const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const tavilyClient = new tavily.TavilyClient({ apiKey: process.env.TAVILY_API_KEY });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const ALLOWED_USERS = [266284115];
const JARMO_CHAT_ID = 266284115;

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

// ─── DATABASE FUNCTIONS ───────────────────────────────────────────────────────

async function getTodos() {
  const res = await pool.query('SELECT * FROM todos ORDER BY added ASC');
  return res.rows;
}

async function addTodo(task) {
  await pool.query('INSERT INTO todos (task, done) VALUES ($1, false)', [task]);
}

async function markTodoDone(id) {
  await pool.query('UPDATE todos SET done = true, completed_at = NOW() WHERE id = $1', [id]);
}

async function clearDoneTodos() {
  const res = await pool.query('DELETE FROM todos WHERE done = true');
  return res.rowCount;
}

async function getConversation(chatId) {
  const res = await pool.query(
    'SELECT role, content FROM conversations WHERE chat_id = $1 ORDER BY created_at ASC',
    [String(chatId)]
  );
  return res.rows;
}

async function addMessage(chatId, role, content) {
  await pool.query(
    'INSERT INTO conversations (chat_id, role, content) VALUES ($1, $2, $3)',
    [String(chatId), role, content]
  );
}

async function clearConversation(chatId) {
  await pool.query('DELETE FROM conversations WHERE chat_id = $1', [String(chatId)]);
}

async function getProjects() {
  const projects = await pool.query('SELECT * FROM projects ORDER BY id ASC');
  const updates = await pool.query('SELECT * FROM project_updates ORDER BY created_at DESC');

  const result = {};
  for (const p of projects.rows) {
    const lastUpdate = updates.rows.find(u => u.project_key === p.key);
    result[p.key] = {
      name: p.name,
      status: p.status,
      lastUpdate: lastUpdate ? lastUpdate.text : null,
      lastUpdateDate: lastUpdate ? lastUpdate.created_at : null
    };
  }
  return result;
}

async function updateProject(key, status) {
  await pool.query(
    'UPDATE projects SET status = $1, updated_at = NOW() WHERE key = $2',
    [status, key]
  );
  await pool.query(
    'INSERT INTO project_updates (project_key, text) VALUES ($1, $2)',
    [key, status]
  );
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

function formatProjects(projects) {
  let msg = '🗂 *ACTIVE PROJECTS*\n\n';
  for (const key of Object.keys(projects)) {
    const p = projects[key];
    msg += `*${p.name}*\n`;
    msg += `📍 Status: ${p.status}\n`;
    if (p.lastUpdate) {
      msg += `🕐 Last update: ${p.lastUpdate}\n`;
    }
    msg += '\n';
  }
  return msg;
}

// ─── DAILY REMINDER ───────────────────────────────────────────────────────────

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
    const todos = await getTodos();
    const projects = await getProjects();
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

// ─── COMMANDS ─────────────────────────────────────────────────────────────────

bot.command('start', async (ctx) => {
  const chatId = ctx.chat.id;
  ctx.reply('🤖 Agent Bebe here. What do you need?\n\n/todo add <task> - Add a task\n/todo done <task> - Mark task done\n/todo list - See all tasks\n/todo clear - Clear completed tasks\n/project list - See all projects\n/project update <n> <progress> - Update project\n/dubai - Daily Dubai briefing\n/evaluate <idea> - Evaluate a business idea\n/ask <q> - Search all memories\n/recall - Stats\n/clear - Delete conversation\n\n📸 Send me an image and I\'ll analyze it.\n\n⏰ Daily reminder at 12:00 Estonian time.');
});

bot.command('todo', async (ctx) => {
  const userId = ctx.from.id;
  if (!ALLOWED_USERS.includes(userId)) { ctx.reply('❌ Permission denied.'); return; }

  const args = ctx.message.text.replace('/todo', '').trim();

  if (!args || args === 'list') {
    const todos = await getTodos();
    ctx.reply(formatTodoList(todos), { parse_mode: 'Markdown' });
    return;
  }

  if (args === 'clear') {
    const cleared = await clearDoneTodos();
    const todos = await getTodos();
    ctx.reply(`🗑️ Cleared ${cleared} completed tasks. ${todos.length} pending.`);
    return;
  }

  if (args.toLowerCase().startsWith('add ')) {
    const task = args.slice(4).trim();
    if (!task) { ctx.reply('Usage: /todo add <task>'); return; }
    await addTodo(task);
    const todos = await getTodos();
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
    const todos = await getTodos();
    const todo = todos.find(t => !t.done && t.task.toLowerCase().includes(search));

    if (!todo) { ctx.reply(`❌ Can't find that task. Use /todo list to see your tasks.`); return; }

    await markTodoDone(todo.id);
    const remaining = todos.filter(t => !t.done && t.id !== todo.id).length;

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Jarmo completed: "${todo.task}". Congratulate in one punchy sentence. ${remaining} tasks still pending.` }
      ],
      max_tokens: 60,
    });
    ctx.reply(`✅ Done: ${todo.task}\n\n${response.choices[0].message.content}`);
    return;
  }

  ctx.reply('Commands:\n/todo list\n/todo add <task>\n/todo done <task>\n/todo clear');
});

bot.command('project', async (ctx) => {
  const userId = ctx.from.id;
  if (!ALLOWED_USERS.includes(userId)) { ctx.reply('❌ Permission denied.'); return; }

  const args = ctx.message.text.replace('/project', '').trim();

  if (!args || args === 'list') {
    const projects = await getProjects();
    ctx.reply(formatProjects(projects), { parse_mode: 'Markdown' });
    return;
  }

  if (args.toLowerCase().startsWith('update ')) {
    const rest = args.slice(7).trim();
    const spaceIdx = rest.indexOf(' ');
    if (spaceIdx === -1) { ctx.reply('Usage: /project update <wardrobe|bebe> <what you did>'); return; }

    const projectKey = rest.slice(0, spaceIdx).toLowerCase();
    const progressText = rest.slice(spaceIdx + 1).trim();

    const projects = await getProjects();
    if (!projects[projectKey]) { ctx.reply(`❌ Unknown project "${projectKey}". Use: wardrobe or bebe`); return; }

    await updateProject(projectKey, progressText);

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Jarmo just updated his "${projects[projectKey].name}" project with: "${progressText}". Acknowledge in 1-2 sharp sentences and suggest the next logical step.` }
      ],
      max_tokens: 100,
    });

    ctx.reply(`📍 *${projects[projectKey].name}* updated!\n\n${response.choices[0].message.content}`, { parse_mode: 'Markdown' });
    return;
  }

  ctx.reply('Commands:\n/project list\n/project update <wardrobe|bebe> <progress>');
});

bot.command('evaluate', async (ctx) => {
  const chatId = ctx.chat.id;
  const userId = ctx.from.id;
  const idea = ctx.message.text.replace('/evaluate', '').trim();

  if (!ALLOWED_USERS.includes(userId)) { ctx.reply('❌ Permission denied.'); return; }
  if (!idea) { ctx.reply('💡 Example: /evaluate a Dubai dog walking app'); return; }

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
    await addMessage(chatId, 'user', `Evaluate this business idea: "${idea}"`);
    await addMessage(chatId, 'assistant', reply);
    ctx.reply(reply);

  } catch (error) {
    console.error('Evaluate error:', error);
    ctx.reply('❌ Error evaluating idea. Try again.');
  }
});

bot.command('dubai', async (ctx) => {
  const userId = ctx.from.id;
  if (!ALLOWED_USERS.includes(userId)) { ctx.reply('❌ Permission denied.'); return; }

  await ctx.sendChatAction('typing');
  ctx.reply('🔍 Searching Dubai news...');

  try {
    const today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

    const [r1, r2, r3, r4] = await Promise.all([
      searchWeb(`Dubai business investment real estate news ${today}`),
      searchWeb(`Dubai infrastructure tourism tech innovation ${today}`),
      searchWeb(`Dubai economic growth milestones ${today}`),
      searchWeb(`Dubai UAE resilience stability ${today}`),
    ]);

    const combinedResults = [r1, r2, r3, r4].filter(Boolean).join('\n\n===\n\n');
    if (!combinedResults) { ctx.reply('❌ Could not fetch Dubai news right now.'); return; }

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: DUBAI_PROMPT },
        { role: 'user', content: `Today is ${today}. Here are the search results:\n\n${combinedResults}\n\nCompile the Dubai daily briefing now.` }
      ],
      max_tokens: 1500,
    });

    ctx.reply(response.choices[0].message.content);
  } catch (error) {
    console.error('Dubai command error:', error);
    ctx.reply('❌ Error fetching Dubai news.');
  }
});

bot.command('recall', async (ctx) => {
  const chatId = ctx.chat.id;
  const conversation = await getConversation(chatId);
  const userCount = conversation.filter(m => m.role === 'user').length;
  const todos = await getTodos();
  const pending = todos.filter(t => !t.done).length;
  const done = todos.filter(t => t.done).length;
  ctx.reply(`📊 Conversation: ${conversation.length} messages\n👤 Your messages: ${userCount}\n📋 Tasks pending: ${pending}\n✅ Tasks done: ${done}`);
});

bot.command('clear', async (ctx) => {
  await clearConversation(ctx.chat.id);
  ctx.reply('🗑️ Conversation cleared!');
});

bot.command('ask', async (ctx) => {
  const chatId = ctx.chat.id;
  const question = ctx.message.text.replace('/ask', '').trim();
  if (!question) { ctx.reply('Usage: /ask <your question>'); return; }

  const allMemories = await getConversation(chatId);
  if (allMemories.length === 0) { ctx.reply('📝 No memories yet!'); return; }

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
    ctx.reply('❌ Error!');
  }
});

// ─── NATURAL LANGUAGE TODO ────────────────────────────────────────────────────

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
  if (!ALLOWED_USERS.includes(userId)) { ctx.reply('❌ Permission denied.'); return; }

  try {
    await ctx.sendChatAction('typing');
    const photo = ctx.message.photo[ctx.message.photo.length - 1];
    const caption = ctx.message.caption || 'What do you see in this image? Give me your direct take.';

    let replyContext = '';
    if (ctx.message.reply_to_message?.text) {
      replyContext = `\n\n[Jarmo is replying to: "${ctx.message.reply_to_message.text}"]`;
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
    await addMessage(chatId, 'user', `[Sent an image] ${caption}${replyContext}`);
    await addMessage(chatId, 'assistant', reply);
    ctx.reply(reply);

  } catch (error) {
    console.error('Image error:', error);
    ctx.reply('❌ Could not process image.');
  }
});

bot.on('text', async (ctx) => {
  const chatId = ctx.chat.id;
  const userId = ctx.from.id;
  let text = ctx.message.text;

  if (!ALLOWED_USERS.includes(userId)) { ctx.reply('❌ Permission denied.'); return; }

  if (ctx.message.reply_to_message?.text) {
    text = `[Replying to: "${ctx.message.reply_to_message.text}"]\n\n${text}`;
  }

  // Natural language todo
  const todoIntent = detectTodoIntent(text);
  if (todoIntent === 'list') {
    const todos = await getTodos();
    ctx.reply(formatTodoList(todos), { parse_mode: 'Markdown' });
    return;
  }

  if (todoIntent === 'add' || todoIntent === 'done') {
    try {
      await ctx.sendChatAction('typing');
      const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [{
          role: 'user',
          content: `Extract the task from this message and return ONLY a JSON object with "action" (add or done) and "task".
Message: "${text}"
Example: {"action":"add","task":"call John"}`
        }],
        max_tokens: 60,
      });

      const parsed = JSON.parse(response.choices[0].message.content.trim());
      const todos = await getTodos();

      if (parsed.action === 'add') {
        await addTodo(parsed.task);
        const newTodos = await getTodos();
        ctx.reply(`✅ Added "${parsed.task}" to your list.\n📋 ${newTodos.filter(t => !t.done).length} pending tasks.`);
      } else if (parsed.action === 'done') {
        const todo = todos.find(t => !t.done && t.task.toLowerCase().includes(parsed.task.toLowerCase()));
        if (todo) {
          await markTodoDone(todo.id);
          const newTodos = await getTodos();
          ctx.reply(`✅ Marked done: "${todo.task}"\n📋 ${newTodos.filter(t => !t.done).length} tasks still pending.`);
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
    await addMessage(chatId, 'user', text);
    await ctx.sendChatAction('typing');

    const recentMessages = await getConversation(chatId);
    const last8 = recentMessages.slice(-8);

    let messages;

    if (needsSearch(text)) {
      const queries = await generateSearchQueries(text);
      const searchResultsArr = await Promise.all(queries.map(q => searchWeb(q.query || q)));
      const combinedResults = queries
        .map((q, i) => searchResultsArr[i] ? `=== SEARCH: "${q.query || q}" ===\n${searchResultsArr[i]}` : null)
        .filter(Boolean).join('\n\n');

      if (combinedResults) {
        messages = [
          { role: 'system', content: SYSTEM_PROMPT + '\n\n' + SEARCH_PROMPT },
          ...last8.slice(0, -1),
          { role: 'user', content: `My request: ${text}\n\nSearch results:\n\n${combinedResults}` }
        ];
      } else {
        messages = [{ role: 'system', content: SYSTEM_PROMPT }, ...last8];
      }
    } else {
      messages = [{ role: 'system', content: SYSTEM_PROMPT }, ...last8];
    }

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages,
      max_tokens: 1000,
    });

    const reply = response.choices[0].message.content;
    await addMessage(chatId, 'assistant', reply);
    ctx.reply(reply);

  } catch (error) {
    console.error('Error:', error);
    ctx.reply('❌ Error!');
  }
});

// ─── LAUNCH ───────────────────────────────────────────────────────────────────

bot.launch();
scheduleDaily();
console.log('🚀 Agent Bebe running with Supabase persistence!');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));