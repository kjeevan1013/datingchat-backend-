# DatingChat Backend

A small self-hosted server (no Firebase, no third-party BaaS). Plain Node.js +
Express for REST, `ws` for real-time chat, `better-sqlite3` for storage,
local disk for profile pictures.

## Endpoints

- `POST /auth/register` `{ username, email, password }` → `{ token, user }`
- `POST /auth/login` `{ identifier, password }` → `{ token, user }` (identifier = username or email)
- `GET /auth/me` (Bearer token) → current user
- `GET /users/search?q=...` (Bearer token) → users matching username or email
- `POST /users/me/avatar` (Bearer token, multipart field `avatar`) → `{ avatarUrl }`
- `POST /chats/with/:userId` (Bearer token) → creates/returns a chat with that user
- `GET /chats` (Bearer token) → your chat list with last message + other user's profile
- `GET /chats/:chatId/messages` (Bearer token) → full message history
- `POST /messages/:id/delete` `{ forEveryone: true|false }` (Bearer token)
- `WS /ws?token=...` → real-time messages. Send `{"type":"send_message","chatId":"...","text":"..."}`,
  receive `{"type":"new_message","message":{...}}` or `{"type":"message_deleted",...}`.

## Run locally

```bash
cd server
npm install
npm start
# -> http://localhost:3000  (WebSocket at ws://localhost:3000/ws)
```

## Run on your phone/emulator against your laptop

- **Android emulator**: use `http://10.0.2.2:3000` as the base URL (this is the
  emulator's alias for your computer's `localhost`). Already set as the
  default in the app's `NetworkConfig.kt`.
- **Real device on same Wi-Fi**: find your computer's LAN IP (e.g. `192.168.1.23`)
  and set that as the base URL in the app instead.

## Deploying so it works away from your Wi-Fi

This server has no Firebase, so *you* host it. Cheapest reliable options:

1. **Railway.app / Render.com (free tier)** — push this `backend/` folder,
   they give you a public `https://...` URL and `wss://...` for the socket.
2. **A $5/mo VPS (DigitalOcean, Hetzner)** — `npm install && npm start`,
   put it behind Caddy/nginx for HTTPS, keep it alive with `pm2`.

Once deployed, update the base URL + WS URL in the Android app's
`NetworkConfig.kt` and rebuild.

## Important before real use

- Set a real `JWT_SECRET` environment variable in production (a long random string).
- This demo stores passwords hashed (bcrypt) — good — but there's no rate
  limiting, email verification, or HTTPS by default. Add a reverse proxy
  (Caddy/nginx) with a free Let's Encrypt certificate before exposing this
  publicly.
- SQLite file (`datingchat.db`) and `uploads/` folder are your whole
  database — back them up.

## Notifications, honestly

This server pushes messages instantly over WebSocket **while the app is
open** (foreground or background service running). It does **not** wake the
app from a fully killed/swiped-away state the way Firebase Cloud Messaging
does — that requires Google's push infrastructure (or a paid alternative
like OneSignal). If you later want true "phone buzzes even when the app is
closed" notifications, that's the one piece this self-hosted setup can't
replace on its own.
