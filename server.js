const express = require('express');
const fs = require('fs');
const path = require('path');
const app = express();

app.use(express.static('.'));
app.use(express.json());

const MEMORY_FILE = './memory/memories.json';

app.post('/api/chat', (req, res) => {
  const { message } = req.body;

  // Read existing memories
  let memories = [];
  if (fs.existsSync(MEMORY_FILE)) {
    memories = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
  }

  // Add new message
  memories.push({ message, timestamp: new Date() });

  // Save memories
  fs.mkdirSync('./memory', { recursive: true });
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(memories, null, 2));

  // Return response
  res.json({ response: `I remember: "${message}"` });
});
app.get('/api/memories', (req, res) => {
  let memories = [];
  if (fs.existsSync(MEMORY_FILE)) {
    memories = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
  }
  res.json(memories);
});

app.listen(3000, () => console.log('🚀 Server running on http://localhost:3000'));