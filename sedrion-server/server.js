const express = require('express');
const session = require('express-session');
const path = require('path');
const db = require('./db');
const auth = require('./auth');
const mailer = require('./mailer');
const { ensureBroker } = require('./start-broker');
ensureBroker();   // starts Mosquitto before the listener tries to connect
const { publishModeCommand } = require('./mqtt-listener');

const app = express();

const LOGIN_PAGE = '/login.html';
const DASHBOARD_FILE = 'dashboard.html';
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');

const uploadDir = path.join(__dirname, 'public', 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB max per photo
});


app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-only-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 8 }
}));
app.use(express.json());

app.get('/', (req, res) => {
  if (req.session.user) {
    res.sendFile(path.join(__dirname, 'public', DASHBOARD_FILE));
  } else {
    res.redirect(LOGIN_PAGE);
  }
});
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

const PORT = process.env.PORT || 3000;

async function start() {
  // ---------- Startup checks ----------
  // Same promise as the call at the top, so the broker is only started once.
  await ensureBroker();

  // Fail early with a clear message if PostgreSQL is not running.
  if (typeof db.query === 'function') {
    try {
      await db.query('SELECT 1');
    } catch (e) {
      console.error('Cannot reach PostgreSQL. Is the PostgreSQL service running?', e.message);
      process.exit(1);
    }
  }

  // ---------- Auth ----------
// ---------- Auth ----------
  const resetCodes = new Map();

  function generateSixDigitCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  app.post('/api/register', async (req, res) => {
    const { first_name, last_name, email, password } = req.body;
    if (!first_name || !last_name || !email || !password) {
      return res.status(400).json({ error: 'All fields are required.' });
    }
    try {
      const cleanEmail = email.trim().toLowerCase();
      const fullName = `${first_name.trim()} ${last_name.trim()}`;
      const nameSlug = first_name.trim().toLowerCase().replace(/[^a-z0-9]/g, '') || 'volunteer';
      const randomHex = crypto.randomBytes(3).toString('hex');
      const finalNtfyTopic = `sedrion-muntinlupa-${nameSlug}-${randomHex}`;
      const activationCode = generateSixDigitCode();

      const user = await auth.registerUser(cleanEmail, password, 'cleaner', {
        fullName,
        deploymentArea: 'Unassigned',
        contactNumber: null,
        avatarUrl: null,
        ntfyTopic: finalNtfyTopic,
        isActive: false,
        activationCode,
      });

      // Email #2: Send 6-digit activation code
      await mailer.sendActivationEmail({
        to: cleanEmail,
        firstName: first_name.trim(),
        code: activationCode,
      });

      res.json({
        requiresActivation: true,
        email: cleanEmail,
        ntfy_topic: user.ntfy_topic,
      });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/activate', async (req, res) => {
    const { email, code } = req.body;
    if (!email || !code) {
      return res.status(400).json({ error: 'Email and 6-digit activation code are required.' });
    }
    try {
      const cleanEmail = email.trim().toLowerCase();
      const user = await db.getUserByUsername(cleanEmail);
      if (!user) return res.status(404).json({ error: 'Account not found.' });

      if (user.is_active) {
        req.session.user = {
          user_id: user.user_id,
          username: user.username,
          role: user.role,
        };
        return res.json({ success: true, alreadyActive: true });
      }

      if (String(user.activation_code || '').trim() !== String(code).trim()) {
        return res.status(400).json({ error: 'Invalid 6-digit activation code.' });
      }

      const activated = await db.activateUser(user.user_id);

      const firstName = (activated.full_name || 'Volunteer').split(' ')[0];
      mailer.sendWelcomeEmail({
        to: cleanEmail,
        firstName,
        fullName: activated.full_name || firstName,
        ntfyTopic: activated.ntfy_topic,
      }).catch(mailErr => console.error('[WELCOME EMAIL ERROR]', mailErr.message));

      req.session.user = {
        user_id: activated.user_id,
        username: activated.username,
        role: activated.role,
      };

      res.json({ success: true, user: req.session.user, ntfy_topic: activated.ntfy_topic });
    } catch (err) {
      console.error('[ACTIVATE ERROR]', err);
      res.status(500).json({ error: err.message || 'Failed to activate account.' });
    }
  });
  app.post('/api/resend-activation', async (req, res) => {
    const cleanEmail = (req.body.email || '').trim().toLowerCase();
    if (!cleanEmail) return res.status(400).json({ error: 'Email is required.' });
    try {
      const user = await db.getUserByUsername(cleanEmail);
      if (!user) return res.status(404).json({ error: 'Account not found.' });
      if (user.is_active) return res.status(400).json({ error: 'Account is already activated.' });

      const newCode = generateSixDigitCode();
      await db.setActivationCode(user.user_id, newCode);

      const firstName = (user.full_name || 'Volunteer').split(' ')[0];
      await mailer.sendActivationEmail({
        to: cleanEmail,
        firstName,
        code: newCode,
      });

      res.json({ success: true });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to resend activation code.' });
    }
  });

  app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
      const user = await auth.verifyLogin(username, password);
      if (!user) {
        return res.status(401).json({ error: 'Invalid username or password' });
      }
      req.session.user = user;
      res.json(user);
    } catch (err) {
      if (err.code === 'ACCOUNT_NOT_ACTIVATED') {
        return res.status(403).json({
          error: 'Account not activated yet. Check your email for the 6-digit code.',
          code: 'ACCOUNT_NOT_ACTIVATED',
          email: err.user.username,
        });
      }
      res.status(500).json({ error: 'Login failed' });
    }
  });

  // Email #3: Forgot Password -> Sends 6-digit code -> Entering code logs user in
  app.post('/api/forgot-password', async (req, res) => {
    const cleanEmail = (req.body.email || '').trim().toLowerCase();
    if (!cleanEmail) return res.status(400).json({ error: 'Please enter your email address.' });

    try {
      const user = await db.getUserByUsername(cleanEmail);
      if (!user) {
        return res.status(404).json({ error: 'No account found with that email address.' });
      }

      const code = generateSixDigitCode();
      resetCodes.set(cleanEmail, {
        userId: user.user_id,
        username: user.username,
        role: user.role,
        code,
        expiresAt: Date.now() + 10 * 60 * 1000, // 10 minutes
      });

      const firstName = (user.full_name || 'Volunteer').split(' ')[0];
      await mailer.sendForgotPasswordEmail({
        to: cleanEmail,
        firstName,
        code,
      });

      res.json({ success: true, email: cleanEmail });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to send recovery email.' });
    }
  });

  app.post('/api/forgot-password/verify', async (req, res) => {
    const cleanEmail = (req.body.email || '').trim().toLowerCase();
    const code = (req.body.code || '').trim();
    const newPassword = req.body.new_password || '';

    if (!cleanEmail || !code) {
      return res.status(400).json({ error: 'Email and 6-digit code are required.' });
    }

    const entry = resetCodes.get(cleanEmail);
    if (!entry || entry.code !== code) {
      return res.status(400).json({ error: 'Invalid 6-digit code.' });
    }
    if (Date.now() > entry.expiresAt) {
      resetCodes.delete(cleanEmail);
      return res.status(400).json({ error: 'Code expired. Please request a new one.' });
    }

    try {
      if (newPassword.trim()) {
        await auth.updatePassword(entry.userId, newPassword.trim());
      }

      resetCodes.delete(cleanEmail);

      // Log the user directly into their session
      req.session.user = {
        user_id: entry.userId,
        username: entry.username,
        role: entry.role,
      };

      res.json({ success: true, user: req.session.user });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to verify code.' });
    }
  });

  app.post('/api/logout', (req, res) => {
    req.session.destroy(() => {
      res.json({ success: true });
    });
  });

  app.get('/api/me', auth.requireLogin, (req, res) => {
    res.json(req.session.user);
  });

  // ---------- Admin: manage user roles ----------
  app.get('/api/users', auth.requireAdmin, async (req, res) => {
    const users = await db.getAllUsers();
    res.json(users);
  });

  app.patch('/api/users/:userId/role', auth.requireAdmin, async (req, res) => {
    const { role } = req.body;
    if (!['admin', 'cleaner'].includes(role)) {
      return res.status(400).json({ error: 'role must be admin or cleaner' });
    }
    const updated = await db.updateUserRole(req.params.userId, role);
    res.json(updated);
  });

  // ---------- Sites ----------
  app.get('/api/sites', auth.requireLogin, async (req, res) => {
    try {
      const sites = await db.getAllSites();
      res.json(sites);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to fetch sites' });
    }
  });

  app.post('/api/sites', auth.requireAdmin, async (req, res) => {
    const { name, lat, lon } = req.body;
    if (!name || lat === undefined || lon === undefined) {
      return res.status(400).json({ error: 'name, lat, and lon are required' });
    }
    try {
      const site = await db.createSite({ name, lat, lon, elevationRelative: null });
      res.json(site);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to create site' });
    }
  });

  // ---------- Site detail ----------
  app.get('/api/sites/:siteId', auth.requireLogin, async (req, res) => {
    try {
      const id = parseInt(req.params.siteId, 10);
      if (isNaN(id)) return res.status(400).json({ error: 'Invalid site id' });
      const site = await db.getSiteById(id);
      if (!site) return res.status(404).json({ error: 'Site not found' });
      const [latest, prediction, lastClear, nodes] = await Promise.all([
        db.getLatestReadingForSite(id),
        db.getLatestPredictionForSite(id),
        db.getLastClearForSite(id),
        db.getNodesForSite(id),
      ]);
      res.json({ site, latest: latest || null, prediction: prediction || null, lastClear: lastClear || null, nodes });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to fetch site' });
    }
  });

  app.get('/api/sites/:siteId/readings', auth.requireLogin, async (req, res) => {
    try {
      const id = parseInt(req.params.siteId, 10);
      if (isNaN(id)) return res.status(400).json({ error: 'Invalid site id' });
      const limit = Math.min(parseInt(req.query.limit, 10) || 100, 1000);
      const rows = await db.getReadingHistoryForSite(id, limit);
      res.json(rows.reverse());
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to fetch readings' });
    }
  });

  // ---------- Mark cleared ----------
  app.post('/api/sites/:siteId/clear', auth.requireLogin, async (req, res) => {
    try {
      const event = await db.insertClearEvent({
        siteId: req.params.siteId,
        clearedBy: req.session.user.username
      });
      res.json(event);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to log clear event' });
    }
  });

  // ---------- Assign a cleaner ----------
  app.post('/api/sites/:siteId/assign', auth.requireAdmin, async (req, res) => {
    const { assignedTo } = req.body;
    if (!assignedTo) return res.status(400).json({ error: 'assignedTo (user_id) required' });
    try {
      const assignment = await db.createAssignment({
        siteId: req.params.siteId,
        assignedTo,
        assignedBy: req.session.user.user_id
      });
      res.json(assignment);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to create assignment' });
    }
  });

  // ---------- Cleaner: view/complete their assignments ----------
  app.get('/api/my-assignments', auth.requireLogin, async (req, res) => {
    const rows = await db.getPendingAssignmentsForUser(req.session.user.user_id);
    res.json(rows);
  });

  app.post('/api/assignments/:id/complete', auth.requireLogin, async (req, res) => {
    const updated = await db.completeAssignment(req.params.id);
    res.json(updated);
  });

  // ---------- Nodes & Mode Switching ----------
  app.get('/api/nodes', auth.requireLogin, async (req, res) => {
    try {
      const nodes = await db.getAllNodes();
      res.json(nodes);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to fetch nodes' });
    }
  });

  app.post('/api/sites/:siteId/nodes', auth.requireAdmin, async (req, res) => {
    const { siteId } = req.params;
    const { node_id, device_id, status } = req.body;

    if (!node_id) {
      return res.status(400).json({ error: 'node_id (nodeTag) is required' });
    }

    try {
      const site = await db.getSiteById(siteId);
      if (!site) return res.status(404).json({ error: 'Site not found' });

      const node = await db.createNode({
        nodeId: node_id.trim(),
        deviceId: device_id ? parseInt(device_id, 10) : null,
        siteId,
        status: status || 'active'
      });
      res.json(node);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to create node', detail: err.message });
    }
  });

  app.get('/api/sites/:siteId/nodes', auth.requireLogin, async (req, res) => {
    try {
      const nodes = await db.getNodesForSite(req.params.siteId);
      res.json(nodes);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to fetch nodes' });
    }
  });
  app.delete('/api/sites/:siteId', auth.requireAdmin, async (req, res) => {
    try {
      const id = parseInt(req.params.siteId, 10);
      if (isNaN(id)) return res.status(400).json({ error: 'Invalid site id' });
      const deleted = await db.deleteSite(id);
      if (!deleted) return res.status(404).json({ error: 'Site not found' });
      res.json({ success: true, deleted });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to delete site' });
    }
  });

  app.post('/api/sites/:siteId/photo', auth.requireAdmin, upload.single('photo'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No photo uploaded' });
      const ext = path.extname(req.file.originalname) || '.jpg';
      const newFilename = `site_${req.params.siteId}_${Date.now()}${ext}`;
      fs.renameSync(req.file.path, path.join(uploadDir, newFilename));

      const imageUrl = `/uploads/${newFilename}`;
      const updated = await db.updateSiteImage(req.params.siteId, imageUrl);
      res.json(updated);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to upload photo' });
    }
  });

  app.delete('/api/sites/:siteId/photo', auth.requireAdmin, async (req, res) => {
    try {
      const site = await db.getSiteById(req.params.siteId);
      if (!site) return res.status(404).json({ error: 'Site not found' });

      if (site.image_url) {
        const filePath = path.join(__dirname, 'public', site.image_url);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      }

      const updated = await db.updateSiteImage(req.params.siteId, null);
      res.json(updated);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to delete photo' });
    }
  });

  // Admin: Switch node between 'operational' (LoRa mesh) and 'charging' (ESP-NOW)
  app.post('/api/nodes/:nodeId/mode', auth.requireAdmin, async (req, res) => {
    const { mode } = req.body;
    if (!['operational', 'charging'].includes(mode)) {
      return res.status(400).json({ error: 'mode must be operational or charging' });
    }

    try {
      const existing = await db.getNodeById(req.params.nodeId);
      if (!existing) return res.status(404).json({ error: 'Node not found' });

      const updated = await db.setNodeMode(existing.node_id, mode);
      publishModeCommand({
        nodeId: existing.node_id,
        deviceId: existing.device_id,
        mode,
      });

      res.json(updated);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Failed to switch node mode' });
    }
  });

  app.listen(PORT, () => console.log(`Sedrion server running on http://localhost:${PORT}`));
}

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});