/* =========================================================
   Pli Call — script.js
   Optimisé basse connexion (bitrate limité, audio prioritaire,
   désactivation auto vidéo, résolution adaptative)
   ========================================================= */

// ---------- Configuration "basse connexion" ----------
const CONFIG = {
  // Contraintes vidéo modestes => moins de bande passante
  videoConstraints: {
    width:  { ideal: 320, max: 640 },
    height: { ideal: 240, max: 480 },
    frameRate: { ideal: 12, max: 20 }
  },
  audioConstraints: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true
  },
  // Bitrates max (kbps) pour limiter l'upload
  maxVideoBitrate: 200_000,   // 200 kbps
  maxAudioBitrate: 32_000,    // 32 kbps
  // ICE servers : STUN only (pas de TURN = plus léger, mais moins universel)
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ],
  // Seuil de détection "mauvaise connexion"
  lowNetworkThreshold: 3      // ratio de paquets perdus estimé
};

// ---------- État global ----------
let peer = null;
let currentCall = null;
let localStream = null;
let screenStream = null;
let roomCode = null;
let isMicOn = true;
let isCamOn = true;
let isScreenSharing = false;
let dataSaver = true;         // mode basse connexion (vidéo off par défaut ?)
let callStart = 0;
let clockInterval = null;
let netCheckInterval = null;

const $ = (id) => document.getElementById(id);

// ---------- Utilitaires ----------
function generateCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function setStatus(msg, kind = '') {
  const el = $('status');
  if (!el) return;
  el.textContent = msg;
  el.style.color = kind === 'error' ? '#ea4335'
                 : kind === 'ok'    ? '#34a853'
                 : '#9aa0a6';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  })[c]);
}

function showToast(msg) {
  // Petit toast discret
  const t = document.createElement('div');
  t.textContent = msg;
  t.style.cssText = `
    position:fixed;bottom:110px;left:50%;transform:translateX(-50%);
    background:#3c4043;color:#fff;padding:10px 16px;border-radius:999px;
    font-size:13px;z-index:9999;opacity:0;transition:opacity .25s;
  `;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.style.opacity = '1');
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 1800);
}

// ---------- Accueil ----------
function createRoom() {
  const name = $('name').value.trim();
  if (!name) return setStatus('Renseigne ton pseudo.', 'error');
  roomCode = generateCode();
  $('code_out').textContent = roomCode;
  $('inviteBox').classList.remove('hidden');
  setStatus('Réunion créée. Partage le code.', 'ok');
}

function copyCode() {
  if (!roomCode) return;
  navigator.clipboard.writeText(roomCode)
    .then(() => {
      const hint = $('copyHint');
      hint.classList.remove('hidden');
      setTimeout(() => hint.classList.add('hidden'), 1500);
    })
    .catch(() => setStatus('Copie impossible.', 'error'));
}

function joinRoom() {
  const code = $('code').value.trim().toUpperCase();
  if (!code) return setStatus('Renseigne un code de réunion.', 'error');
  roomCode = code;
  enterCall();
}

// ---------- Entrée en réunion ----------
async function enterCall() {
  const name = $('name').value.trim() || 'Anonyme';

  $('join').style.display = 'none';
  $('call').classList.add('active');
  $('roomLabel').textContent = 'Réunion ' + roomCode;
  $('selfLabel').textContent = name;
  $('selfAvatar').textContent = name.charAt(0).toUpperCase();
  $('remoteAvatar').textContent = '?';

  // 1) Obtenir les médias (audio d'abord pour prioriser la voix)
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: CONFIG.audioConstraints,
      video: CONFIG.videoConstraints
    });
    $('local').srcObject = localStream;
  } catch (err) {
    console.error(err);
    // Fallback : audio seul (utile en très basse connexion)
    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: CONFIG.audioConstraints, video: false
      });
      localStream.getVideoTracks().length = 0;
      $('local').style.display = 'none';
      $('selfAvatar').style.display = 'flex';
      isCamOn = false;
      $('btnCam').classList.add('off');
      showToast('Caméra indisponible — audio seul activé');
    } catch (err2) {
      alert('Impossible d\'accéder au micro/caméra : ' + err2.message);
      hangup();
      return;
    }
  }

  // 2) Créer le Peer (STUN seulement, léger)
  peer = new Peer('pli-' + roomCode, {
    config: { iceServers: CONFIG.iceServers },
    debug: 1
  });

  peer.on('open', (id) => {
    console.log('Peer connecté :', id);
    updateNetBadge('ok', 'En ligne');
    startClock();
    startNetCheck();
  });

  peer.on('call', (call) => {
    // On répond avec notre flux (audio d'abord)
    call.answer(localStream);
    currentCall = call;
    attachCall(call);
  });

  peer.on('error', (err) => {
    console.error('Peer error:', err);
    if (err.type === 'unavailable-id') {
      setStatus('Ce code est déjà utilisé. Réessaie.', 'error');
      showToast('Code déjà pris');
      hangup();
    } else if (err.type === 'network') {
      updateNetBadge('bad', 'Réseau');
    }
  });

  peer.on('disconnected', () => {
    updateNetBadge('warn', 'Reconnexion…');
    try { peer.reconnect(); } catch (_) {}
  });
}

