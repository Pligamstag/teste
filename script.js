// ============================================================
// Pli Call — Version "Meet-like" avec mode basse connexion
// ============================================================

let peer = null;
let currentCall = null;
let dataConn = null;
let isHost = false;
let myName = 'Anonyme';
let remoteName = 'Correspondant';
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

// ============================================================
// 1. PREVIEW À L'ACCUEIL
// ============================================================
async function initPreview() {
  try {
    const constraints = getConstraintsForQuality(quality);
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    const preview = $('preview');
    if (preview) {
      preview.srcObject = stream;
      preview.muted = true;
    }
    // On garde le stream pour l'utiliser au moment d'entrer
    window._previewStream = stream;
  } catch (e) {
    console.warn('Aperçu impossible :', e);
  }
}

function getConstraintsForQuality(q) {
  const p = QUALITY_PRESETS[q] || QUALITY_PRESETS.low;
  if (q === 'audio') {
    return { video: false, audio: { echoCancellation: true, noiseSuppression: true } };
  }
  return {
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: {
      width: { ideal: p.width },
      height: { ideal: p.height },
      frameRate: { ideal: p.fps, max: p.fps }
    }
  };
}

function togglePreviewCam() {
  const s = window._previewStream;
  if (!s) return;
  const t = s.getVideoTracks()[0];
  if (!t) return;
  t.enabled = !t.enabled;
  $('btnPreviewCam').classList.toggle('off', !t.enabled);
}

function togglePreviewMic() {
  const s = window._previewStream;
  if (!s) return;
  const t = s.getAudioTracks()[0];
  if (!t) return;
  t.enabled = !t.enabled;
  $('btnPreviewMic').classList.toggle('off', !t.enabled);
}

// ============================================================
// 2. CRÉATION / REJOINTE
// ============================================================
function createRoom() {
  const name = $('name').value.trim();
  if (!name) return alert('Renseigne un pseudo.');
  roomCode = generateCode();
  isHost = true;
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
  const name = $('name').value.trim();
  if (!name) {
    $('name').focus();
    return alert('Renseigne ton pseudo avant de rejoindre.');
  }
  const code = $('code').value.trim().toUpperCase();
  if (!code) return alert('Renseigne un code.');
  roomCode = code;
  isHost = false;
  enterCall();
}

// ============================================================
// 3. ENTRÉE DANS L'APPEL
// ============================================================
async function enterCall() {
  const name = $('name').value.trim();
  if (!name) {
    $('name').focus();
    return alert('Renseigne un pseudo.');
  }
  try { localStorage.setItem('pliPseudo', name); } catch (e) {}
  myName = name;
  $('selfLabel').textContent = name;
  $('selfAvatar').textContent = name[0];
  $('roomLabel').textContent = 'Code : ' + roomCode;

  // Récupérer qualité choisie à l'accueil
  const q = $('quality') ? $('quality').value : 'low';
  quality = q;

  // Stopper l'aperçu
  if (window._previewStream) {
    window._previewStream.getTracks().forEach(t => t.stop());
    window._previewStream = null;
  }

  $('join').style.display = 'none';
  $('call').classList.add('active');
  updateNetBadge();

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

  // Créer le peer :
  //  - l'hôte prend l'ID fixe "pli-CODE"
  //  - l'invité prend un ID aléatoire et appelle l'hôte
  const peerConfig = {
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        // Relais TURN public (nécessaire derrière 4G / box stricte)
        { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
        { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
        { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
      ]
    }
  };
  const hostId = 'pli-' + roomCode;
  peer = isHost ? new Peer(hostId, peerConfig) : new Peer(peerConfig);

  peer.on('open', (id) => {
    console.log('Peer connecté :', id);
    $('remoteLabel').textContent = isHost ? 'En attente d\'un participant…' : 'Connexion à la réunion…';
    if (!isHost) connectToHost(hostId);
  });

  // L'hôte reçoit l'appel et le canal de données
  peer.on('call', (call) => {
    call.answer(localStream);
    currentCall = call;
    attachRemote(call);
  });
  peer.on('connection', (conn) => setupData(conn));

  peer.on('disconnected', () => {
    try { peer.reconnect(); } catch (e) {}
  });

  peer.on('error', (err) => {
    console.error(err);
    if (err.type === 'unavailable-id') {
      alert('Ce code de réunion est déjà utilisé.');
      hangup();
    } else if (err.type === 'peer-unavailable') {
      alert('Réunion introuvable. Vérifie le code, et que l\'hôte a bien cliqué sur « Rejoindre ».');
      hangup();
    } else if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error') {
      $('remoteLabel').textContent = 'Problème de connexion au serveur…';
    }
  });
}

