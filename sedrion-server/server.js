const express = require('express');
const session = require('express-session');
const path = require('path');
const { loadReliefRaster, sampleElevationRelief } = require('./raster');
const db = require('./db');
const auth = require('./auth');
require('./mqtt-listener');

const app = express();

// Change these if your files are named differently
const LOGIN_PAGE = '/login.html';
const DASHBOARD_FILE = 'index.html';

app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-only-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 8 }
}));
app.use(express.json());

// "/" -> dashboard if logged in, otherwise the login page.
// Must come BEFORE express.static, and static must have index:false,
// or the default page is served without checking login.
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
  await loadReliefRaster('../data/SRTM[alabang].tif');

  // ---------- Auth ----------
  app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'username and password required' });
    }
    try {
      // Role is always 'cleaner' here. Admins are promoted via the admin route below.
      const user = await auth.registerUser(username, password, 'cleaner');
      res.json(user);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    const user = await auth.verifyLogin(username, password);
    if (!user) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    req.session.user = user;
    res.json(user);
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

    let elevationRelative;
    try {
      elevationRelative = sampleElevationRelief(lat, lon);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    try {
      const site = await db.createSite({ name, lat, lon, elevationRelative });
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
      res.json(rows.reverse()); // oldest first for the chart
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

  // ---------- Nodes (tied to a site) ----------
  app.post('/api/sites/:siteId/nodes', auth.requireAdmin, async (req, res) => {
    const { siteId } = req.params;
    const { node_id, status } = req.body;

    if (!node_id) {
      return res.status(400).json({ error: 'node_id is required' });
    }

    try {
      const site = await db.getSiteById(siteId);
      if (!site) {
        return res.status(404).json({ error: 'Site not found' });
      }

      const node = await db.createNode({ nodeId: node_id, siteId, status: status || 'active' });
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

  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});