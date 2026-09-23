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

// ---------- File upload (profile pictures & chat media) ----------
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `${req.userId || 'media'}-${Date.now()}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

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
app.post('/auth/register', async (req, res) => {
  const { username, email, password } = req.body || {};
  if (!username || !email || !password) {
    return res.status(400).json({ error: 'username, email and password are required' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  const existingByUsername = await db.findUserByUsernameOrEmail(username);
  const existingByEmail = await db.findUserByUsernameOrEmail(email);
  if (existingByUsername || existingByEmail) {
    return res.status(409).json({ error: 'Username or email already taken' });
  }

  const id = uuid();
  const hash = bcrypt.hashSync(password, 10);
  await db.createUser({ id, username, email, password_hash: hash, created_at: Date.now() });

  const user = await db.getUserById(id);
  res.json({ token: signToken(id), user: publicUser(user) });
});

app.post('/auth/login', async (req, res) => {
  const { identifier, password } = req.body || {};
  if (!identifier || !password) return res.status(400).json({ error: 'identifier and password are required' });

  const user = await db.findUserByUsernameOrEmail(identifier);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  res.json({ token: signToken(user.id), user: publicUser(user) });
});

app.get('/auth/me', requireAuth, async (req, res) => {
  const user = await db.getUserById(req.userId);
  if (!user) return res.status(401).json({ error: 'User not found' });
  res.json(publicUser(user));
});

// ---------- USERS / SEARCH ----------
app.get('/users/search', requireAuth, async (req, res) => {
  const rows = await db.searchUsers(req.query.q, req.userId);
  res.json(rows.map(publicUser));
});

app.get('/users/:id', requireAuth, async (req, res) => {
  const user = await db.getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json(publicUser(user));
});

app.post('/users/me/avatar', requireAuth, upload.single('avatar'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const url = `/uploads/${req.file.filename}`;
  await db.updateUserAvatar(req.userId, url);
  res.json({ avatarUrl: url });
});

app.post('/chats/upload', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const url = `/uploads/${req.file.filename}`;
  const isVideo = (req.file.mimetype && req.file.mimetype.startsWith('video/')) ||
                  /\.(mp4|mov|avi|mkv|webm|3gp)$/i.test(req.file.filename);
  res.json({ mediaUrl: url, mediaType: isVideo ? 'video' : 'image' });
});

app.patch('/users/me', requireAuth, async (req, res) => {
  const { bio } = req.body || {};
  if (typeof bio === 'string') {
    await db.updateUserBio(req.userId, bio);
  }
  const user = await db.getUserById(req.userId);
  res.json(publicUser(user));
});

// ---------- CHATS ----------
app.post('/chats/with/:userId', requireAuth, async (req, res) => {
  const other = await db.getUserById(req.params.userId);
  if (!other) return res.status(404).json({ error: 'User not found' });
  const chat = await db.getOrCreateChat(req.userId, other.id);
  res.json({ chatId: chat.id, otherUser: publicUser(other) });
});

app.get('/chats', requireAuth, async (req, res) => {
  const chats = await db.getChatsForUser(req.userId);

  const result = await Promise.all(chats.map(async chat => {
    const otherId = chat.user_a === req.userId ? chat.user_b : chat.user_a;
    const other = await db.getUserById(otherId);
    const lastMsg = await db.getLastMessageForChat(chat.id);

    const createdAt = lastMsg ? Number(lastMsg.created_at) : Number(chat.created_at);
    let text = lastMsg ? lastMsg.text : null;
    if (lastMsg && !text) {
      if (lastMsg.media_type === 'video') text = '🎥 Video';
      else if (lastMsg.media_type === 'image' || lastMsg.media_url) text = '📷 Photo';
    }

    return {
      chatId: chat.id,
      otherUser: publicUser(other),
      lastMessage: lastMsg ? {
        id: lastMsg.id, text, senderId: lastMsg.sender_id, createdAt
      } : null,
      updatedAt: createdAt
    };
  }));

  const visibleChats = result.filter(c => c.otherUser != null)
    .sort((a, b) => b.updatedAt - a.updatedAt);

  res.json(visibleChats);
});

app.get('/chats/:chatId/messages', requireAuth, async (req, res) => {
  const rows = await db.getMessagesForChat(req.params.chatId);
  const visible = rows.filter(m => {
    const deletedFor = m.deleted_for ? String(m.deleted_for).split(',') : [];
    return !deletedFor.includes(req.userId);
  }).map(m => ({
    id: m.id,
    chatId: m.chat_id,
    senderId: m.sender_id,
    text: m.deleted_for_everyone ? null : m.text,
    mediaUrl: m.deleted_for_everyone ? null : (m.media_url || null),
    mediaType: m.deleted_for_everyone ? null : (m.media_type || null),
    deletedForEveryone: !!m.deleted_for_everyone,
    createdAt: Number(m.created_at),
    status: m.status
  }));
  res.json(visible);
});

app.post('/messages/:id/delete', requireAuth, async (req, res) => {
  const { forEveryone } = req.body || {};
  const msg = await db.getMessageById(req.params.id);
  if (!msg) return res.status(404).json({ error: 'Not found' });

  if (forEveryone) {
    if (msg.sender_id !== req.userId) return res.status(403).json({ error: 'Only the sender can delete for everyone' });
    await db.updateMessageDeletedForEveryone(msg.id);
  } else {
    const current = msg.deleted_for ? String(msg.deleted_for).split(',') : [];
    if (!current.includes(req.userId)) current.push(req.userId);
    await db.updateMessageDeletedFor(msg.id, current.join(','));
  }
  await broadcastToChat(msg.chat_id, { type: 'message_deleted', messageId: msg.id, forEveryone: !!forEveryone });
  res.json({ ok: true });
});

// ---------- WEBSOCKET (real-time chat + live delivery) ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const liveSockets = new Map();

async function broadcastToChat(chatId, payload) {
  const chat = await db.getChatById(chatId);
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

  ws.on('message', async raw => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    if (data.type === 'send_message') {
      const { chatId, text, mediaUrl, mediaType } = data;
      if (!chatId) return;
      if (!text && !mediaUrl) return;
      const chat = await db.getChatById(chatId);
      if (!chat || (chat.user_a !== userId && chat.user_b !== userId)) return;

      const msg = {
        id: uuid(), chat_id: chatId, sender_id: userId,
        text: text && text.trim() ? text.trim() : null,
        media_url: mediaUrl || null,
        media_type: mediaType || null,
        created_at: Date.now(), deleted_for_everyone: 0, deleted_for: '', status: 'sent'
      };
      await db.createMessage(msg);

      await broadcastToChat(chatId, {
        type: 'new_message',
        message: {
          id: msg.id, chatId, senderId: userId, text: msg.text,
          mediaUrl: msg.media_url, mediaType: msg.media_type,
          createdAt: msg.created_at, status: 'sent'
        }
      });
    }

    if (data.type === 'typing') {
      await broadcastToChat(data.chatId, { type: 'typing', chatId: data.chatId, userId });
    }
  });

  ws.on('close', () => {
    const set = liveSockets.get(userId);
    if (set) { set.delete(ws); if (set.size === 0) liveSockets.delete(userId); }
  });
});

async function startServer() {
  await db.init();
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`DatingChat backend running on http://0.0.0.0:${PORT} (WebSocket at /ws)`);
  });
}

startServer().catch(err => {
  console.error('Failed to start server:', err);
});
