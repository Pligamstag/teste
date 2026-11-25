// ============================================================
// Pli Call — Version "Meet-like" avec mode basse connexion
// ============================================================

let peer = null;
let currentCall = null;
let localStream = null;
let screenStream = null;
let roomCode = null;
let isMicOn = true;
let isCamOn = true;
let isScreenSharing = false;
let quality = 'low';       // low | medium | high | audio

const $ = (id) => document.getElementById(id);

// ---- Contraintes vidéo selon la qualité ----
const QUALITY_PRESETS = {
  low:    { width: 160, height: 120, fps: 10, bitrate: 80000 },
  medium: { width: 320, height: 240, fps: 15, bitrate: 250000 },
  high:   { width: 640, height: 480, fps: 24, bitrate: 800000 },
  audio:  { width: 0,   height: 0,   fps: 0,  bitrate: 0 }
};

// Serveurs ICE Metered : TURN permet de relayer le média lorsque la connexion directe échoue.
const ICE_SERVERS = [
  { urls: 'stun:stun.relay.metered.ca:80' },
  {
    urls: [
      'turn:global.relay.metered.ca:80',
      'turn:global.relay.metered.ca:80?transport=tcp',
      'turn:global.relay.metered.ca:443',
      'turns:global.relay.metered.ca:443?transport=tcp'
    ],
    username: '403d8a7db25a819098d7d8c9',
    credential: 'go7c76Oi2qYbDGN1'
  },
  { urls: 'stun:stun.l.google.com:19302' }
];

let roomHost = false;
let peerOpenTimer = null;
let remoteStreamTimer = null;
let iceDisconnectTimer = null;
let iceFailureTimer = null;
let iceRestartAttempted = false;
let dataSaverEnabled = true;
const SIGNAL_TIMEOUT_MS = 12000;
const REMOTE_STREAM_TIMEOUT_MS = 30000;
const ICE_GRACE_MS = 8000;

function setConnectionMessage(message) {
  const status = $('callStatus');
  if (status) status.textContent = message;
  const joinStatus = $('status');
  if (joinStatus) joinStatus.textContent = message;
}

function clearConnectionTimers() {
  [peerOpenTimer, remoteStreamTimer, iceDisconnectTimer, iceFailureTimer].forEach(id => {
    if (id !== null) clearTimeout(id);
  });
  peerOpenTimer = remoteStreamTimer = iceDisconnectTimer = iceFailureTimer = null;
}

function reportBlockedNetwork() {
  setConnectionMessage('Connexion média impossible : réseau possiblement bloqué (UDP/NAT). Un TURN TCP/TLS sur 443 est nécessaire sur certains réseaux.');
}

// ============================================================
// 2. CRÉATION / REJOINTE
// ============================================================
function createRoom() {
  const name = $('name').value.trim();
  if (!name) return alert('Renseigne un pseudo.');
  roomCode = generateCode();
  roomHost = true;
  $('code_out').textContent = roomCode;
  $('inviteBox').classList.remove('hidden');
}

function generateCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function copyCode() {
  const code = roomCode || $('code_out').textContent;
  navigator.clipboard.writeText(code)
    .then(() => alert('Code copié : ' + code))
    .catch(() => alert('Copie impossible'));
}

function joinRoom() {
  const code = $('code').value.trim().toUpperCase();
  if (!code) return alert('Renseigne un code.');
  roomCode = code;
  roomHost = false;
  enterCall();
}

