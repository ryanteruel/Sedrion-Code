// Starts the Mosquitto broker automatically when the server starts.
// If a broker is already listening on port 1883 (e.g. the Windows service), it does nothing.
const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 1883;
const EXE = process.env.MOSQUITTO_EXE || 'C:\\Program Files\\mosquitto\\mosquitto.exe';
// Own config next to this file, so it never depends on the system mosquitto.conf:
// listen on every interface (the gateway connects over Wi-Fi) and allow anonymous clients.
const LOCAL_CONF = path.join(__dirname, 'mosquitto.local.conf');
const VERBOSE = process.env.BROKER_VERBOSE === '1';

let child = null;

function portOpen(port = PORT, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const s = net.createConnection({ port, host });
    s.setTimeout(800);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('timeout', () => { s.destroy(); resolve(false); });
    s.once('error', () => resolve(false));
  });
}

async function waitForPort(ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await portOpen()) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function stopBroker() {
  if (child && !child.killed) child.kill();
}

async function startBroker() {
  if (await portOpen()) {
    console.log('[broker] Mosquitto already running on port 1883');
    return true;
  }

  if (!fs.existsSync(EXE)) {
    console.error(`[broker] mosquitto.exe not found at ${EXE}`);
    console.error('[broker] Install Mosquitto, or set MOSQUITTO_EXE to its full path.');
    return false;
  }

  fs.writeFileSync(LOCAL_CONF, 'listener 1883 0.0.0.0\nallow_anonymous true\n');

  child = spawn(EXE, ['-c', LOCAL_CONF, '-v'], { windowsHide: true });

  const show = (buf) => {
    for (const line of buf.toString().split(/\r?\n/)) {
      if (!line.trim()) continue;
      // Only connection events and problems by default (set BROKER_VERBOSE=1 for everything)
      if (VERBOSE || /New connection|New client|disconnect|rror|denied|refus|in use/i.test(line)) {
        console.log('[broker]', line.replace(/^\d+:\s*/, ''));
      }
    }
  };
  child.stdout.on('data', show);
  child.stderr.on('data', show);
  child.on('error', (err) => console.error('[broker] failed to start:', err.message));
  child.on('exit', (code) => console.log(`[broker] stopped (code ${code})`));

  // Stop the broker together with the server
  process.on('exit', stopBroker);
  process.on('SIGINT', () => { stopBroker(); process.exit(0); });
  process.on('SIGTERM', () => { stopBroker(); process.exit(0); });

  const up = await waitForPort();
  console.log(up ? '[broker] Mosquitto started on port 1883'
                 : '[broker] Mosquitto did not start listening on port 1883');
  return up;
}

// Safe to call more than once: the broker is only started a single time.
let starting = null;
function ensureBroker() {
  if (!starting) starting = startBroker();
  return starting;
}

module.exports = { ensureBroker, stopBroker };