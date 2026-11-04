const bcrypt = require('bcrypt');
const db = require('./db');

async function registerUser(username, password, role = 'cleaner') {
  const existing = await db.getUserByUsername(username);
  if (existing) {
    throw new Error('Username already taken');
  }
  const passwordHash = await bcrypt.hash(password, 10);
  return db.createUser({ username, passwordHash, role });
}

async function verifyLogin(username, password) {
  const user = await db.getUserByUsername(username);
  if (!user) return null;

  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) return null;

  return { user_id: user.user_id, username: user.username, role: user.role };
}

// Middleware: block access unless logged in
function requireLogin(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Not logged in' });
  }
  next();
}

// Middleware: block access unless logged in AND admin
function requireAdmin(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Not logged in' });
  }
  if (req.session.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

module.exports = { registerUser, verifyLogin, requireLogin, requireAdmin };