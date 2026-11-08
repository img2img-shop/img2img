// Development auto-reload: watches the extension folder and tells the unpacked extension to reload
// itself (background.js connects to ws://127.0.0.1:35729 when installed unpacked).
// Usage: node tools/dev-reload.js
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const PORT = 35729;
// Only the extension's own folder: README, the server, the ComfyUI nodes and tools don't need a reload
const ROOT = path.resolve(__dirname, '..', 'extension');
// Chrome's own _metadata folder changes when Chrome writes to it, not when we do
const IGNORED = /^_metadata([\\/]|$)/;
const clients = new Set();

// Minimal WebSocket server: handshake plus unmasked text frames (server -> client only)
const server = http.createServer((req, res) => res.end('img2img dev reload server\n'));
server.on('upgrade', (req, socket) => {
  const accept = crypto.createHash('sha1')
    .update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
  clients.add(socket);
  console.log(`extension connected (${clients.size})`);
  socket.on('data', () => {}); // ignore client frames
  socket.on('close', () => clients.delete(socket));
  socket.on('error', () => clients.delete(socket));
});

function send(text) {
  const payload = Buffer.from(text);
  const frame = Buffer.concat([Buffer.from([0x81, payload.length]), payload]); // FIN + text, length < 126
  for (const socket of clients) socket.write(frame);
}

// Ping regularly: an extension service worker stays alive while its WebSocket is active
setInterval(() => send('ping'), 20000);

// Loop guard: if Chrome writes into the extension folder when it reloads (as it does in _metadata), every
// reload would trigger the next one and refresh the browser endlessly. Too many reloads in a short time
// pause reloading until the watcher is restarted, naming the file that kept changing.
const LOOP_LIMIT = 5;
const LOOP_WINDOW_MS = 20000;
const recentReloads = [];
let paused = false;

let timer = null;
fs.watch(ROOT, { recursive: true }, (event, file) => {
  if (!file || IGNORED.test(file) || paused) return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    const now = Date.now();
    while (recentReloads.length && now - recentReloads[0] > LOOP_WINDOW_MS) recentReloads.shift();
    if (recentReloads.length >= LOOP_LIMIT) {
      paused = true;
      console.log(`${new Date().toLocaleTimeString()} ${LOOP_LIMIT} reloads in ${LOOP_WINDOW_MS / 1000}s, last for ${file}: looks like a reload loop, so reloading is paused. Add that file to IGNORED if Chrome writes it, then restart this script.`);
      return;
    }
    recentReloads.push(now);
    console.log(`${new Date().toLocaleTimeString()} ${file} changed -> reload (${clients.size} connected)`);
    send('reload');
  }, 1500); // one reload per burst of edits, so the active tab isn't refreshed repeatedly
});

server.listen(PORT, '127.0.0.1', () => console.log(`Watching ${ROOT}; dev reload server on ws://127.0.0.1:${PORT}`));
