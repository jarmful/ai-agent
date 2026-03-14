const fs = require('fs');
const path = require('path');

// Create memory folder
const memoryDir = path.join(__dirname, 'memory');
if (!fs.existsSync(memoryDir)) {
  fs.mkdirSync(memoryDir);
}

// Save conversation
function saveMemory(topic, content) {
  const file = path.join(memoryDir, `${topic}.md`);
  fs.appendFileSync(file, `${content}\n---\n`);
  console.log(`✅ Saved to ${topic}`);
}

// Read conversation
function readMemory(topic) {
  const file = path.join(memoryDir, `${topic}.md`);
  if (fs.existsSync(file)) {
    return fs.readFileSync(file, 'utf8');
  }
  return 'No memory found';
}

// Test it
saveMemory('test', 'This is my first memory!');
console.log(readMemory('test'));