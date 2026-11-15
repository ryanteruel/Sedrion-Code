const mqtt = require('mqtt');
const { insertReading, updateNodeTelemetry } = require('./db');

const client = mqtt.connect(process.env.MQTT_URL || 'mqtt://localhost:1883');
const DATA_TOPIC = 'sedrion/nodes/data';
const BATTERY_TOPIC = 'sedrion/nodes/battery';
const CMD_TOPIC = 'sedrion/nodes/cmd';

// Which gateway field identifies a node in your `nodes` table?
//   'node_id'  -> "NODE_03" (built from each board's DEVICE_ID; present on BOTH topics)
//   'node_tag' -> "A1"      (only present on the data topic, so battery updates would not match)
const ID_FIELD = 'node_id';

// The gateway sends snake_case (node_id, tof_mm, ...). Older camelCase names still work.
const pick = (d, ...keys) => {
  for (const k of keys) if (d[k] !== undefined && d[k] !== null) return d[k];
  return null;
};

function getNodeId(d) {
  return ID_FIELD === 'node_tag'
    ? pick(d, 'node_tag', 'nodeTag', 'node_id', 'nodeId')
    : pick(d, 'node_id', 'nodeId', 'node_tag', 'nodeTag');
}

client.on('connect', () => {
  console.log('Connected to MQTT broker');
  client.subscribe([DATA_TOPIC, BATTERY_TOPIC], (err) => {
    if (err) console.error('Subscribe error:', err);
    else console.log(`Subscribed to ${DATA_TOPIC} & ${BATTERY_TOPIC}`);
  });
});

client.on('message', async (topic, message) => {
  const raw = message.toString();
  console.log(`Received on ${topic}:`, raw);
  try {
    const d = JSON.parse(raw);
    const nodeId = getNodeId(d);
    if (!nodeId) {
      console.warn('Dropped: no node id in message');
      return;
    }
    const deviceId = pick(d, 'device_id', 'senderID', 'deviceId');
    const batteryMv = pick(d, 'battery_mv', 'batteryMV');

    if (topic === DATA_TOPIC) {
      const tofMm = pick(d, 'tof_mm', 'tofMM', 'tof');
      const packetId = pick(d, 'packet_id', 'packetId', 'packetID');
      // Skip failed ToF reads (-1) and malformed packets instead of storing junk
      if (tofMm == null || tofMm < 0 || packetId == null) {
        console.warn('Dropped: invalid ToF or packet id');
        return;
      }
      await insertReading({
        nodeId,
        deviceId,
        packetId,
        tofMm,
        rain: pick(d, 'rain') ?? 0,
        batteryMv,
        rssi: pick(d, 'rssi'),
      });
    } else if (topic === BATTERY_TOPIC) {
      // Use the mode the node actually reported (the gateway sends this on every packet)
      await updateNodeTelemetry({
        nodeId,
        deviceId,
        mode: pick(d, 'mode') || 'operational',
        batteryMv,
        macAddr: pick(d, 'mac'),
      });
    }
  } catch (err) {
    console.error('Failed to parse/process MQTT message:', err);
  }
});

client.on('error', (err) => console.error('MQTT error:', err));

// Mode switch command: dashboard -> gateway -> field node.
// The gateway reads "device_id" (or "node_id" like "NODE_03") and "mode".
function publishModeCommand({ nodeId, deviceId, mode }) {
  const payload = JSON.stringify({
    device_id: deviceId || 0,
    node_id: nodeId,
    mode, // 'operational' or 'charging'
  });
  client.publish(CMD_TOPIC, payload, { qos: 1 }, (err) => {
    if (err) console.error('Failed to publish mode command:', err);
    else console.log(`Published to ${CMD_TOPIC}:`, payload);
  });
}

module.exports = { client, publishModeCommand };