// ============================================================
// 3. ENTRÉE DANS L'APPEL
// ============================================================
async function enterCall() {
  const name = $('name').value.trim() || 'Anonyme';
  $('selfLabel').textContent = name;
  $('selfAvatar').textContent = name[0];

  // Récupérer qualité choisie à l'accueil
  quality = 'low';

  $('join').style.display = 'none';
  $('call').classList.add('active');
  updateNetBadge();

  if (typeof Peer === 'undefined') {
    setConnectionMessage('La bibliothèque PeerJS locale est introuvable. Vérifie le déploiement de peerjs.min.js.');
    return;
  }

  // Acquérir le flux réel
  try {
    localStream = await navigator.mediaDevices.getUserMedia(getConstraintsForQuality(quality));
    $('local').srcObject = localStream;

    if (quality === 'audio') {
      $('local').style.display = 'none';
      $('selfAvatar').style.display = 'flex';
      $('btnCam').classList.add('off');
    }
  } catch (err) {
    alert('Impossible d\'accéder à la caméra/micro : ' + err.message);
    return;
  }

  // Créer le peer
  // Le créateur réserve l'identifiant de la salle; le participant entrant obtient
  // un identifiant PeerJS aléatoire et appelle ensuite l'identifiant de salle.
  peer = new Peer(roomHost ? 'pli-' + roomCode : undefined, {
    host: '0.peerjs.com',
    port: 443,
    secure: true,
    config: {
      iceServers: ICE_SERVERS,
      // iceTransportPolicy volontairement omis : défaut WebRTC = "all".
      iceCandidatePoolSize: 0
    }
  });

  let peerOpened = false;
  peerOpenTimer = setTimeout(() => {
    if (!peerOpened) setConnectionMessage('Serveur de signalisation PeerJS injoignable. Le réseau peut bloquer 0.peerjs.com / WebSocket (WSS 443).');
  }, SIGNAL_TIMEOUT_MS);

  peer.on('open', (id) => {
    peerOpened = true;
    if (peerOpenTimer !== null) clearTimeout(peerOpenTimer);
    peerOpenTimer = null;
    console.log('Peer connecté :', id);
    setConnectionMessage(roomHost ? 'Serveur prêt — en attente du participant…' : 'Serveur connecté — appel de la salle…');
    if (!roomHost) {
      const call = peer.call('pli-' + roomCode, localStream);
      if (!call) {
        setConnectionMessage('Impossible d’appeler cette salle. Vérifie le code et que l’hôte est connecté.');
        return;
      }
      currentCall = call;
      attachRemote(call);
    }
  });

  peer.on('call', (call) => {
    if (!roomHost) {
      call.close();
      return;
    }
    currentCall = call;
    attachRemote(call);
    call.answer(localStream);
  });

  peer.on('error', (err) => {
    console.error(err);
    const messages = {
      'unavailable-id': 'Ce code de réunion est déjà utilisé. Choisis une autre salle.',
      'peer-unavailable': 'Salle ou hôte introuvable. Vérifie le code et que l’hôte a rejoint la réunion.',
      'network': 'Serveur de signalisation inaccessible : réseau possiblement bloqué (PeerJS / WebSocket).',
      'socket-error': 'Erreur WebSocket vers le serveur de signalisation PeerJS (filtrage réseau possible).',
      'socket-closed': 'Connexion au serveur de signalisation PeerJS interrompue.',
      'server-error': 'Le serveur de signalisation PeerJS a renvoyé une erreur.'
    };
    setConnectionMessage(messages[err.type] || 'Erreur PeerJS : ' + (err.type || err.message || 'connexion impossible'));
    if (err.type === 'unavailable-id') hangup();
  });
}

function attachRemote(call) {
  clearTimeout(remoteStreamTimer);
  remoteStreamTimer = setTimeout(() => {
    if (currentCall === call && !$('remote').srcObject) reportBlockedNetwork();
  }, REMOTE_STREAM_TIMEOUT_MS);
  watchIceConnection(call);

  call.on('stream', (remoteStream) => {
    if (remoteStreamTimer !== null) clearTimeout(remoteStreamTimer);
    remoteStreamTimer = null;
    $('remote').srcObject = remoteStream;
    $('remote').style.display = 'block';
    $('remoteAvatar').style.display = 'none';
    setConnectionMessage('Appel connecté.');
  });
  call.on('close', () => {
    if (remoteStreamTimer !== null) clearTimeout(remoteStreamTimer);
    remoteStreamTimer = null;
    $('remote').srcObject = null;
    $('remote').style.display = 'none';
    $('remoteAvatar').style.display = 'flex';
    $('remoteLabel').textContent = 'Appel terminé';
    if (currentCall === call) currentCall = null;
    setConnectionMessage('Appel terminé.');
  });
  call.on('error', (err) => {
    console.error('Erreur appel WebRTC :', err);
    reportBlockedNetwork();
  });
  call.on('data', handleData);
}

