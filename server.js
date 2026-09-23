const express = require('express');
const cors = require('cors');
const http = require('http');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');
const { WebSocketServer } = require('ws');

const db = require('./db');
const { signToken, verifyToken, requireAuth } = require('./auth');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ---------- File upload (profile pictures) ----------
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `${req.userId}-${Date.now()}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    avatarUrl: row.avatar_url || null,
    bio: row.bio || null
  };
}

// ---------- AUTH ----------
app.post('/auth/register', (req, res) => {
  const { username, email, password } = req.body || {};
  if (!username || !email || !password) {
    return res.status(400).json({ error: 'username, email and password are required' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  const existing = db.prepare('SELECT id FROM users WHERE username = ? OR email = ?')
    .get(username.toLowerCase(), email.toLowerCase());
  if (existing) return res.status(409).json({ error: 'Username or email already taken' });

  const id = uuid();
  const hash = bcrypt.hashSync(password, 10);
  db.prepare(`INSERT INTO users (id, username, email, password_hash, created_at)
              VALUES (?, ?, ?, ?, ?)`)
    .run(id, username.toLowerCase(), email.toLowerCase(), hash, Date.now());

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  res.json({ token: signToken(id), user: publicUser(user) });
});

app.post('/auth/login', (req, res) => {
  const { identifier, password } = req.body || {}; // identifier = username or email
  if (!identifier || !password) return res.status(400).json({ error: 'identifier and password are required' });

  const user = db.prepare('SELECT * FROM users WHERE username = ? OR email = ?')
    .get(identifier.toLowerCase(), identifier.toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  res.json({ token: signToken(user.id), user: publicUser(user) });
});

app.get('/auth/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  res.json(publicUser(user));
});

// ---------- USERS / SEARCH ----------
// Search by username OR email (exact or partial match), excludes self.
app.get('/users/search', requireAuth, (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  if (!q) return res.json([]);
  const rows = db.prepare(`
    SELECT * FROM users
    WHERE (username LIKE ? OR email LIKE ?) AND id != ?
    LIMIT 25
  `).all(`%${q}%`, `%${q}%`, req.userId);
  res.json(rows.map(publicUser));
});

app.get('/users/:id', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json(publicUser(user));
});

app.post('/users/me/avatar', requireAuth, upload.single('avatar'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const url = `/uploads/${req.file.filename}`;
  db.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').run(url, req.userId);
  res.json({ avatarUrl: url });
});

app.patch('/users/me', requireAuth, (req, res) => {
  const { bio } = req.body || {};
  if (typeof bio === 'string') {
    db.prepare('UPDATE users SET bio = ? WHERE id = ?').run(bio, req.userId);
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  res.json(publicUser(user));
});

// ---------- CHATS ----------
function chatIdFor(a, b) {
  const [x, y] = [a, b].sort();
  return `${x}_${y}`;
}

function getOrCreateChat(userA, userB) {
  const id = chatIdFor(userA, userB);
  const existing = db.prepare('SELECT * FROM chats WHERE id = ?').get(id);
  if (existing) return existing;
  const [x, y] = [userA, userB].sort();
  db.prepare('INSERT INTO chats (id, user_a, user_b, created_at) VALUES (?, ?, ?, ?)')
    .run(id, x, y, Date.now());
  return db.prepare('SELECT * FROM chats WHERE id = ?').get(id);
}

// Start (or fetch) a chat with another user by their id — used after a search result is tapped.
app.post('/chats/with/:userId', requireAuth, (req, res) => {
  const other = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.userId);
  if (!other) return res.status(404).json({ error: 'User not found' });
  const chat = getOrCreateChat(req.userId, other.id);
  res.json({ chatId: chat.id, otherUser: publicUser(other) });
});

// List all chats for the logged-in user, with last message + other user info.
app.get('/chats', requireAuth, (req, res) => {
  const chats = db.prepare('SELECT * FROM chats WHERE user_a = ? OR user_b = ?')
    .all(req.userId, req.userId);

  const result = chats.map(chat => {
    const otherId = chat.user_a === req.userId ? chat.user_b : chat.user_a;
    const other = db.prepare('SELECT * FROM users WHERE id = ?').get(otherId);
    const lastMsg = db.prepare(`
      SELECT * FROM messages WHERE chat_id = ? AND deleted_for_everyone = 0
      ORDER BY created_at DESC LIMIT 1
    `).get(chat.id);
    return {
      chatId: chat.id,
      otherUser: publicUser(other),
      lastMessage: lastMsg ? {
        id: lastMsg.id, text: lastMsg.text, senderId: lastMsg.sender_id, createdAt: lastMsg.created_at
      } : null
    };
  }).sort((a, b) => (b.lastMessage?.createdAt || 0) - (a.lastMessage?.createdAt || 0));

  res.json(result);
});

// Message history for a chat (skips messages deleted-for-me by this user, and deleted-for-everyone).
app.get('/chats/:chatId/messages', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at ASC')
    .all(req.params.chatId);
  const visible = rows.filter(m => {
    const deletedFor = m.deleted_for ? m.deleted_for.split(',') : [];
    return !deletedFor.includes(req.userId);
  }).map(m => ({
    id: m.id,
    chatId: m.chat_id,
    senderId: m.sender_id,
    text: m.deleted_for_everyone ? null : m.text,
    deletedForEveryone: !!m.deleted_for_everyone,
    createdAt: m.created_at,
    status: m.status
  }));
  res.json(visible);
});

// Delete a message: forEveryone=true (only sender may do this) or delete-for-me.
app.post('/messages/:id/delete', requireAuth, (req, res) => {
  const { forEveryone } = req.body || {};
  const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
  if (!msg) return res.status(404).json({ error: 'Not found' });

  if (forEveryone) {
    if (msg.sender_id !== req.userId) return res.status(403).json({ error: 'Only the sender can delete for everyone' });
    db.prepare('UPDATE messages SET deleted_for_everyone = 1, text = ? WHERE id = ?').run('', msg.id);
  } else {
    const current = msg.deleted_for ? msg.deleted_for.split(',') : [];
    if (!current.includes(req.userId)) current.push(req.userId);
    db.prepare('UPDATE messages SET deleted_for = ? WHERE id = ?').run(current.join(','), msg.id);
  }
  broadcastToChat(msg.chat_id, { type: 'message_deleted', messageId: msg.id, forEveryone: !!forEveryone });
  res.json({ ok: true });
});

// ---------- WEBSOCKET (real-time chat + live delivery) ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// userId -> Set of live sockets (a user might have the app open on multiple devices)
const liveSockets = new Map();

function broadcastToChat(chatId, payload) {
  const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
  if (!chat) return;
  [chat.user_a, chat.user_b].forEach(uid => {
    const sockets = liveSockets.get(uid);
    if (sockets) sockets.forEach(ws => ws.readyState === 1 && ws.send(JSON.stringify(payload)));
  });
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const token = url.searchParams.get('token');
  const userId = token ? verifyToken(token) : null;

  if (!userId) {
    ws.close(4001, 'Unauthorized');
    return;
  }

  if (!liveSockets.has(userId)) liveSockets.set(userId, new Set());
  liveSockets.get(userId).add(ws);

  ws.on('message', raw => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    if (data.type === 'send_message') {
      const { chatId, text } = data;
      if (!chatId || !text || !text.trim()) return;
      const chat = db.prepare('SELECT * FROM chats WHERE id = ?').get(chatId);
      if (!chat || (chat.user_a !== userId && chat.user_b !== userId)) return;

      const msg = {
        id: uuid(), chat_id: chatId, sender_id: userId, text: text.trim(),
        created_at: Date.now(), deleted_for_everyone: 0, deleted_for: '', status: 'sent'
      };
      db.prepare(`INSERT INTO messages (id, chat_id, sender_id, text, created_at, deleted_for_everyone, deleted_for, status)
                  VALUES (@id, @chat_id, @sender_id, @text, @created_at, @deleted_for_everyone, @deleted_for, @status)`)
        .run(msg);

      broadcastToChat(chatId, {
        type: 'new_message',
        message: { id: msg.id, chatId, senderId: userId, text: msg.text, createdAt: msg.created_at, status: 'sent' }
      });
    }

    if (data.type === 'typing') {
      broadcastToChat(data.chatId, { type: 'typing', chatId: data.chatId, userId });
    }
  });

  ws.on('close', () => {
    const set = liveSockets.get(userId);
    if (set) { set.delete(ws); if (set.size === 0) liveSockets.delete(userId); }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`DatingChat backend running on http://0.0.0.0:${PORT}  (WebSocket at /ws)`);
});
