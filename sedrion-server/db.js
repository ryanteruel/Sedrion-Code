const { Pool } = require('pg');

const pool = new Pool({
  host: 'localhost',
  port: 5432,
  database: 'sedrion',
  user: 'postgres',
  password: process.env.PGPASSWORD,
});

async function query(text, params) {
  return pool.query(text, params);
}

// ---------- Users ----------
async function updateUserRole(userId, newRole) {
  const result = await pool.query(
    `UPDATE users SET role = $1 WHERE user_id = $2 RETURNING user_id, username, role`,
    [newRole, userId]
  );
  return result.rows[0];
}

async function getAllUsers() {
  const result = await pool.query(
    `SELECT u.user_id, u.username, u.role, u.full_name, u.deployment_area, u.contact_number, u.avatar_url, u.ntfy_topic, u.created_at,
            COUNT(a.id) FILTER (WHERE a.status != 'completed')::int AS active_tasks
     FROM users u
     LEFT JOIN assignments a ON a.assigned_to = u.user_id
     GROUP BY u.user_id
     ORDER BY u.deployment_area ASC, u.username ASC`
  );
  return result.rows;
}

async function getUserByUsername(username) {
  const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
  return result.rows[0];
}

async function createUser({ username, passwordHash, role = 'cleaner', fullName = null, deploymentArea = 'Unassigned', contactNumber = null, avatarUrl = null, ntfyTopic = null, isActive = true, activationCode = null }) {
  const result = await pool.query(
    `INSERT INTO users (username, password_hash, role, full_name, deployment_area, contact_number, avatar_url, ntfy_topic, is_active, activation_code)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING user_id, username, role, full_name, deployment_area, contact_number, avatar_url, ntfy_topic, is_active, created_at`,
    [username, passwordHash, role, fullName, deploymentArea, contactNumber, avatarUrl, ntfyTopic, isActive, activationCode]
  );
  return result.rows[0];
}

async function activateUser(userId) {
  const result = await pool.query(
    `UPDATE users SET is_active = TRUE, activation_code = NULL
     WHERE user_id = $1
     RETURNING user_id, username, role, full_name, ntfy_topic, is_active`,
    [userId]
  );
  return result.rows[0];
}

async function setActivationCode(userId, code) {
  const result = await pool.query(
    `UPDATE users SET activation_code = $1 WHERE user_id = $2 RETURNING user_id, username`,
    [code, userId]
  );
  return result.rows[0];
}

async function updateUserPassword(userId, passwordHash) {
  const result = await pool.query(
    `UPDATE users SET password_hash = $1 WHERE user_id = $2 RETURNING user_id, username`,
    [passwordHash, userId]
  );
  return result.rows[0];
}

// ---------- Sites ----------
async function createSite({ name, lat, lon, elevationRelative = null }) {
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

async function deleteSite(siteId) {
  await pool.query('DELETE FROM sensor_readings WHERE site_id = $1', [siteId]);
  await pool.query('DELETE FROM maintenance_events WHERE site_id = $1', [siteId]);
  await pool.query('DELETE FROM predictions WHERE site_id = $1', [siteId]);
  await pool.query('DELETE FROM assignments WHERE site_id = $1', [siteId]);
  await pool.query('DELETE FROM nodes WHERE site_id = $1', [siteId]);
  const result = await pool.query(
    `DELETE FROM sites WHERE site_id = $1 RETURNING *`,
    [siteId]
  );
  return result.rows[0];
}
async function updateSiteImage(siteId, imageUrl) {
  const result = await pool.query(
    `UPDATE sites SET image_url = $1 WHERE site_id = $2 RETURNING *`,
    [imageUrl, siteId]
  );
  return result.rows[0];
}

// ---------- Nodes ----------
async function createNode({ nodeId, deviceId = null, siteId, status = 'active' }) {
  const result = await pool.query(
    `INSERT INTO nodes (node_id, device_id, site_id, status, mode)
     VALUES ($1, $2, $3, $4, 'operational')
     ON CONFLICT (node_id) DO UPDATE
       SET device_id = COALESCE(EXCLUDED.device_id, nodes.device_id),
           site_id = EXCLUDED.site_id,
           status = EXCLUDED.status
     RETURNING *`,
    [nodeId, deviceId, siteId, status]
  );
  return result.rows[0];
}

async function getNodeById(nodeId) {
  const result = await pool.query('SELECT * FROM nodes WHERE node_id = $1', [nodeId]);
  return result.rows[0];
}

async function getAllNodes() {
  const result = await pool.query(
    `SELECT n.*, s.name AS site_name
     FROM nodes n
     LEFT JOIN sites s ON n.site_id = s.site_id
     ORDER BY n.node_id`
  );
  return result.rows;
}

async function getSiteIdForNode(nodeId) {
  const result = await pool.query('SELECT site_id FROM nodes WHERE node_id = $1', [nodeId]);
  return result.rows[0]?.site_id || null;
}

async function getNodesForSite(siteId) {
  const result = await pool.query('SELECT * FROM nodes WHERE site_id = $1 ORDER BY node_id', [siteId]);
  return result.rows;
}

async function setNodeMode(nodeId, mode) {
  const result = await pool.query(
    `UPDATE nodes SET mode = $1 WHERE node_id = $2 RETURNING *`,
    [mode, nodeId]
  );
  return result.rows[0];
}

async function updateNodeTelemetry({ nodeId, deviceId = null, mode, batteryMv, macAddr = null }) {
  await pool.query(
    `UPDATE nodes
     SET mode = COALESCE($1, mode),
         battery_mv = COALESCE($2, battery_mv),
         device_id = COALESCE($3, device_id),
         mac_addr = COALESCE($4, mac_addr),
         last_seen = NOW()
     WHERE node_id = $5`,
    [mode, batteryMv ?? null, deviceId, macAddr, nodeId]
  );
}

// ---------- Sensor Readings ----------
async function insertReading({ nodeId, deviceId = null, packetId, tofMm, rain, batteryMv = null, rssi }) {
  const siteId = await getSiteIdForNode(nodeId);

  if (!siteId) {
    console.error(`No site registered for node ${nodeId} — reading discarded`);
    return;
  }

  try {
    await pool.query(
      `INSERT INTO sensor_readings (node_id, site_id, packet_id, tof_mm, rain, battery_mv, rssi)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [nodeId, siteId, packetId, tofMm, rain, batteryMv, rssi]
    );

    await updateNodeTelemetry({
      nodeId,
      deviceId,
      mode: 'operational',
      batteryMv,
    });

    console.log(`Inserted reading for node ${nodeId} (site ${siteId}) | Bat: ${batteryMv ?? 'N/A'} mV`);
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

// ---------- Maintenance & Predictions ----------
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

// ---------- Assignments ----------
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

async function updateSiteImage(siteId, imageUrl) {
  const result = await pool.query(
    `UPDATE sites SET image_url = $1 WHERE site_id = $2 RETURNING *`,
    [imageUrl, siteId]
  );
  return result.rows[0];
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
  query, activateUser, setActivationCode, updateUserPassword,
  updateUserRole, getAllUsers, getUserByUsername, createUser,
  createSite, getAllSites, getSiteById, deleteSite, updateSiteImage,
  createNode, getNodeById, getAllNodes, getSiteIdForNode, getNodesForSite,
  setNodeMode, updateNodeTelemetry,
  insertReading, getLatestReadingForSite, getReadingHistoryForSite,
  insertClearEvent, getLastClearForSite,
  getLatestPredictionForSite,
  createAssignment, getPendingAssignmentsForUser, completeAssignment,
};