function watchIceConnection(call) {
  const pc = call.peerConnection;
  if (!pc) {
    setConnectionMessage('Appel établi; état ICE indisponible dans cette version de PeerJS.');
    return;
  }
  pc.addEventListener('iceconnectionstatechange', () => {
    const state = pc.iceConnectionState;
    console.log('État ICE :', state);
    if (state === 'connected' || state === 'completed') {
      if (iceDisconnectTimer !== null) clearTimeout(iceDisconnectTimer);
      if (iceFailureTimer !== null) clearTimeout(iceFailureTimer);
      iceDisconnectTimer = iceFailureTimer = null;
      setConnectionMessage('Appel connecté.');
    } else if (state === 'disconnected') {
      setConnectionMessage('Connexion instable… tentative de rétablissement.');
      if (iceDisconnectTimer !== null) clearTimeout(iceDisconnectTimer);
      iceDisconnectTimer = setTimeout(() => {
        if (pc.iceConnectionState === 'disconnected') handleIceFailure(pc);
      }, ICE_GRACE_MS);
    } else if (state === 'failed') {
      handleIceFailure(pc);
    }
  });
}

function handleIceFailure(pc) {
  if (!iceRestartAttempted && pc && typeof pc.restartIce === 'function') {
    iceRestartAttempted = true;
    setConnectionMessage('Connexion ICE échouée — tentative de redémarrage…');
    try {
      pc.restartIce();
      iceFailureTimer = setTimeout(() => {
        if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') reportBlockedNetwork();
      }, 12000);
      return;
    } catch (e) {
      console.warn('Redémarrage ICE impossible :', e);
    }
  }
  reportBlockedNetwork();
}

// ============================================================
// 4. CONTRÔLES
// ============================================================
function toggleMic() {
  if (!localStream) return;
  const t = localStream.getAudioTracks()[0];
  if (!t) return;
  isMicOn = !isMicOn;
  t.enabled = isMicOn;
  $('btnMic').classList.toggle('off', !isMicOn);
}

function toggleCam() {
  if (!localStream) return;
  const t = localStream.getVideoTracks()[0];
  if (!t) return;
  isCamOn = !isCamOn;
  t.enabled = isCamOn;
  $('btnCam').classList.toggle('off', !isCamOn);
  $('local').style.display = isCamOn ? 'block' : 'none';
  $('selfAvatar').style.display = isCamOn ? 'none' : 'flex';
}

// ---- Changement de qualité en direct ----
async function setQuality(q) {
  quality = q;
  updateNetBadge();
  $('menu').classList.remove('show');

  // Mettre à jour le menu (surligner l'actif)
  document.querySelectorAll('#menu button[data-q]').forEach(b => {
    b.classList.toggle('active-q', b.dataset.q === q);
  });

  if (!currentCall || !localStream) return;

  // Si audio only : couper la vidéo
  if (q === 'audio') {
    const vt = localStream.getVideoTracks()[0];
    if (vt) {
      vt.stop();
      localStream.removeTrack(vt);
    }
    const sender = currentCall.peerConnection
      .getSenders()
      .find(s => s.track && s.track.kind === 'video');
    if (sender) await sender.replaceTrack(null);
    $('local').style.display = 'none';
    $('selfAvatar').style.display = 'flex';
    $('btnCam').classList.add('off');
    return;
  }

  // Sinon : appliquer les nouvelles contraintes
  const p = QUALITY_PRESETS[q];
  const vt = localStream.getVideoTracks()[0];

  if (vt) {
    try {
      await vt.applyConstraints({
        width: { ideal: p.width },
        height: { ideal: p.height },
        frameRate: { ideal: p.fps, max: p.fps }
      });
    } catch (e) {
      console.warn('applyConstraints a échoué, on recrée la track', e);
      await replaceVideoTrack(q);
    }
  } else {
    await replaceVideoTrack(q);
  }

  // Limiter le bitrate via SDP si possible
  await limitBitrate(currentCall.peerConnection, p.bitrate);
}

