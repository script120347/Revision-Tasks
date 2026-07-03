const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ===== DATABASE =====
const db = new sqlite3.Database('./chat.db');

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    color TEXT DEFAULT '#cc66ff',
    avatar TEXT DEFAULT '',
    role TEXT DEFAULT 'user',
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

// ===== CREATE ADMIN ACCOUNT =====
const adminHash = crypto.createHash('sha256').update('sigma2024').digest('hex');
db.run(
  `INSERT OR REPLACE INTO users (username, password, color, role) VALUES (?, ?, ?, ?)`,
  ['admin', adminHash, '#ff4444', 'admin'],
  function(err) {
    if (err) console.error('Admin creation error:', err);
    else console.log('✅ Admin account ready: admin / sigma2024');
  }
);

// ===== MIDDLEWARE =====
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ===== AUTH API =====
app.post('/api/register', (req, res) => {
  const { username, password, color } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (username.length < 2 || username.length > 20 || !/^[A-Za-z0-9_]+$/.test(username)) {
    return res.status(400).json({ error: 'Invalid username' });
  }
  if (password.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });

  const hashed = crypto.createHash('sha256').update(password).digest('hex');
  db.run(`INSERT INTO users (username, password, color, role) VALUES (?, ?, ?, ?)`,
    [username, hashed, color || '#cc66ff', 'user'],
    function(err) {
      if (err) return res.status(400).json({ error: 'Username taken' });
      res.json({ success: true, username });
    }
  );
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  const hashed = crypto.createHash('sha256').update(password).digest('hex');
  db.get(`SELECT username, color, avatar, role FROM users WHERE username = ? AND password = ?`,
    [username, hashed],
    (err, row) => {
      if (err || !row) return res.status(401).json({ error: 'Invalid credentials' });
      res.json({ success: true, user: row });
    }
  );
});

// ===== ADMIN API =====
app.get('/api/admin/users', (req, res) => {
  const { username, password } = req.query;
  const hashed = crypto.createHash('sha256').update(password || '').digest('hex');
  db.get(`SELECT role FROM users WHERE username = ? AND password = ?`,
    [username, hashed],
    (err, row) => {
      if (err || !row || row.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
      }
      db.all(`SELECT id, username, color, avatar, role, created_at FROM users`, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ users: rows });
      });
    }
  );
});

app.post('/api/admin/kick', (req, res) => {
  const { adminUser, adminPass, targetUser } = req.body;
  const hashed = crypto.createHash('sha256').update(adminPass || '').digest('hex');
  db.get(`SELECT role FROM users WHERE username = ? AND password = ?`,
    [adminUser, hashed],
    (err, row) => {
      if (err || !row || row.role !== 'admin') {
        return res.status(403).json({ error: 'Admin required' });
      }
      broadcast({ type: 'admin_kick', username: targetUser });
      res.json({ success: true, message: `Kicked ${targetUser}` });
    }
  );
});

app.post('/api/admin/rename', (req, res) => {
  const { adminUser, adminPass, oldName, newName } = req.body;
  const hashed = crypto.createHash('sha256').update(adminPass || '').digest('hex');
  db.get(`SELECT role FROM users WHERE username = ? AND password = ?`,
    [adminUser, hashed],
    (err, row) => {
      if (err || !row || row.role !== 'admin') {
        return res.status(403).json({ error: 'Admin required' });
      }
      if (!newName || newName.length < 2) return res.status(400).json({ error: 'Invalid new name' });
      db.run(`UPDATE users SET username = ? WHERE username = ?`, [newName, oldName], function(err) {
        if (err) return res.status(400).json({ error: 'Name already taken' });
        broadcast({ type: 'admin_rename', oldName, newName });
        res.json({ success: true, message: `Renamed ${oldName} to ${newName}` });
      });
    }
  );
});

app.post('/api/admin/jumpscare', (req, res) => {
  const { adminUser, adminPass, targetUser, sound } = req.body;
  const hashed = crypto.createHash('sha256').update(adminPass || '').digest('hex');
  db.get(`SELECT role FROM users WHERE username = ? AND password = ?`,
    [adminUser, hashed],
    (err, row) => {
      if (err || !row || row.role !== 'admin') {
        return res.status(403).json({ error: 'Admin required' });
      }
      broadcast({ type: 'admin_jumpscare', username: targetUser, sound: sound || 'scream' });
      res.json({ success: true });
    }
  );
});

app.post('/api/admin/sound', (req, res) => {
  const { adminUser, adminPass, targetUser, sound } = req.body;
  const hashed = crypto.createHash('sha256').update(adminPass || '').digest('hex');
  db.get(`SELECT role FROM users WHERE username = ? AND password = ?`,
    [adminUser, hashed],
    (err, row) => {
      if (err || !row || row.role !== 'admin') {
        return res.status(403).json({ error: 'Admin required' });
      }
      broadcast({ type: 'admin_sound', username: targetUser, sound: sound || 'alert' });
      res.json({ success: true });
    }
  );
});

// ===== MESSAGES API =====
app.get('/api/messages', (req, res) => {
  db.all(`SELECT * FROM messages ORDER BY id DESC LIMIT 100`, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ messages: rows.reverse() });
  });
});

app.post('/api/messages', (req, res) => {
  const { username, content, color, avatar } = req.body;
  if (!username || !content) return res.status(400).json({ error: 'Missing fields' });
  db.run(`INSERT INTO messages (username, content, color, avatar) VALUES (?, ?, ?, ?)`,
    [username, content, color || '#cc66ff', avatar || ''],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      const msg = { id: this.lastID, username, content, color: color || '#cc66ff', avatar: avatar || '', time: Math.floor(Date.now() / 1000), is_system: 0 };
      broadcast({ type: 'message', message: msg });
      res.json({ success: true, message: msg });
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
        db.run(`INSERT OR REPLACE INTO online_users (username, last_seen) VALUES (?, ?)`,
          [username, Math.floor(Date.now() / 1000)]
        );
        broadcast({ type: 'online_update', users: Array.from(clients.values()).map(c => c.username) });
      }
      
      if (data.type === 'ping') {
        if (username) db.run(`UPDATE online_users SET last_seen = ? WHERE username = ?`,
          [Math.floor(Date.now() / 1000), username]
        );
        ws.send(JSON.stringify({ type: 'pong' }));
      }

      if (data.type === 'ws_message') {
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
        db.run(`INSERT INTO messages (username, content, color, avatar) VALUES (?, ?, ?, ?)`,
          [username, data.content, msg.color, msg.avatar]
        );
        broadcast({ type: 'message', message: msg });
      }

      if (data.type === 'typing') {
        broadcast({ type: 'typing', username, is_typing: data.is_typing });
      }

    } catch(e) { console.error('WS error:', e); }
  });

  ws.on('close', () => {
    if (username) {
      clients.delete(ws);
      db.run(`DELETE FROM online_users WHERE username = ?`, [username]);
      broadcast({ type: 'online_update', users: Array.from(clients.values()).map(c => c.username) });
    }
  });

  db.all(`SELECT username FROM online_users`, (err, rows) => {
    if (!err) ws.send(JSON.stringify({ type: 'online_update', users: rows.map(r => r.username) }));
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`👑 Admin: admin / sigma2024`);
});
