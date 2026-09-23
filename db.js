const path = require('path');

const isPostgres = !!process.env.DATABASE_URL;

let sqliteDb = null;
let pgPool = null;

if (isPostgres) {
  const { Pool } = require('pg');
  pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
} else {
  const Database = require('better-sqlite3');
  sqliteDb = new Database(path.join(__dirname, 'datingchat.db'));
  sqliteDb.pragma('journal_mode = WAL');
}

async function init() {
  if (isPostgres) {
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        avatar_url TEXT,
        bio TEXT,
        created_at BIGINT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY,
        user_a TEXT NOT NULL,
        user_b TEXT NOT NULL,
        created_at BIGINT NOT NULL,
        UNIQUE(user_a, user_b)
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        text TEXT,
        media_url TEXT,
        media_type TEXT,
        created_at BIGINT NOT NULL,
        deleted_for_everyone INT NOT NULL DEFAULT 0,
        deleted_for TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'sent'
      );

      CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id);
    `);
  } else {
    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        avatar_url TEXT,
        bio TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chats (
        id TEXT PRIMARY KEY,
        user_a TEXT NOT NULL,
        user_b TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(user_a, user_b)
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        text TEXT,
        media_url TEXT,
        media_type TEXT,
        created_at INTEGER NOT NULL,
        deleted_for_everyone INTEGER NOT NULL DEFAULT 0,
        deleted_for TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'sent'
      );

      CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id);
    `);
    try { sqliteDb.exec("ALTER TABLE messages ADD COLUMN media_url TEXT;"); } catch (_) {}
    try { sqliteDb.exec("ALTER TABLE messages ADD COLUMN media_type TEXT;"); } catch (_) {}
  }
}

async function findUserByUsernameOrEmail(identifier) {
  if (!identifier) return null;
  const low = identifier.toLowerCase();
  if (isPostgres) {
    const res = await pgPool.query('SELECT id, username, email, password_hash, avatar_url, bio, created_at FROM users WHERE LOWER(username) = $1 OR LOWER(email) = $1 LIMIT 1', [low]);
    return res.rows[0] || null;
  } else {
    return sqliteDb.prepare('SELECT id, username, email, password_hash, avatar_url, bio, created_at FROM users WHERE LOWER(username) = ? OR LOWER(email) = ?').get(low, low) || null;
  }
}

async function getUserById(id) {
  if (!id) return null;
  if (isPostgres) {
    const res = await pgPool.query('SELECT id, username, email, password_hash, avatar_url, bio, created_at FROM users WHERE id = $1', [id]);
    return res.rows[0] || null;
  } else {
    return sqliteDb.prepare('SELECT id, username, email, password_hash, avatar_url, bio, created_at FROM users WHERE id = ?').get(id) || null;
  }
}

