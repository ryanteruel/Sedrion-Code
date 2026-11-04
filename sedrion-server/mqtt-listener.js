const mqtt = require('mqtt');
const { insertReading } = require('./db');

const client = mqtt.connect('mqtt://localhost:1883');
const TOPIC = 'sedrion/nodes/data';

client.on('connect', () => {
  console.log('Connected to MQTT broker');
  client.subscribe(TOPIC, (err) => {
    if (err) console.error('Subscribe error:', err);
    else console.log(`Subscribed to ${TOPIC}`);
  });
});

client.on('message', async (topic, message) => {
  console.log(`Received on ${topic}:`, message.toString());
  try {
    const data = JSON.parse(message.toString());
    await insertReading({
      nodeId: data.nodeTag || data.nodeId,
      packetId: data.packetId,
      tofMm: data.tofMM ?? data.tof,
      rain: data.rain,
      rssi: data.rssi,
    });
  } catch (err) {
    console.error('Failed to parse/insert message:', err);
  }
});

client.on('error', (err) => console.error('MQTT error:', err));