// ---------- Gestion de l'appel ----------
function attachCall(call) {
  // Limiter le bitrate dès que possible
  applyBitrateLimits(call);

  call.on('stream', (remoteStream) => {
    const remote = $('remote');
    remote.srcObject = remoteStream;
    remote.style.display = 'block';
    $('remoteAvatar').style.display = 'none';
    $('remoteLabel').textContent = 'Correspondant';

    // Si la piste vidéo arrive plus tard, on ne bloque pas l'audio
    remoteStream.getVideoTracks().forEach(track => {
      track.onmute = () => { $('remoteAvatar').style.display = 'flex'; };
      track.onunmute = () => { $('remoteAvatar').style.display = 'none'; };
    });
  });

  call.on('data', (data) => {
    if (data.type === 'chat')  addChatMsg(data.author || 'Correspondant', data.value);
    if (data.type === 'emoji') showFloatingEmoji(data.value);
  });

  call.on('close', () => {
    $('remote').srcObject = null;
    $('remote').style.display = 'none';
    $('remoteAvatar').style.display = 'flex';
    $('remoteLabel').textContent = 'Appel terminé';
    updateNetBadge('bad', 'Terminé');
  });

  call.on('error', (err) => {
    console.error(err);
    showToast('Erreur d\'appel');
  });
}

// ---------- Limitation de bande passante ----------
async function applyBitrateLimits(call) {
  const pc = call.peerConnection;
  if (!pc) return;

  // SDP tweak : limiter le bitrate vidéo
  try {
    const senders = pc.getSenders();
    for (const sender of senders) {
      const params = sender.getParameters();
      if (!params.encodings) params.encodings = [{}];
      if (sender.track && sender.track.kind === 'video') {
        params.encodings[0].maxBitrate = CONFIG.maxVideoBitrate;
        params.encodings[0].scaleResolutionDownBy = 1.5; // réduit la résolution
      }
      if (sender.track && sender.track.kind === 'audio') {
        params.encodings[0].maxBitrate = CONFIG.maxAudioBitrate;
      }
      await sender.setParameters(params);
    }
  } catch (e) {
    console.warn('Bitrate limits non appliquées:', e);
  }

  // Surveillance qualité
  if (typeof call.peerConnection.getStats === 'function') {
    startQualityMonitor(pc);
  }
}

function startQualityMonitor(pc) {
  setInterval(async () => {
    try {
      const stats = await pc.getStats();
      let videoLoss = 0, audioLoss = 0;
      stats.forEach(report => {
        if (report.type === 'inbound-rtp') {
          if (report.kind === 'video') videoLoss = report.packetsLost || 0;
          if (report.kind === 'audio') audioLoss = report.packetsLost || 0;
        }
      });
      const totalLoss = videoLoss + audioLoss;

      const tag = $('remoteQuality');
      if (totalLoss > 100) {
        tag.textContent = 'Réseau faible';
        tag.className = 'quality-tag show bad';
        updateNetBadge('bad', 'Faible');
      } else if (totalLoss > 20) {
        tag.textContent = 'Réseau moyen';
        tag.className = 'quality-tag show low';
        updateNetBadge('warn', 'Moyen');
      } else {
        tag.className = 'quality-tag';
        updateNetBadge('ok', 'Bon');
      }
    } catch (_) {}
  }, 4000);
}

function startNetCheck() {
  netCheckInterval = setInterval(() => {
    if (!peer || peer.destroyed) return;
    if (peer.disconnected) updateNetBadge('warn', 'Déconnecté');
  }, 3000);
}

// ---------- Contrôles utilisateur ----------
function toggleMic() {
  if (!localStream) return;
  isMicOn = !isMicOn;
  localStream.getAudioTracks().forEach(t => (t.enabled = isMicOn));
  $('btnMic').classList.toggle('off', !isMicOn);
  $('btnMic').querySelector('.ico').textContent = isMicOn ? '🎤' : '🔇';
  showToast(isMicOn ? 'Micro activé' : 'Micro coupé');
}

function toggleCam() {
  if (!localStream) return;
  isCamOn = !isCamOn;
  localStream.getVideoTracks().forEach(t => (t.enabled = isCamOn));
  $('btnCam').classList.toggle('off', !isCamOn);
  $('local').style.display = isCamOn ? 'block' : 'none';
  $('selfAvatar').style.display = isCamOn ? 'none' : 'flex';
  $('btnCam').querySelector('.ico').textContent = isCamOn ? '📷' : '📵';
  showToast(isCamOn ? 'Caméra activée' : 'Caméra coupée');
}

async function toggleScreen() {
  if (!currentCall) return showToast('Aucun correspondant');

  if (!isScreenSharing) {
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 10 }, audio: false
      });
      const videoTrack = screenStream.getVideoTracks()[0];
      const sender = currentCall.peerConnection
        .getSenders().find(s => s.track && s.track.kind === 'video');
      if (sender) await sender.replaceTrack(videoTrack);

      $('local').srcObject = screenStream;
      isScreenSharing = true;
      videoTrack.onended = () => stopScreenShare();
    } catch (err) {
      console.warn('Partage annulé :', err);
    }
  } else {
    stopScreenShare();
  }
}

async function stopScreenShare() {
  if (!screenStream) return;
  const videoTrack = localStream.getVideoTracks()[0];
  const sender = currentCall?.peerConnection
    .getSenders().find(s => s.track && s.track.kind === 'video');
  if (sender && videoTrack) await sender.replaceTrack(videoTrack);

  screenStream.getTracks().forEach(t => t.stop());
  screenStream =
