const jwt = require('jsonwebtoken');

// In production, set this via environment variable instead of hardcoding.
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-in-production';

function signToken(userId) {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: '30d' });
}

function verifyToken(token) {
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    return decoded.sub;
  } catch (e) {
    return null;
  }
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const userId = token ? verifyToken(token) : null;
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  req.userId = userId;
  next();
}

module.exports = { signToken, verifyToken, requireAuth, JWT_SECRET };
