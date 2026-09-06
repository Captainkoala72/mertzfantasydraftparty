import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createPartyServer } from '../server.js';
let party, origin, address;
before(async () => {
  party = createPartyServer({ capacity: 3 });
  await new Promise(resolve => party.server.listen(0, '127.0.0.1', resolve));
  address = `127.0.0.1:${party.server.address().port}`;
  origin = `http://${address}`;
});
after(async () => party.close());
const state = { muted: false, cameraOff: false, sharing: false };
function wait(ws, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off('message', listener); reject(new Error(`Timed out waiting for ${type}`)); }, 2500);
    const listener = raw => { const data = JSON.parse(raw); if (data.type === type) { clearTimeout(timer); ws.off('message', listener); resolve(data); } };
    ws.on('message', listener);
  });
}
async function client() {
  const ws = new WebSocket(`ws://${address}/signal`, { origin });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  return ws;
}
async function join(ws) { const welcome = wait(ws, 'welcome'); ws.send(JSON.stringify({ type: 'join', state })); return welcome; }

test('serves the call and configuration with security headers', async () => {
  const page = await fetch(origin);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Mertz Invitational Draft Party/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const config = await fetch(origin + '/api/config');
  assert.equal(config.headers.get('cache-control'), 'no-store');
  assert.ok((await config.json()).iceServers.length);
  assert.equal((await fetch(origin + '/server.js')).status, 404);
  assert.equal((await fetch(origin + '/health')).status, 200);
});

test('three participants join one call; state, targeted signaling, leave and reconnect are accurate', async () => {
  const a = await client(), b = await client(), c = await client();
  try {
    const first = await join(a); assert.equal(first.peers.length, 0);
    const announcement = wait(a, 'joined');
    const second = await join(b);
    assert.equal(second.peers[0].id, first.self.id);
    assert.equal((await announcement).peer.id, second.self.id);
    const third = await join(c); assert.equal(third.peers.length, 2);
    const changed = wait(a, 'state');
    b.send(JSON.stringify({ type: 'state', state: { muted: true, cameraOff: true, sharing: true } }));
    assert.deepEqual((await changed).state, { muted: true, cameraOff: true, sharing: true });
    let leaked = false; c.on('message', raw => { if (JSON.parse(raw).type === 'signal') leaked = true; });
    const received = wait(b, 'signal');
    a.send(JSON.stringify({ type: 'signal', from: 'spoof', to: second.self.id, data: { description: { type: 'offer', sdp: 'test-sdp' } } }));
    const signal = await received;
    assert.equal(signal.from, first.self.id); assert.equal(signal.data.description.sdp, 'test-sdp');
    const overflow = await client(); const full = wait(overflow, 'full');
    overflow.send(JSON.stringify({ type: 'join', state })); await full; overflow.close();
    const left = wait(a, 'left'); b.close(); assert.equal((await left).id, second.self.id);
    const reconnected = await client();
    const fourth = await join(reconnected);
    assert.equal(fourth.peers.length, 2); assert.notEqual(fourth.self.id, second.self.id);
    assert.equal(leaked, false); reconnected.close();
  } finally { a.close(); b.close(); c.close(); }
});

test('rejects cross-origin WebSocket connections', async () => {
  const ws = new WebSocket(`ws://${address}/signal`, { origin: 'https://unrelated.example' });
  const status = await new Promise(resolve => {
    ws.once('unexpected-response', (_req, res) => { resolve(res.statusCode); res.resume(); ws.terminate(); });
    ws.on('error', () => {});
  });
  assert.equal(status, 403);
});

test('invalid JSON closes a connection without crashing the server', async () => {
  const ws = await client();
  const closed = new Promise(resolve => ws.once('close', code => resolve(code)));
  ws.send('{bad'); assert.equal(await closed, 1008);
  assert.equal((await fetch(origin + '/health')).status, 200);
});