function connectToHost(hostId) {
  setupData(peer.connect(hostId, { reliable: true }));
  const call = peer.call(hostId, localStream);
  if (!call) return;
  currentCall = call;
  attachRemote(call);
}

function setupData(conn) {
  dataConn = conn;
  conn.on('open', () => {
    conn.send({ type: 'hello', value: myName });
  });
  conn.on('data', handleData);
  conn.on('close', () => { dataConn = null; });
}

function attachRemote(call) {
  // Suivi de l'état réel de la connexion réseau (diagnostic visible)
  const pc = call.peerConnection;
  if (pc) {
    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;
      console.log('ICE :', s);
      if (s === 'checking') $('remoteLabel').textContent = 'Connexion en cours…';
      if (s === 'connected' || s === 'completed') $('remoteLabel').textContent = remoteName;
      if (s === 'disconnected') $('remoteLabel').textContent = 'Connexion instable…';
      if (s === 'failed') {
        $('remoteLabel').textContent = 'Échec : réseau bloqué entre vous deux';
        try { pc.restartIce(); } catch (e) {}
      }
    };
  }

  call.on('stream', (remoteStream) => {
    const v = $('remote');
    v.srcObject = remoteStream;
    v.style.display = 'block';
    $('remoteAvatar').style.display = 'none';
    $('remoteLabel').textContent = remoteName;
    // Forcer la lecture (certains navigateurs bloquent l'autoplay avec son)
    const p = v.play();
    if (p && p.catch) p.catch(() => {
      $('remoteLabel').textContent = 'Touche l\'écran pour activer le son';
      document.addEventListener('click', () => v.play(), { once: true });
    });
  });
  call.on('close', () => {
    $('remote').srcObject = null;
    $('remote').style.display = 'none';
    $('remoteAvatar').style.display = 'flex';
    $('remoteLabel').textContent = 'Appel terminé';
  });
  call.on('error', (e) => console.error('Erreur appel', e));
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
  badge.innerHTML = '<span class="dot"></span> ' + (labels[quality] || '');
  badge.className = 'net-badge ' + (quality === 'high' ? 'warn' : 'ok');
}

// ---- Mode basse connexion (bouton du menu Options) ----
function toggleDataSaver() {
  const lowOn = quality === 'low';
  $('dsLabel').textContent = 'Mode basse connexion : ' + (lowOn ? 'OFF' : 'ON');
  $('menu').classList.remove('show');
  setQuality(lowOn ? 'medium' : 'low');
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
  if (dataConn && dataConn.open) {
    dataConn.send({ type: 'emoji', value: emoji });
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

function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.textContent.includes(tab === 'chat' ? 'Chat' : 'Infos')));
  $('tabChat').classList.toggle('hidden', tab !== 'chat');
  $('tabInfo').classList.toggle('hidden', tab !== 'info');
}

function sendChat(ev) {
  ev.preventDefault();
  const input = $('chatInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  if (dataConn && dataConn.open) {
    dataConn.send({ type: 'chat', value: text });
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
  if (data.type === 'hello') {
    remoteName = String(data.value || 'Correspondant');
    $('remoteLabel').textContent = remoteName;
    $('remoteAvatar').textContent = remoteName[0] || '?';
  }
  if (data.type === 'chat') addChatMsg(remoteName, data.value, false);
  if (data.type === 'emoji') showFloatingEmoji(data.value);
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
  if (currentCall) currentCall.close();
  if (dataConn) dataConn.close();
  if (peer) peer.destroy();
  dataConn = null;
  isHost = false;
  remoteName = 'Correspondant';
  $('remoteLabel').textContent = 'En attente…';
  $('remoteAvatar').textContent = '?';
  $('remoteAvatar').style.display = 'flex';
  if (localStream) localStream.getTracks().forEach(t => t.stop());
  if (screenStream) screenStream.getTracks().forEach(t => t.stop());

  currentCall = null;
  peer = null;
  localStream = null;
  screenStream = null;
  isScreenSharing = false;
  isMicOn = true;
  isCamOn = true;

  $('local').srcObject = null;
  $('remote').srcObject = null;
  $('call').classList.remove('active');
  $('join').style.display = 'flex';
  $('chatLog').innerHTML = '';
  $('inviteBox').classList.add('hidden');
  $('btnMic').classList.remove('off');
  $('btnCam').classList.remove('off');
  $('local').style.display = 'block';

  // Redémarrer l'aperçu
  initPreview();
}

// ============================================================
// DÉMARRAGE
// ============================================================
window.addEventListener('DOMContentLoaded', () => {
  // Pré-remplir le pseudo mémorisé
  try {
    const saved = localStorage.getItem('pliPseudo');
    if (saved && !$('name').value) $('name').value = saved;
  } catch (e) {}
  initPreview();
});
