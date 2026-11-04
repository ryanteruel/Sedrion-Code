const { Pool } = require('pg');

const pool = new Pool({
  host: 'localhost',
  port: 5432,
  database: 'sedrion',
  user: 'postgres',
  password: 'ruru0431',
});

async function query(text, params) {
  return pool.query(text, params);
}
async function updateUserRole(userId, newRole) {
  const result = await pool.query(
    `UPDATE users SET role = $1 WHERE user_id = $2 RETURNING user_id, username, role`,
    [newRole, userId]
  );
  return result.rows[0];
}

async function getAllUsers() {
  const result = await pool.query('SELECT user_id, username, role, created_at FROM users ORDER BY user_id');
  return result.rows;
}
async function createSite({ name, lat, lon, elevationRelative }) {
  const result = await pool.query(
    `INSERT INTO sites (name, lat, lon, elevation_relative)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [name, lat, lon, elevationRelative]
  );
  return result.rows[0];
}

async function getAllSites() {
  const result = await pool.query('SELECT * FROM sites ORDER BY site_id');
  return result.rows;
}

async function getSiteById(siteId) {
  const result = await pool.query('SELECT * FROM sites WHERE site_id = $1', [siteId]);
  return result.rows[0];
}

async function createNode({ nodeId, siteId, status = 'active' }) {
  const result = await pool.query(
    `INSERT INTO nodes (node_id, site_id, status)
     VALUES ($1, $2, $3) RETURNING *`,
    [nodeId, siteId, status]
  );
  return result.rows[0];
}

async function getSiteIdForNode(nodeId) {
  const result = await pool.query('SELECT site_id FROM nodes WHERE node_id = $1', [nodeId]);
  return result.rows[0]?.site_id || null;
}

async function getNodesForSite(siteId) {
  const result = await pool.query('SELECT * FROM nodes WHERE site_id = $1', [siteId]);
  return result.rows;
}

async function insertReading({ nodeId, packetId, tofMm, rain, rssi }) {
  const siteId = await getSiteIdForNode(nodeId);

  if (!siteId) {
    console.error(`No site registered for node ${nodeId} — reading discarded`);
    return;
  }

  try {
    await pool.query(
      `INSERT INTO sensor_readings (node_id, site_id, packet_id, tof_mm, rain, rssi)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [nodeId, siteId, packetId, tofMm, rain, rssi]
    );
    console.log('Inserted reading for node', nodeId, '(site', siteId + ')');
  } catch (err) {
    console.error('DB insert error:', err);
  }
}

async function getLatestReadingForSite(siteId) {
  const result = await pool.query(
    `SELECT * FROM sensor_readings WHERE site_id = $1 ORDER BY time DESC LIMIT 1`,
    [siteId]
  );
  return result.rows[0];
}

async function getReadingHistoryForSite(siteId, limit = 100) {
  const result = await pool.query(
    `SELECT * FROM sensor_readings WHERE site_id = $1 ORDER BY time DESC LIMIT $2`,
    [siteId, limit]
  );
  return result.rows;
}

async function insertClearEvent({ siteId, clearedBy }) {
  const result = await pool.query(
    `INSERT INTO maintenance_events (site_id, cleared_at, operator)
     VALUES ($1, NOW(), $2) RETURNING *`,
    [siteId, clearedBy]
  );
  return result.rows[0];
}

async function getLastClearForSite(siteId) {
  const result = await pool.query(
    `SELECT * FROM maintenance_events WHERE site_id = $1 ORDER BY cleared_at DESC LIMIT 1`,
    [siteId]
  );
  return result.rows[0];
}

async function getLatestPredictionForSite(siteId) {
  const result = await pool.query(
    `SELECT * FROM predictions WHERE site_id = $1 ORDER BY predicted_at DESC LIMIT 1`,
    [siteId]
  );
  return result.rows[0];
}

async function getUserByUsername(username) {
  const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
  return result.rows[0];
}

async function createUser({ username, passwordHash, role }) {
  const result = await pool.query(
    `INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING user_id, username, role`,
    [username, passwordHash, role]
  );
  return result.rows[0];
}

async function createAssignment({ siteId, assignedTo, assignedBy }) {
  const result = await pool.query(
    `INSERT INTO assignments (site_id, assigned_to, assigned_by)
     VALUES ($1, $2, $3) RETURNING *`,
    [siteId, assignedTo, assignedBy]
  );
  return result.rows[0];
}

async function getPendingAssignmentsForUser(userId) {
  const result = await pool.query(
    `SELECT a.*, s.name AS site_name, s.lat, s.lon
     FROM assignments a
     JOIN sites s ON a.site_id = s.site_id
     WHERE a.assigned_to = $1 AND a.status != 'completed'
     ORDER BY a.assigned_at DESC`,
    [userId]
  );
  return result.rows;
}

async function completeAssignment(assignmentId) {
  const result = await pool.query(
    `UPDATE assignments SET status = 'completed', completed_at = NOW()
     WHERE id = $1 RETURNING *`,
    [assignmentId]
  );
  return result.rows[0];
}

module.exports = {
  query,
  createSite, getAllSites, getSiteById,
  createNode, getSiteIdForNode, getNodesForSite,
  insertReading, getLatestReadingForSite, getReadingHistoryForSite,
  insertClearEvent, getLastClearForSite,
  getLatestPredictionForSite,
  getUserByUsername, createUser,
  createAssignment, getPendingAssignmentsForUser, completeAssignment,
};