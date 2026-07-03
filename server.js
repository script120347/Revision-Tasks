const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ===== DATABASE =====
const db = new sqlite3.Database('./chat.db');

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    color TEXT DEFAULT '#cc66ff',
    avatar TEXT DEFAULT '',
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    content TEXT NOT NULL,
    color TEXT DEFAULT '#cc66ff',
    avatar TEXT DEFAULT '',
    time INTEGER DEFAULT (strftime('%s', 'now')),
    is_system INTEGER DEFAULT 0
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS online_users (
    username TEXT PRIMARY KEY,
    last_seen INTEGER DEFAULT (strftime('%s', 'now'))
  )`);
});

// ===== MIDDLEWARE =====
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ===== API =====
app.get('/api/messages', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const since = parseInt(req.query.since) || 0;
  db.all(
    `SELECT * FROM messages WHERE id > ? ORDER BY id DESC LIMIT ?`,
    [since, limit],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ messages: rows.reverse() });
    }
  );
});

app.post('/api/messages', (req, res) => {
  const { username, content, color, avatar } = req.body;
  if (!username || !content) {
    return res.status(400).json({ error: 'Username and content required' });
  }
  if (content.length > 280) {
    return res.status(400).json({ error: 'Message too long (max 280 chars)' });
  }

  db.run(
    `INSERT INTO messages (username, content, color, avatar) VALUES (?, ?, ?, ?)`,
    [username, content, color || '#cc66ff', avatar || ''],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      const msg = {
        id: this.lastID,
        username,
        content,
        color: color || '#cc66ff',
        avatar: avatar || '',
        time: Math.floor(Date.now() / 1000),
        is_system: 0
      };
      broadcast({ type: 'message', message: msg });
      res.json({ success: true, message: msg });
    }
  );
});

app.post('/api/users', (req, res) => {
  const { username, color, avatar } = req.body;
  if (!username) return res.status(400).json({ error: 'Username required' });
  if (username.length < 2 || username.length > 20 || !/^[A-Za-z0-9_]+$/.test(username)) {
    return res.status(400).json({ error: 'Invalid username' });
  }
  db.run(
    `INSERT OR REPLACE INTO users (username, color, avatar) VALUES (?, ?, ?)`,
    [username, color || '#cc66ff', avatar || ''],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, username });
    }
  );
});

// ===== WEBSOCKET =====
const clients = new Map();

function broadcast(data) {
  const message = JSON.stringify(data);
  clients.forEach((client) => {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(message);
    }
  });
}

wss.on('connection', (ws) => {
  let username = null;

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      if (data.type === 'login') {
        username = data.username;
        clients.set(ws, { ws, username });
        db.run(
          `INSERT OR REPLACE INTO online_users (username, last_seen) VALUES (?, ?)`,
          [username, Math.floor(Date.now() / 1000)]
        );
        const onlineList = Array.from(clients.values()).map(c => c.username);
        broadcast({ type: 'online_update', users: onlineList });
      }
      
      if (data.type === 'ping') {
        if (username) {
          db.run(
            `UPDATE online_users SET last_seen = ? WHERE username = ?`,
            [Math.floor(Date.now() / 1000), username]
          );
        }
        ws.send(JSON.stringify({ type: 'pong' }));
      }

      if (data.type === 'message') {
        if (!username) return;
        const msg = {
          id: Date.now(),
          username,
          content: data.content,
          color: data.color || '#cc66ff',
          avatar: data.avatar || '',
          time: Math.floor(Date.now() / 1000),
          is_system: 0
        };
        db.run(
          `INSERT INTO messages (username, content, color, avatar) VALUES (?, ?, ?, ?)`,
          [username, data.content, msg.color, msg.avatar]
        );
        broadcast({ type: 'message', message: msg });
      }

      if (data.type === 'typing') {
        broadcast({ type: 'typing', username: username, is_typing: data.is_typing });
      }

    } catch(e) {
      console.error('WS error:', e);
    }
  });

  ws.on('close', () => {
    if (username) {
      clients.delete(ws);
      db.run(`DELETE FROM online_users WHERE username = ?`, [username]);
      const onlineList = Array.from(clients.values()).map(c => c.username);
      broadcast({ type: 'online_update', users: onlineList });
    }
  });

  db.all(`SELECT username FROM online_users`, (err, rows) => {
    if (!err) {
      ws.send(JSON.stringify({
        type: 'online_update',
        users: rows.map(r => r.username)
      }));
    }
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});