async function createUser(user) {
  const { id, username, email, password_hash, created_at } = user;
  if (isPostgres) {
    await pgPool.query(
      'INSERT INTO users (id, username, email, password_hash, created_at) VALUES ($1, $2, $3, $4, $5)',
      [id, username.toLowerCase(), email.toLowerCase(), password_hash, BigInt(created_at)]
    );
  } else {
    sqliteDb.prepare('INSERT INTO users (id, username, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, username.toLowerCase(), email.toLowerCase(), password_hash, created_at);
  }
}

async function searchUsers(q, excludeUserId) {
  const low = String(q || '').trim().toLowerCase();
  if (isPostgres) {
    if (!low) {
      const res = await pgPool.query('SELECT id, username, email, avatar_url, bio FROM users WHERE id != $1 ORDER BY created_at DESC LIMIT 25', [excludeUserId]);
      return res.rows;
    }
    const res = await pgPool.query(
      'SELECT id, username, email, avatar_url, bio FROM users WHERE (LOWER(username) LIKE $1 OR LOWER(email) LIKE $1) AND id != $2 ORDER BY username ASC LIMIT 25',
      [`%${low}%`, excludeUserId]
    );
    return res.rows;
  } else {
    if (!low) {
      return sqliteDb.prepare('SELECT id, username, email, avatar_url, bio FROM users WHERE id != ? ORDER BY created_at DESC LIMIT 25').all(excludeUserId);
    }
    return sqliteDb.prepare('SELECT id, username, email, avatar_url, bio FROM users WHERE (LOWER(username) LIKE ? OR LOWER(email) LIKE ?) AND id != ? ORDER BY username ASC LIMIT 25')
      .all(`%${low}%`, `%${low}%`, excludeUserId);
  }
}

function chatIdFor(a, b) {
  const [x, y] = [a, b].sort();
  return `${x}_${y}`;
}

async function getOrCreateChat(userA, userB) {
  const id = chatIdFor(userA, userB);
  if (isPostgres) {
    const existing = await pgPool.query('SELECT * FROM chats WHERE id = $1', [id]);
    if (existing.rows[0]) return existing.rows[0];
    const [x, y] = [userA, userB].sort();
    await pgPool.query('INSERT INTO chats (id, user_a, user_b, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [id, x, y, BigInt(Date.now())]);
    const chat = await pgPool.query('SELECT * FROM chats WHERE id = $1', [id]);
    return chat.rows[0];
  } else {
    const existing = sqliteDb.prepare('SELECT * FROM chats WHERE id = ?').get(id);
    if (existing) return existing;
    const [x, y] = [userA, userB].sort();
    sqliteDb.prepare('INSERT INTO chats (id, user_a, user_b, created_at) VALUES (?, ?, ?, ?)').run(id, x, y, Date.now());
    return sqliteDb.prepare('SELECT * FROM chats WHERE id = ?').get(id);
  }
}

async function getChatById(id) {
  if (isPostgres) {
    const res = await pgPool.query('SELECT * FROM chats WHERE id = $1', [id]);
    return res.rows[0] || null;
  } else {
    return sqliteDb.prepare('SELECT * FROM chats WHERE id = ?').get(id) || null;
  }
}

async function getChatsForUser(userId) {
  if (isPostgres) {
    const res = await pgPool.query('SELECT * FROM chats WHERE user_a = $1 OR user_b = $1', [userId]);
    return res.rows;
  } else {
    return sqliteDb.prepare('SELECT * FROM chats WHERE user_a = ? OR user_b = ?').all(userId, userId);
  }
}

async function getLastMessageForChat(chatId) {
  if (isPostgres) {
    const res = await pgPool.query(
      'SELECT * FROM messages WHERE chat_id = $1 AND deleted_for_everyone = 0 ORDER BY created_at DESC LIMIT 1',
      [chatId]
    );
    return res.rows[0] || null;
  } else {
    return sqliteDb.prepare('SELECT * FROM messages WHERE chat_id = ? AND deleted_for_everyone = 0 ORDER BY created_at DESC LIMIT 1').get(chatId) || null;
  }
}

async function getMessagesForChat(chatId) {
  if (isPostgres) {
    const res = await pgPool.query('SELECT * FROM messages WHERE chat_id = $1 ORDER BY created_at ASC', [chatId]);
    return res.rows;
  } else {
    return sqliteDb.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at ASC').all(chatId);
  }
}

async function getMessageById(id) {
  if (isPostgres) {
    const res = await pgPool.query('SELECT * FROM messages WHERE id = $1', [id]);
    return res.rows[0] || null;
  } else {
    return sqliteDb.prepare('SELECT * FROM messages WHERE id = ?').get(id) || null;
  }
}

async function createMessage(msg) {
  const { id, chat_id, sender_id, text, media_url, media_type, created_at, deleted_for_everyone, deleted_for, status } = msg;
  if (isPostgres) {
    await pgPool.query(
      `INSERT INTO messages (id, chat_id, sender_id, text, media_url, media_type, created_at, deleted_for_everyone, deleted_for, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [id, chat_id, sender_id, text, media_url, media_type, BigInt(created_at), deleted_for_everyone || 0, deleted_for || '', status || 'sent']
    );
  } else {
    sqliteDb.prepare(`
      INSERT INTO messages (id, chat_id, sender_id, text, media_url, media_type, created_at, deleted_for_everyone, deleted_for, status)
      VALUES (@id, @chat_id, @sender_id, @text, @media_url, @media_type, @created_at, @deleted_for_everyone, @deleted_for, @status)
    `).run({
      id, chat_id, sender_id, text: text || null, media_url: media_url || null, media_type: media_type || null,
      created_at, deleted_for_everyone: deleted_for_everyone || 0, deleted_for: deleted_for || '', status: status || 'sent'
    });
  }
}

async function updateMessageDeletedForEveryone(id) {
  if (isPostgres) {
    await pgPool.query('UPDATE messages SET deleted_for_everyone = 1, text = \'\' WHERE id = $1', [id]);
  } else {
    sqliteDb.prepare('UPDATE messages SET deleted_for_everyone = 1, text = ? WHERE id = ?').run('', id);
  }
}

async function updateMessageDeletedFor(id, deletedFor) {
  if (isPostgres) {
    await pgPool.query('UPDATE messages SET deleted_for = $1 WHERE id = $2', [deletedFor, id]);
  } else {
    sqliteDb.prepare('UPDATE messages SET deleted_for = ? WHERE id = ?').run(deletedFor, id);
  }
}

async function updateUserAvatar(userId, avatarUrl) {
  if (isPostgres) {
    await pgPool.query('UPDATE users SET avatar_url = $1 WHERE id = $2', [avatarUrl, userId]);
  } else {
    sqliteDb.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').run(avatarUrl, userId);
  }
}

async function updateUserBio(userId, bio) {
  if (isPostgres) {
    await pgPool.query('UPDATE users SET bio = $1 WHERE id = $2', [bio, userId]);
  } else {
    sqliteDb.prepare('UPDATE users SET bio = ? WHERE id = ?').run(bio, userId);
  }
}

module.exports = {
  init,
  findUserByUsernameOrEmail,
  getUserById,
  createUser,
  searchUsers,
  getOrCreateChat,
  getChatById,
  getChatsForUser,
  getLastMessageForChat,
  getMessagesForChat,
  getMessageById,
  createMessage,
  updateMessageDeletedForEveryone,
  updateMessageDeletedFor,
  updateUserAvatar,
  updateUserBio
};
