import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHmac } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

const root = fileURLToPath(new URL('./public/', import.meta.url));
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']]
]);

export function createPartyServer(options = {}) {
  const clients = new Map();
  const capacity = options.capacity ?? Number(process.env.MAX_PARTICIPANTS || 24);
  const config = () => {
    const iceServers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
    if (process.env.TURN_URLS && process.env.TURN_SECRET) {
      const username = `${Math.floor(Date.now() / 1000) + 86400}:mertz`;
      iceServers.push({ urls: process.env.TURN_URLS.split(',').map(s => s.trim()), username,
        credential: createHmac('sha1', process.env.TURN_SECRET).update(username).digest('base64') });
    }
    if (process.env.ICE_SERVERS_JSON) iceServers.push(...JSON.parse(process.env.ICE_SERVERS_JSON));
    return { iceServers };
  };
  config(); // Fail early on an invalid deployment configuration.
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self)');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); return res.end(); }
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/health' || path === '/api/config') {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/json');
      return res.end(req.method === 'HEAD' ? undefined : JSON.stringify(path === '/health' ? { ok: true } : config()));
    }
    const asset = assets.get(path);
    if (!asset) { res.writeHead(404); return res.end('Not found'); }
    try {
      const data = await readFile(root + asset[0]);
      res.setHeader('Content-Type', asset[1]);
      res.setHeader('Cache-Control', 'no-cache');
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch { res.writeHead(500); res.end('Unable to load the party. Please refresh.'); }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
  const send = (ws, data) => { if (ws.readyState === WebSocket.OPEN) {
    if (ws.bufferedAmount > 1024 * 1024) return ws.terminate();
    ws.send(JSON.stringify(data));
  } };
  const broadcast = (data, except) => { for (const [id, c] of clients) if (id !== except) send(c.ws, data); };
  const publicPeer = c => ({ id: c.id, name: c.name, state: c.state });
  server.on('upgrade', (req, socket, head) => {
    let validOrigin = false;
    try {
      const origin = new URL(req.headers.origin);
      validOrigin = process.env.PUBLIC_ORIGIN ? origin.origin === new URL(process.env.PUBLIC_ORIGIN).origin : origin.host === req.headers.host;
    } catch { /* Require a real same-origin browser connection. */ }
    if (new URL(req.url, 'http://localhost').pathname !== '/signal' || !validOrigin) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  });
  wss.on('connection', ws => {
    ws.alive = true;
    ws.on('pong', () => { ws.alive = true; });
    let client;
    let windowStart = Date.now(), messages = 0;
    const joinTimeout = setTimeout(() => { if (!client) ws.close(1008, 'Join timeout'); }, 10000);
    ws.on('message', raw => {
      if (Date.now() - windowStart > 10000) { windowStart = Date.now(); messages = 0; }
      if (++messages > 1200) return ws.close(1008, 'Too many messages');
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return ws.close(1008, 'Invalid JSON'); }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return;
      if (msg.type === 'join' && !client) {
        if (clients.size >= capacity) { send(ws, { type: 'full' }); return ws.close(1008, 'Party full'); }
        clearTimeout(joinTimeout);
        const id = randomUUID();
        client = { id, ws, name: `Manager ${id.slice(0, 4).toUpperCase()}`, state: { muted: true, cameraOff: true, sharing: false } };
        if (validState(msg.state)) client.state = msg.state;
        const peers = [...clients.values()].map(publicPeer);
        clients.set(id, client);
        send(ws, { type: 'welcome', self: publicPeer(client), peers });
        broadcast({ type: 'joined', peer: publicPeer(client) }, id);
      } else if (client && msg.type === 'state' && validState(msg.state)) {
        client.state = { muted: msg.state.muted, cameraOff: msg.state.cameraOff, sharing: msg.state.sharing };
        broadcast({ type: 'state', id: client.id, state: client.state }, client.id);
      } else if (client && msg.type === 'signal' && typeof msg.to === 'string') {
        const target = clients.get(msg.to);
        if (target && target !== client && validSignal(msg.data)) send(target.ws, { type: 'signal', from: client.id, data: msg.data });
      }
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      clearTimeout(joinTimeout);
      if (client && clients.delete(client.id)) broadcast({ type: 'left', id: client.id, name: client.name });
    });
  });
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.alive) { ws.terminate(); continue; }
      ws.alive = false; ws.ping();
    }
  }, 15000);
  heartbeat.unref();
  return { server, close: () => new Promise(resolve => {
    clearInterval(heartbeat);
    for (const ws of wss.clients) ws.terminate();
    wss.close(() => server.close(resolve));
  }) };
}
function validState(s) {
  return s && ['muted', 'cameraOff', 'sharing'].every(key => typeof s[key] === 'boolean') && Object.keys(s).length === 3;
}
function validSignal(s) {
  if (!s || typeof s !== 'object') return false;
  if (s.restart === true) return true;
  if (s.description) return ['offer', 'answer'].includes(s.description.type) && typeof s.description.sdp === 'string' && s.description.sdp.length < 60000;
  return s.candidate && typeof s.candidate.candidate === 'string' && s.candidate.candidate.length < 4096;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const party = createPartyServer();
  const port = Number(process.env.PORT || 3000);
  party.server.listen(port, '0.0.0.0', () => console.log(`Mertz Draft Party listening on port ${port}`));
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { party.close().then(() => process.exit(0)); });
}
