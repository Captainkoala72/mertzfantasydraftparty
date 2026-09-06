const icons = {
  mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/>',
  micOff: '<path d="m3 3 18 18M9 9v3a3 3 0 0 0 5 2M9 5a3 3 0 0 1 6 0v4M5 10v2a7 7 0 0 0 12 5m2-7v2M12 19v3m-4 0h8"/>',
  camera: '<rect x="2" y="5" width="14" height="14" rx="3"/><path d="m16 9 6-3v12l-6-3"/>',
  cameraOff: '<path d="m3 3 18 18M8 5h5a3 3 0 0 1 3 3v1l6-3v12l-4-2M16 16a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V8c0-1 .5-2 1-2"/>',
  screen: '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8m-4-4v4m0-8V7m-3 3 3-3 3 3"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/><circle cx="9" cy="7" r="4"/>',
  phone: '<path d="M3 15v-4c5-5 13-5 18 0v4l-5 1v-4a13 13 0 0 0-8 0v4z"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4m-4 5v2"/>',
  audio: '<path d="M4 10v4m4-8v12m4-15v18m4-15v12m4-8v4"/>'
};
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name]}</svg>`;
for (const el of document.querySelectorAll('[data-icon]')) el.innerHTML = icon(el.dataset.icon);
const $ = id => document.getElementById(id);
const peers = new Map();
let socket, selfId, rtcConfig, localStream = new MediaStream(), displayStream;
let active = true, joined = false, joining = false, generation = 0, retryTimer, reconnectAttempt = 0, startedAt;
let mediaState = { muted: true, cameraOff: true, sharing: false };
const localCard = $('localCard');
const screenSupported = !!navigator.mediaDevices?.getDisplayMedia;

function notice(message, label, action) {
  $('notice').hidden = !message;
  $('noticeText').textContent = message;
  $('noticeAction').hidden = !label;
  $('noticeAction').textContent = label || '';
  $('noticeAction').onclick = action || null;
}
function toast(message) {
  const el = document.createElement('div'); el.className = 'toast'; el.textContent = message;
  $('toasts').append(el); setTimeout(() => el.remove(), 4200);
  if ($('toasts').children.length > 3) $('toasts').firstElementChild.remove();
}
function connection(text, online = false) {
  $('connectionText').textContent = text;
  $('connectionDot').className = `connection-dot ${online ? 'online' : 'offline'}`;
}
function send(data) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data)); }
function stateChanged() { renderLocal(); if (joined) send({ type: 'state', state: mediaState }); }
function control(id, enabled, onIcon, offIcon, onLabel, offLabel) {
  const button = $(id);
  button.setAttribute('aria-pressed', String(enabled));
  button.classList.toggle('off', !enabled);
  button.querySelector('.control-icon').innerHTML = icon(enabled ? onIcon : offIcon);
  button.querySelector('.control-label').textContent = enabled ? onLabel : offLabel;
  button.setAttribute('aria-label', enabled ? onLabel : offLabel);
}
function renderLocal() {
  $('localVideo').srcObject = localStream;
  $('localPlaceholder').hidden = !mediaState.cameraOff;
  $('localMuted').hidden = !mediaState.muted;
  $('localMessage').textContent = !active ? 'You left the party' : 'Camera is off';
  $('localHint').textContent = active ? 'Your seat is still at the table' : 'Come back for the next pick';
  $('localSubtext').textContent = joined ? (mediaState.muted ? 'Muted' : 'In the party') : active ? 'Connecting' : 'Offline';
  control('micButton', !mediaState.muted, 'mic', 'micOff', 'Mute', 'Unmute');
  control('cameraButton', !mediaState.cameraOff, 'camera', 'cameraOff', 'Camera off', 'Camera on');
  const share = $('shareButton');
  share.setAttribute('aria-pressed', String(mediaState.sharing));
  share.querySelector('.control-label').textContent = mediaState.sharing ? 'Stop sharing' : 'Share screen';
  share.setAttribute('aria-label', mediaState.sharing ? 'Stop sharing screen' : 'Share screen');
  for (const id of ['micButton', 'cameraButton']) $(id).disabled = !active || joining;
  share.disabled = !active || joining || !screenSupported;
  if (!screenSupported) { share.title = 'Screen sharing is not available in this browser'; share.querySelector('.control-label').textContent = 'Unavailable'; }
  renderScreen('local', 'Your screen', mediaState.sharing, displayStream, true);
}
function updateGrid(change = () => {}) {
  const positions = new Map([...$('videoGrid').children].map(el => [el, el.getBoundingClientRect()]));
  change();
  $('participantCount').textContent = joined ? String(peers.size + 1) : '0';
  $('waitingCard').hidden = peers.size > 0;
  $('videoGrid').classList.toggle('many', peers.size >= 2);
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  for (const [el, old] of positions) {
    if (!el.isConnected || el.hidden) continue;
    const next = el.getBoundingClientRect();
    if (old.width && next.width && (old.x !== next.x || old.y !== next.y || old.width !== next.width)) {
      el.animate([{ transform: `translate(${old.x-next.x}px, ${old.y-next.y}px) scale(${old.width/next.width}, ${old.height/next.height})` }, { transform: 'none' }], { duration: 300, easing: 'ease-out' });
    }
  }
}
function makeCard(id, name, screen = false) {
  const card = document.createElement('article');
  card.className = `video-card${screen ? ' screen-card' : ''}`; card.id = id;
  card.innerHTML = `<video autoplay playsinline${screen ? ' muted' : ''}></video><div class="camera-placeholder"><div class="avatar"></div><p></p><span>Connecting video…</span></div><span class="card-top-label"></span><div class="video-caption"><div><span class="presence-dot"></span><strong></strong><span class="you-label"></span></div><span class="media-badge" aria-label="Microphone muted">${icon('micOff')}</span></div>`;
  card.querySelector('strong').textContent = name;
  card.querySelector('video').setAttribute('aria-label', name + (screen ? ' shared screen' : ' camera'));
  card.querySelector('.avatar').textContent = screen ? '↗' : name.slice(-2);
  card.querySelector('.camera-placeholder p').textContent = screen ? 'Loading shared screen' : 'Camera is off';
  card.querySelector('.card-top-label').textContent = screen ? 'SCREEN SHARE' : 'AT THE TABLE';
  if (screen) card.querySelector('.media-badge').hidden = true;
  return card;
}
function renderScreen(id, name, sharing, stream, local = false) {
  let card = $(`screen-${id}`);
  if (!sharing) { if (card) updateGrid(() => card.remove()); return; }
  if (!card) { card = makeCard(`screen-${id}`, name, true); updateGrid(() => $('videoGrid').prepend(card)); }
  const video = card.querySelector('video');
  if (stream && video.srcObject !== stream) { video.srcObject = stream; playVideo(video); }
  card.querySelector('.camera-placeholder').hidden = !!stream?.getVideoTracks().some(t => t.readyState === 'live' && !t.muted);
  if (local) card.querySelector('.camera-placeholder').hidden = true;
}
function renderPeer(peer) {
  peer.card.querySelector('.camera-placeholder').hidden = !peer.state.cameraOff && peer.camera.getVideoTracks().some(t => !t.muted && t.readyState === 'live');
  peer.card.querySelector('.camera-placeholder p').textContent = peer.state.cameraOff ? 'Camera is off' : 'Connecting video';
  peer.card.querySelector('.camera-placeholder>span').textContent = peer.pc.connectionState === 'connected' ? 'Still in the conversation' : 'Establishing a connection';
  peer.card.querySelector('.media-badge').hidden = !peer.state.muted;
  peer.card.querySelector('.you-label').textContent = peer.pc.connectionState === 'connected' ? (peer.state.muted ? 'Muted' : '') : peer.pc.connectionState === 'failed' ? 'Connection issue' : 'Connecting';
  renderScreen(peer.id, `${peer.name}’s screen`, peer.state.sharing, peer.screen);
}
function playVideo(video) {
  video.play().catch(() => { if (!video.muted && active) $('soundButton').hidden = false; });
}
function currentTracks() {
  return [localStream.getAudioTracks()[0] || null, localStream.getVideoTracks()[0] || null, displayStream?.getVideoTracks()[0] || null];
}
async function attachTracks(peer) {
  const tracks = currentTracks();
  const slots = peer.pc.getTransceivers();
  await Promise.all(slots.slice(0, 3).map(async (slot, i) => {
    slot.direction = 'sendrecv';
    await slot.sender.replaceTrack(tracks[i]);
  }));
}
async function replaceForAll(index, track) {
  const results = await Promise.allSettled([...peers.values()].map(async peer => {
    const sender = peer.pc.getTransceivers()[index]?.sender;
    if (sender) await sender.replaceTrack(track);
  }));
  if (results.some(r => r.status === 'rejected')) toast('A media connection could not update. Rejoin if someone cannot see or hear you.');
}
function queue(peer, task) {
  peer.queue = peer.queue.then(() => { if (peers.get(peer.id) === peer) return task(); }).catch(error => {
    console.warn('Media connection could not complete:', error.name);
    if (peers.get(peer.id) === peer) {
      peer.card.querySelector('.you-label').textContent = 'Connection issue';
      toast(`Connection to ${peer.name} needs a retry.`);
    }
  });
  return peer.queue;
}
async function offer(peer, restart = false) {
  if (peer.pc.signalingState !== 'stable') { peer.pendingRestart ||= restart; return; }
  if (restart) peer.pc.restartIce();
  await peer.pc.setLocalDescription(await peer.pc.createOffer());
  send({ type: 'signal', to: peer.id, data: { description: peer.pc.localDescription } });
}
function createPeer(info, initiator) {
  if (peers.has(info.id)) return peers.get(info.id);
  const pc = new RTCPeerConnection(rtcConfig);
  const peer = { ...info, pc, initiator, card: makeCard(`peer-${info.id}`, info.name), camera: new MediaStream(), screen: new MediaStream(), candidates: [], queue: Promise.resolve(), retries: 0 };
  peers.set(info.id, peer);
  peer.card.querySelector('video').srcObject = peer.camera;
  updateGrid(() => $('videoGrid').append(peer.card));
  pc.onicecandidate = event => { if (event.candidate) send({ type: 'signal', to: peer.id, data: { candidate: event.candidate.toJSON() } }); };
  pc.ontrack = event => {
    const slot = pc.getTransceivers().indexOf(event.transceiver);
    const stream = slot === 2 ? peer.screen : peer.camera;
    for (const t of stream.getTracks()) if (t.kind === event.track.kind) stream.removeTrack(t);
    stream.addTrack(event.track);
    event.track.onunmute = () => { renderPeer(peer); playVideo(peer.card.querySelector('video')); const screen = $(`screen-${peer.id}`)?.querySelector('video'); if (screen) playVideo(screen); };
    event.track.onmute = () => renderPeer(peer);
    event.track.onended = () => renderPeer(peer);
    renderPeer(peer); playVideo(peer.card.querySelector('video'));
  };
  pc.onconnectionstatechange = () => {
    renderPeer(peer);
    clearTimeout(peer.retryTimer);
    if (pc.connectionState === 'connected') peer.retries = 0;
    if (['failed', 'disconnected'].includes(pc.connectionState) && peer.retries < 3) {
      peer.retryTimer = setTimeout(() => {
        if (!active || !peers.has(peer.id)) return;
        peer.retries++;
        if (initiator) queue(peer, () => offer(peer, true));
        else send({ type: 'signal', to: peer.id, data: { restart: true } });
      }, pc.connectionState === 'failed' ? 1500 : 6000);
    }
    if (pc.connectionState === 'failed') notice('Someone’s media connection is having trouble. We’re retrying. If it persists, rejoin the call.', 'Rejoin', rejoin);
  };
  if (initiator) {
    for (const kind of ['audio', 'video', 'video']) pc.addTransceiver(kind, { direction: 'sendrecv' });
    queue(peer, async () => { await attachTracks(peer); await offer(peer); });
  }
  renderPeer(peer);
  return peer;
}
async function signal(peer, data) {
  if (data.restart) { if (peer.initiator) await offer(peer, true); return; }
  if (data.description) {
    // Only the newcomer creates offers. Fixed audio/camera/screen slots avoid offer glare.
    if (data.description.type === 'offer' && peer.initiator) return;
    await peer.pc.setRemoteDescription(data.description);
    for (const candidate of peer.candidates.splice(0)) await peer.pc.addIceCandidate(candidate);
    if (data.description.type === 'offer') {
      await attachTracks(peer);
      await peer.pc.setLocalDescription(await peer.pc.createAnswer());
      send({ type: 'signal', to: peer.id, data: { description: peer.pc.localDescription } });
    } else if (peer.pendingRestart) { peer.pendingRestart = false; await offer(peer, true); }
  } else if (data.candidate) {
    if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(data.candidate);
    else peer.candidates.push(data.candidate);
  }
}
function removePeer(id, animate = true) {
  const peer = peers.get(id); if (!peer) return;
  peers.delete(id); clearTimeout(peer.retryTimer);
  peer.pc.onconnectionstatechange = null; peer.pc.ontrack = null; peer.pc.onicecandidate = null; peer.pc.close();
  for (const t of [...peer.camera.getTracks(), ...peer.screen.getTracks()]) t.stop();
  const remove = () => updateGrid(() => { peer.card.remove(); $(`screen-${id}`)?.remove(); });
  if (animate) { peer.card.classList.add('leaving'); setTimeout(remove, 240); } else remove();
  updateGrid();
}
function clearPeers() { for (const id of [...peers.keys()]) removePeer(id, false); }
function connect() {
  if (!active) return;
  connection(reconnectAttempt ? 'Reconnecting' : 'Connecting');
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/signal`);
  socket = ws;
  const timeout = setTimeout(() => { if (!joined && socket === ws) ws.close(); }, 15000);
  ws.onopen = () => { if (active && socket === ws) send({ type: 'join', state: mediaState }); else ws.close(); };
  ws.onmessage = event => {
    if (socket !== ws || !active) return;
    let msg; try { msg = JSON.parse(event.data); } catch { return; }
    if (msg.type === 'welcome') {
      clearTimeout(timeout); joined = true; reconnectAttempt = 0; selfId = msg.self.id;
      startedAt ||= Date.now(); connection('Live', true);
      $('dockTitle').textContent = 'You’re in the party'; $('dockSubtitle').textContent = 'Let the draft begin.';
      for (const p of msg.peers) createPeer(p, true);
      renderLocal(); updateGrid();
    } else if (msg.type === 'joined') { createPeer(msg.peer, false); toast(`${msg.peer.name} joined the party`); }
    else if (msg.type === 'left') { removePeer(msg.id); toast(`${msg.name} left the party`); }
    else if (msg.type === 'state') { const p = peers.get(msg.id); if (p) { p.state = msg.state; renderPeer(p); } }
    else if (msg.type === 'signal') { const p = peers.get(msg.from); if (p) queue(p, () => signal(p, msg.data)); }
    else if (msg.type === 'full') {
      leave(); notice('The party is at capacity. Try joining again in a moment.', 'Rejoin', rejoin);
    }
  };
  ws.onerror = () => {};
  ws.onclose = () => {
    clearTimeout(timeout);
    if (socket !== ws) return;
    joined = false; clearPeers(); updateGrid(); renderLocal();
    if (!active) return;
    connection('Reconnecting');
    $('dockTitle').textContent = 'Connection interrupted'; $('dockSubtitle').textContent = 'Rejoining automatically…';
    reconnectAttempt++;
    retryTimer = setTimeout(connect, Math.min(1000 * 2 ** Math.min(reconnectAttempt - 1, 4), 15000));
  };
}
function bindTrack(track) {
  track.onended = () => {
    if (!active) return;
    localStream.removeTrack(track);
    if (track.kind === 'audio') mediaState.muted = true; else mediaState.cameraOff = true;
    replaceForAll(track.kind === 'audio' ? 0 : 1, null); stateChanged();
    toast(`${track.kind === 'audio' ? 'Microphone' : 'Camera'} disconnected. Use the controls to reconnect it.`);
  };
}
async function getInitialMedia(token) {
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: { width: { ideal: 960 }, height: { ideal: 540 }, frameRate: { ideal: 24, max: 30 } } }); }
  catch {
    // Missing/blocked camera must not prevent an available microphone from working.
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
    catch { stream = new MediaStream(); }
    if (active && token === generation) notice('You can listen now. Use the mic and camera controls to enable available devices. If access was blocked, allow it in your browser’s site settings.');
  }
  if (!active || token !== generation) { stream.getTracks().forEach(t => t.stop()); return; }
  localStream = stream;
  localStream.getTracks().forEach(bindTrack);
  mediaState.muted = !stream.getAudioTracks().length;
  mediaState.cameraOff = !stream.getVideoTracks().length;
}
async function join() {
  if (joining || joined) return;
  active = true; joining = true; const token = ++generation;
  $('leaveButton').innerHTML = `${icon('phone')}<span>Leave call</span>`;
  $('leaveButton').setAttribute('aria-label', 'Leave call');
  $('videoGrid').classList.remove('solo-left');
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) {
    joining = false; active = false; renderLocal();
    connection('Unavailable'); notice('This call needs a modern browser and an HTTPS connection. Open the secure site link in Chrome, Edge, Firefox, or Safari.');
    return;
  }
  // Start permission request before any network work or user setup.
  const media = getInitialMedia(token);
  try {
    const response = await fetch('/api/config', { signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error('Configuration unavailable');
    rtcConfig = await response.json();
    await media;
    if (!active || token !== generation) return;
    joining = false; renderLocal(); connect();
  } catch {
    await media;
    if (token !== generation || !active) return;
    joining = false; leave();
    notice('The party server is unavailable. Please try again.', 'Retry', rejoin);
  }
}
async function toggleDevice(kind) {
  const index = kind === 'audio' ? 0 : 1;
  const key = kind === 'audio' ? 'muted' : 'cameraOff';
  const button = $(kind === 'audio' ? 'micButton' : 'cameraButton');
  const token = generation; button.disabled = true;
  try {
    let track = localStream.getTracks().find(t => t.kind === kind && t.readyState === 'live');
    if (!mediaState[key]) {
      if (kind === 'audio') track.enabled = false;
      else { track.onended = null; track.stop(); localStream.removeTrack(track); await replaceForAll(index, null); }
      mediaState[key] = true;
    } else {
      if (!track) {
        const stream = await navigator.mediaDevices.getUserMedia(kind === 'audio' ? { audio: { echoCancellation: true, noiseSuppression: true } } : { video: { width: { ideal: 960 }, height: { ideal: 540 }, frameRate: { ideal: 24, max: 30 } } });
        if (!active || token !== generation) { stream.getTracks().forEach(t => t.stop()); return; }
        track = stream.getTracks()[0]; localStream.addTrack(track); bindTrack(track);
      }
      track.enabled = true; await replaceForAll(index, track); mediaState[key] = false;
    }
    stateChanged();
  } catch { notice(`${kind === 'audio' ? 'Microphone' : 'Camera'} unavailable. Allow access in your browser’s site settings, check that a device is connected, then try the control again.`); }
  finally { button.disabled = !active; }
}
async function stopShare() {
  if (!displayStream) return;
  const old = displayStream; displayStream = undefined; mediaState.sharing = false;
  old.getTracks().forEach(t => { t.onended = null; t.stop(); });
  await replaceForAll(2, null); stateChanged();
}
async function toggleShare() {
  if (mediaState.sharing) return stopShare();
  const token = generation; $('shareButton').disabled = true;
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 10, max: 15 } }, audio: false });
    if (!active || token !== generation) { stream.getTracks().forEach(t => t.stop()); return; }
    displayStream = stream; displayStream.getVideoTracks()[0].onended = stopShare;
    await replaceForAll(2, displayStream.getVideoTracks()[0]);
    mediaState.sharing = true; stateChanged(); toast('Your screen is shared with the party');
  } catch (error) { if (error.name !== 'NotAllowedError') toast('Screen sharing could not start. Try a desktop browser.'); }
  finally { $('shareButton').disabled = !active || !screenSupported; }
}
function leave() {
  active = false; joined = false; joining = false; generation++; clearTimeout(retryTimer);
  if (socket) { const old = socket; socket = undefined; old.close(); }
  clearPeers();
  for (const track of [...localStream.getTracks(), ...(displayStream?.getTracks() || [])]) { track.onended = null; track.stop(); }
  localStream = new MediaStream(); displayStream = undefined;
  mediaState = { muted: true, cameraOff: true, sharing: false };
  renderLocal(); updateGrid(); connection('Offline'); startedAt = undefined; $('sessionTime').textContent = '00:00';
  $('dockTitle').textContent = 'You left the party'; $('dockSubtitle').textContent = 'Your seat is always here.';
  $('leaveButton').innerHTML = `${icon('phone')}<span>Rejoin call</span>`;
  $('leaveButton').setAttribute('aria-label', 'Rejoin call');
  $('soundButton').hidden = true; $('videoGrid').classList.add('solo-left');
}
function rejoin() { leave(); notice(''); join(); }
$('micButton').onclick = () => toggleDevice('audio');
$('cameraButton').onclick = () => toggleDevice('video');
$('shareButton').onclick = toggleShare;
$('leaveButton').onclick = () => { if (active) { leave(); notice(''); } else rejoin(); };
$('soundButton').onclick = async () => {
  const results = await Promise.allSettled([...document.querySelectorAll('.video-card video')].map(v => v.play()));
  $('soundButton').hidden = results.every(r => r.status === 'fulfilled');
};
window.addEventListener('pagehide', leave);
window.addEventListener('pageshow', event => { if (event.persisted) rejoin(); });
window.addEventListener('online', () => { if (active && !joined && !joining) { clearTimeout(retryTimer); if (socket) { const old = socket; socket = undefined; old.close(); } connect(); } });
setInterval(() => {
  if (!startedAt || !joined) return;
  const seconds = Math.floor((Date.now() - startedAt) / 1000);
  $('sessionTime').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}, 1000);
join();