async function replaceVideoTrack(q) {
  const p = QUALITY_PRESETS[q];
  try {
    const newStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: p.width }, height: { ideal: p.height }, frameRate: { ideal: p.fps } }
    });
    const newTrack = newStream.getVideoTracks()[0];

    if (currentCall) {
      const sender = currentCall.peerConnection
        .getSenders()
        .find(s => s.track && s.track.kind === 'video');
      if (sender) await sender.replaceTrack(newTrack);
    }

    // Swap dans le flux local
    const old = localStream.getVideoTracks()[0];
    if (old) { old.stop(); localStream.removeTrack(old); }
    localStream.addTrack(newTrack);
    $('local').srcObject = localStream;
    $('local').style.display = 'block';
    $('selfAvatar').style.display = 'none';
    $('btnCam').classList.remove('off');
    isCamOn = true;
  } catch (e) {
    console.error('Impossible de recréer la track vidéo', e);
  }
}

// Baisser le bitrate via l'API SDP
async function limitBitrate(pc, maxBitrate) {
  if (!pc || !maxBitrate) return;
  try {
    const senders = pc.getSenders();
    for (const sender of senders) {
      if (sender.track && sender.track.kind === 'video') {
        const params = sender.getParameters();
        if (!params.encodings) params.encodings = [{}];
        params.encodings.forEach(e => { e.maxBitrate = maxBitrate; });
        await sender.setParameters(params);
      }
    }
  } catch (e) {
    console.warn('setParameters bitrate échoué', e);
  }
}

function labelQuality(q) {
  return {
    low: 'Basse conso (160p)',
    medium: 'Équilibré (360p)',
    high: 'Haute qualité (720p)',
    audio: 'Audio uniquement'
  }[q] || q;
}

function updateNetBadge() {
  const badge = $('netBadge');
  if (!badge) return;
  const labels = {
    low: '🔋 Mode basse conso',
    medium: '⚖️ Qualité équilibrée',
    high: '✨ Haute qualité',
    audio: '🎧 Audio uniquement'
  };
  badge.textContent = labels[quality] || '';
  badge.className = 'net-badge' + (quality === 'high' ? ' warn' : '');
}

// ---- Partage d'écran ----
async function toggleScreen() {
  if (!currentCall) return alert('Attends qu\'un participant rejoigne.');
  if (!isScreenSharing) {
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 15 }
      });
      const vt = screenStream.getVideoTracks()[0];
      const sender = currentCall.peerConnection
        .getSenders()
        .find(s => s.track && s.track.kind === 'video');
      if (sender) await sender.replaceTrack(vt);
      $('local').srcObject = screenStream;
      isScreenSharing = true;
      vt.onended = () => stopScreenShare();
    } catch (e) {
      console.warn('Partage annulé', e);
    }
  } else {
    stopScreenShare();
  }
}

async function stopScreenShare() {
  if (!screenStream) return;
  const vt = localStream.getVideoTracks()[0];
  const sender = currentCall?.peerConnection
    .getSenders()
    .find(s => s.track && s.track.kind === 'video');
  if (sender && vt) await sender.replaceTrack(vt);
  screenStream.getTracks().forEach(t => t.stop());
  screenStream = null;
  isScreenSharing = false;
  $('local').srcObject = localStream;
}

// ---- Emojis ----
function toggleEmoji() {
  $('emojiPanel').classList.toggle('show');
  $('menu').classList.remove('show');
  const panel = $('emojiPanel');
  if (!panel.dataset.filled) {
    ['👍','👎','😂','❤️','🎉','😮','😢','👏','🔥','🙏'].forEach(e => {
      const btn = document.createElement('button');
      btn.textContent = e;
      btn.onclick = () => sendEmoji(e);
      panel.appendChild(btn);
    });
    panel.dataset.filled = '1';
  }
}

function sendEmoji(emoji) {
  if (currentCall && currentCall.open) {
    currentCall.send({ type: 'emoji', value: emoji });
  }
  showFloatingEmoji(emoji);
  $('emojiPanel').classList.remove('show');
}

function showFloatingEmoji(emoji) {
  const el = document.createElement('div');
  el.textContent = emoji;
  el.style.cssText = `
    position:fixed;bottom:120px;left:50%;transform:translateX(-50%);
    font-size:64px;pointer-events:none;z-index:999;
    animation:floatUp 2s ease-out forwards;
  `;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2000);
}

// Injection animation
const _s = document.createElement('style');
_s.textContent = `
  @keyframes floatUp {
    0% { opacity: 1; transform: translate(-50%, 0) scale(1); }
    100% { opacity: 0; transform: translate(-50%, -220px) scale(1.6); }
  }
`;
document.head.appendChild(_s);

