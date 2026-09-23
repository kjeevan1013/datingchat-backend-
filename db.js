const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'datingchat.db'));
db.pragma('journal_mode = WAL');

db.exec(`
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
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  deleted_for_everyone INTEGER NOT NULL DEFAULT 0,
  deleted_for TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'sent'
);

CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id);
`);

try { db.exec("ALTER TABLE messages ADD COLUMN media_url TEXT;"); } catch (_) {}
try { db.exec("ALTER TABLE messages ADD COLUMN media_type TEXT;"); } catch (_) {}

module.exports = db;
