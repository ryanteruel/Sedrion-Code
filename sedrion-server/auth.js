const bcrypt = require('bcrypt');
const db = require('./db');

async function registerUser(username, password, role = 'cleaner', profile = {}) {
  const hash = await bcrypt.hash(password, 10);
  return db.createUser({
    username,
    passwordHash: hash,
    role,
    fullName: profile.fullName || null,
    deploymentArea: profile.deploymentArea || 'Unassigned',
    contactNumber: profile.contactNumber || null,
    avatarUrl: profile.avatarUrl || null,
    ntfyTopic: profile.ntfyTopic || null,
    isActive: profile.isActive !== undefined ? profile.isActive : true,
    activationCode: profile.activationCode || null,
  });
}

async function verifyLogin(username, password) {
  const user = await db.getUserByUsername(username);
  if (!user) return null;

  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) return null;

  if (user.is_active === false) {
    const err = new Error('Account not activated');
    err.code = 'ACCOUNT_NOT_ACTIVATED';
    err.user = { user_id: user.user_id, username: user.username, full_name: user.full_name };
    throw err;
  }

  return { user_id: user.user_id, username: user.username, role: user.role };
}

async function updatePassword(userId, newPassword) {
  const hash = await bcrypt.hash(newPassword, 10);
  return db.updateUserPassword(userId, hash);
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

module.exports = { registerUser, verifyLogin, updatePassword, requireLogin, requireAdmin };