// ---- Chat ----
function toggleChat() {
  const p = $('chatPanel');
  p.classList.toggle('open');
}


function sendChat(ev) {
  ev.preventDefault();
  const input = $('chatInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  if (currentCall && currentCall.open) {
    currentCall.send({ type: 'chat', value: text });
  }
  addChatMsg('Moi', text, true);
}

function addChatMsg(author, text, self = false) {
  const div = document.createElement('div');
  div.className = 'msg' + (self ? ' self' : '');
  div.innerHTML = `<b>${escapeHtml(author)}</b>${escapeHtml(text)}`;
  $('chatLog').appendChild(div);
  $('chatLog').scrollTop = $('chatLog').scrollHeight;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  })[c]);
}

function handleData(data) {
  if (data.type === 'chat') addChatMsg('Correspondant', data.value, false);
  if (data.type === 'emoji') showFloatingEmoji(data.value);
}

// Le bouton conserve son libellé français et bascule entre qualité basse et équilibrée.
async function toggleDataSaver() {
  dataSaverEnabled = !dataSaverEnabled;
  const label = $('dsLabel');
  if (label) label.textContent = 'Mode basse connexion : ' + (dataSaverEnabled ? 'ON' : 'OFF');
  await setQuality(dataSaverEnabled ? 'low' : 'medium');
}

// ---- Menu qualité ----
function toggleMenu() {
  $('menu').classList.toggle('show');
  $('emojiPanel').classList.remove('show');
}

// ---- Plein écran ----
function toggleFull() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
  } else {
    document.exitFullscreen();
  }
}

// ---- Changement de périphérique ----
async function switchDevice(kind) {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const list = devices.filter(d => d.kind === kind);
    if (!list.length) return alert('Aucun périphérique.');
    const choice = prompt(
      'Choisis un périphérique :\n' +
      list.map((d, i) => `${i + 1}. ${d.label || 'Sans nom'}`).join('\n')
    );
    const idx = parseInt(choice, 10) - 1;
    if (isNaN(idx) || !list[idx]) return;

    const constraints = kind === 'audioinput'
      ? { audio: { deviceId: { exact: list[idx].deviceId } } }
      : { video: { deviceId: { exact: list[idx].deviceId } } };

    const newStream = await navigator.mediaDevices.getUserMedia(constraints);
    const newTrack = kind === 'audioinput'
      ? newStream.getAudioTracks()[0]
      : newStream.getVideoTracks()[0];

    if (currentCall) {
      const sender = currentCall.peerConnection
        .getSenders()
        .find(s => s.track && s.track.kind === newTrack.kind);
      if (sender) await sender.replaceTrack(newTrack);
    }

    const old = (kind === 'audioinput'
      ? localStream.getAudioTracks()
      : localStream.getVideoTracks());
    old.forEach(t => { t.stop(); localStream.removeTrack(t); });
    localStream.addTrack(newTrack);
    if (kind === 'videoinput') $('local').srcObject = localStream;
  } catch (e) {
    console.error(e);
    alert('Impossible de changer de périphérique.');
  }
}

// ---- Quitter ----
function hangup() {
  clearConnectionTimers();
  iceRestartAttempted = false;
  if (currentCall) currentCall.close();
  if (peer) peer.destroy();
  if (localStream) localStream.getTracks().forEach(t => t.stop());
  if (screenStream) screenStream.getTracks().forEach(t => t.stop());

  currentCall = null;
  peer = null;
  localStream = null;
  screenStream = null;
  isScreenSharing = false;
  isMicOn = true;
  isCamOn = true;
  roomHost = false;

  $('local').srcObject = null;
  $('remote').srcObject = null;
  $('call').classList.remove('active');
  $('join').style.display = 'flex';
  $('chatLog').innerHTML = '';
  $('inviteBox').classList.add('hidden');
  $('btnMic').classList.remove('off');
  $('btnCam').classList.remove('off');
  $('local').style.display = 'block';

  setConnectionMessage('');
}

// ============================================================
// DÉMARRAGE
// ============================================================
// Aucun accès caméra demandé au chargement : il est demandé uniquement à l'entrée en appel.

