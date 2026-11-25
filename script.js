// ============================================================
// Pli Call — Version "Meet-like" avec mode basse connexion
// ============================================================

let peer = null;
let currentCall = null;
let dataConn = null;
let joinTimer = null;
let openTimer = null;
let peerOpened = false;
let usingRelay = false;
let redials = 0;
let discTimer = null;
const dbgLines = [];
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
    localStream = await getLocalMedia();
    $('local').srcObject = localStream;
    $('selfAvatar').style.display = 'none';
    dbg('Micro/caméra OK (' + localStream.getTracks().map(t => t.kind).join('+') + ')');
    keepAwake();

    // Détecter une caméra qui ne renvoie aucune image (déjà utilisée ailleurs, masquée…)
    const camTrack = localStream.getVideoTracks()[0];
    if (camTrack) {
      console.log('Caméra :', camTrack.label, camTrack.getSettings());
      const warn = () => {
        $('selfLabel').textContent = myName + ' — caméra sans image (déjà utilisée ?)';
        $('selfAvatar').style.display = 'flex';
      };
      camTrack.onmute = warn;
      camTrack.onunmute = () => {
        $('selfLabel').textContent = myName;
        if (isCamOn) $('selfAvatar').style.display = 'none';
      };
      if (camTrack.muted) warn();
    } else {
      // Pas de caméra (refusée ou absente) : on rejoint en audio seul
      isCamOn = false;
      $('local').style.display = 'none';
      $('selfAvatar').style.display = 'flex';
      $('btnCam').classList.add('off');
    }

    if (quality === 'audio') {
      $('local').style.display = 'none';
      $('selfAvatar').style.display = 'flex';
      $('btnCam').classList.add('off');
    }
  } catch (err) {
    alert('Impossible d\'accéder au micro : ' + err.message +
      '\nAutorise le micro (et la caméra) pour ce site dans le navigateur, puis réessaie.');
    hangup();
    return;
  }

  startPeer(false);
}

// ---- Diagnostic (copiable depuis Options) ----
function dbg(msg) {
  const t = new Date().toLocaleTimeString('fr-FR');
  dbgLines.push(t + ' ' + msg);
  if (dbgLines.length > 80) dbgLines.shift();
  console.log('[pli]', msg);
}
// Affiche le diagnostic en plein écran (lisible, photographiable : pas besoin de copier-coller)
function showDiag() {
  const menu = $('menu'); if (menu) menu.classList.remove('show');
  const count = (s) => dbgLines.filter(l => l.includes(s)).length;
  const lastIce = [...dbgLines].reverse().find(l => l.includes('ICE :')) || '—';
  const summary =
    'RÉSUMÉ\n' +
    'Rôle : ' + (isHost ? 'hôte' : 'invité') + ' · mode : ' + (usingRelay ? 'relais seul' : 'automatique') + '\n' +
    'Serveur de mise en relation joint : ' + (peerOpened ? 'oui' : 'NON') + '\n' +
    'Candidats → host : ' + count('candidat host') + ' · srflx : ' + count('candidat srflx') +
    ' · relay : ' + count('candidat relay') + '\n' +
    'Erreurs serveurs STUN/TURN : ' + count('erreur serveur') + '\n' +
    'Dernier état ICE : ' + lastIce.replace(/^\S+\s/, '') + '\n' +
    'Navigateur : ' + navigator.userAgent + '\n\n' +
    'JOURNAL\n';

  let p = $('diagPanel');
  if (!p) {
    p = document.createElement('div');
    p.id = 'diagPanel';
    p.style.cssText = 'position:fixed;inset:0;z-index:500;background:#101114;color:#e8eaed;' +
      'font:13px/1.5 ui-monospace,Consolas,monospace;padding:56px 16px 16px;overflow:auto;' +
      'white-space:pre-wrap;word-break:break-word;';
    const close = document.createElement('button');
    close.textContent = '✕ Fermer';
    close.style.cssText = 'position:fixed;top:10px;right:10px;z-index:501;';
    close.onclick = () => { p.style.display = 'none'; close.style.display = 'none'; };
    p._close = close;
    document.body.appendChild(p);
    document.body.appendChild(close);
  }
  p.textContent = summary + (dbgLines.length ? dbgLines.join('\n') : '(rien d\'enregistré pour l\'instant : essaie de rejoindre une réunion d\'abord)');
  p.style.display = 'block';
  p._close.style.display = 'inline-flex';
}

// Crée (ou recrée) la connexion au serveur de mise en relation.
//  - l'hôte prend l'ID fixe "pli-CODE", l'invité un ID aléatoire et appelle l'hôte
//  - relayOnly = true : tout passe par le relais TURN chiffré (TLS/443), qui ressemble
//    à du HTTPS et traverse la plupart des pare-feux (lycée, entreprise…).
//    C'est activé automatiquement si la connexion directe échoue.
function startPeer(relayOnly) {
  usingRelay = relayOnly;
  dbg('Connexion au serveur de mise en relation (' + (relayOnly ? 'relais sécurisé seul' : 'automatique') + ')');

  const TURN_USER = '403d8a7db25a819098d7d8c9';
  const TURN_PASS = 'go7c76Oi2qYbDGN1';
  const peerConfig = {
    config: {
      iceTransportPolicy: relayOnly ? 'relay' : 'all',
      iceServers: [
        { urls: 'stun:stun.relay.metered.ca:80' },
        { urls: 'turn:global.relay.metered.ca:80', username: TURN_USER, credential: TURN_PASS },
        { urls: 'turn:global.relay.metered.ca:80?transport=tcp', username: TURN_USER, credential: TURN_PASS },
        { urls: 'turn:global.relay.metered.ca:443', username: TURN_USER, credential: TURN_PASS },
        { urls: 'turns:global.relay.metered.ca:443?transport=tcp', username: TURN_USER, credential: TURN_PASS }
      ]
    }
  };
  const hostId = 'pli-' + roomCode;
  if (typeof Peer === 'undefined') {
    alert('Impossible de charger le service d\'appel (PeerJS). Vérifie ta connexion internet et recharge la page.');
    hangup();
    return;
  }
  peerOpened = false;
  clearTimeout(openTimer);
  // Si le serveur de mise en relation ne répond jamais (réseau qui le bloque)
  openTimer = setTimeout(() => {
    if (!peerOpened && peer) {
      dbg('Serveur de mise en relation injoignable (15 s)');
      alert('Impossible de joindre le serveur de connexion (réseau qui le bloque ?).\nEssaie avec un autre réseau (4G, partage de connexion).');
      hangup();
    }
  }, 15000);
  peer = isHost ? new Peer(hostId, peerConfig) : new Peer(peerConfig);

  peer.on('open', (id) => {
    peerOpened = true;
    clearTimeout(openTimer);
    dbg('Serveur joint, mon id = ' + id);
    $('remoteLabel').textContent = isHost ? 'En attente d\'un participant…' : 'Connexion à la réunion…';
    if (!isHost) connectToHost(hostId);
  });

  // L'hôte reçoit l'appel et le canal de données
  peer.on('call', (call) => {
    dbg('Appel entrant');
    if (currentCall) { currentCall._ignoreClose = true; try { currentCall.close(); } catch (e) {} }
    call.answer(localStream);
    currentCall = call;
    attachRemote(call);
  });
  peer.on('connection', (conn) => setupData(conn));

  const me = peer;
  peer.on('disconnected', () => {
    if (me !== peer) return;   // ancien peer remplacé (bascule relais) : on ne le reconnecte pas
    try { me.reconnect(); } catch (e) {}
  });

  peer.on('error', (err) => {
    console.error(err);
    dbg('Erreur PeerJS : ' + err.type);
    if (err.type === 'unavailable-id') {
      alert('Ce code de réunion est déjà utilisé.');
      hangup();
    } else if (err.type === 'peer-unavailable') {
      alert('Réunion introuvable. Vérifie le code, et que l\'hôte a bien cliqué sur « Rejoindre ».');
      hangup();
    } else if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error' || err.type === 'socket-closed') {
      if (!peerOpened) {
        alert('Le serveur de connexion ne répond pas. Réessaie dans un instant.');
        hangup();
      } else {
        $('remoteLabel').textContent = 'Problème de connexion au serveur…';
      }
    } else {
      $('remoteLabel').textContent = 'Erreur de connexion (' + err.type + ')';
    }
  });
}

// Micro + caméra, avec repli en audio seul si la caméra est refusée ou absente
async function getLocalMedia() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('connexion non sécurisée : le site doit être ouvert en HTTPS');
  }
  try {
    return await navigator.mediaDevices.getUserMedia(getConstraintsForQuality(quality));
  } catch (e) {
    if (quality === 'audio') throw e;
    console.warn('Caméra indisponible, passage en audio seul :', e);
    return await navigator.mediaDevices.getUserMedia(getConstraintsForQuality('audio'));
  }
}

// Invité : si la connexion directe n'aboutit pas, on retente tout via le relais sécurisé
function retryWithRelay() {
  if (usingRelay || isHost || !localStream) return;
  dbg('Pas de connexion directe : bascule automatique en mode relais sécurisé');
  clearTimeout(joinTimer);
  if (currentCall) { currentCall._ignoreClose = true; try { currentCall.close(); } catch (e) {} }
  try { if (dataConn) dataConn.close(); } catch (e) {}
  try { if (peer) peer.destroy(); } catch (e) {}
  currentCall = null; dataConn = null; peer = null;
  $('remote').srcObject = null;
  $('remoteLabel').textContent = 'Nouvelle tentative via le relais sécurisé…';
  startPeer(true);
}

// Invité : relance l'appel (et le canal de chat) vers l'hôte après une coupure, 3 essais max
function redial() {
  if (isHost || !peer || peer.destroyed || !localStream) return;
  if (redials >= 3) {
    dbg('Reconnexion impossible après 3 essais');
    $('remoteLabel').textContent = 'Connexion impossible. Quitte et rejoins à nouveau.';
    return;
  }
  redials++;
  dbg('Reconnexion automatique (' + redials + '/3)');
  const hostId = 'pli-' + roomCode;
  if (currentCall) { currentCall._ignoreClose = true; try { currentCall.close(); } catch (e) {} }
  try { if (dataConn) dataConn.close(); } catch (e) {}
  $('remoteLabel').textContent = 'Reconnexion…';
  $('remote').srcObject = null;
  setupData(peer.connect(hostId, { reliable: true }));
  const call = peer.call(hostId, localStream);
  if (!call) return;
  currentCall = call;
  attachRemote(call);
}

function connectToHost(hostId) {
  // Pas de flux après 10 s → on bascule sur le relais ; puis message clair si ça échoue encore
  clearTimeout(joinTimer);
  joinTimer = setTimeout(() => {
    if ($('remote').srcObject) return;
    if (!usingRelay) retryWithRelay();
    else $('remoteLabel').textContent = 'Pas de réponse. Vérifie le code et que l\'hôte est bien dans l\'appel.';
  }, usingRelay ? 20000 : 10000);
  dbg('Appel de l\'hôte ' + hostId);
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
    sendCamState();
  });
  conn.on('data', handleData);
  conn.on('close', () => { dataConn = null; });
}

function attachRemote(call) {
  // Suivi de l'état réel de la connexion réseau (diagnostic visible)
  const pc = call.peerConnection;
  if (pc && pc.addEventListener) {
    // addEventListener (et pas onXxx) pour ne pas écraser les handlers internes de PeerJS
    pc.addEventListener('icecandidate', (e) => {
      if (e.candidate) dbg('candidat ' + e.candidate.type + ' ' + (e.candidate.protocol || ''));
    });
    pc.addEventListener('icecandidateerror', (e) => dbg('erreur serveur ' + (e.url || '') + ' code ' + e.errorCode));
    pc.addEventListener('iceconnectionstatechange', () => {
      const s = pc.iceConnectionState;
      dbg('ICE : ' + s);
      if (call._ignoreClose) return;
      clearTimeout(discTimer);
      if (s === 'checking') $('remoteLabel').textContent = 'Connexion en cours…';
      if (s === 'connected' || s === 'completed') {
        $('remoteLabel').textContent = remoteName;
        redials = 0;
      }
      if (s === 'disconnected') {
        $('remoteLabel').textContent = 'Connexion instable…';
        // Si ça ne revient pas tout seul en 6 s, l'invité relance l'appel
        discTimer = setTimeout(() => {
          if (call._ignoreClose || isHost) return;
          if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
            usingRelay ? redial() : retryWithRelay();
          }
        }, 6000);
      }
      if (s === 'failed') {
        if (isHost) { $('remoteLabel').textContent = 'Connexion perdue, en attente de l\'autre personne…'; return; }
        return usingRelay ? redial() : retryWithRelay();
      }
    });
  }

  call.on('stream', (remoteStream) => {
    const v = $('remote');
    // PeerJS émet cet évènement une fois par piste (audio + vidéo) avec le même flux :
    // ne pas le réassigner, sinon la lecture en cours est interrompue.
    if (v.srcObject === remoteStream) { applyRemoteCam(); return; }
    v.srcObject = remoteStream;
    $('remoteLabel').textContent = remoteName;
    dbg('Flux de l\'autre personne reçu (' + remoteStream.getTracks().map(t => t.kind).join('+') + ')');
    v.style.display = 'block';
    remoteFrameOk = false;
    applyRemoteCam();
    watchRemoteFrames();
    // Lecture : si le navigateur refuse le son sans clic (NotAllowedError), on lance l'image
    // en muet et on affiche un vrai bouton « Activer le son » (visible, sur PC comme mobile).
    v.muted = false;
    const p = v.play();
    if (p && p.catch) p.catch((err) => {
      dbg('lecture : ' + (err && err.name));
      if (err && err.name === 'NotAllowedError') {
        v.muted = true;
        v.play().catch(() => {});
        showUnmuteButton(v);
      }
    });
  });
  call.on('close', () => {
    if (call._ignoreClose) return;
    dbg('Appel terminé');
    clearInterval(frameTimer);
    remoteFrameOk = false;
    if ($('unmuteBtn')) $('unmuteBtn').remove();
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
  sendCamState();
}

// Prévient l'autre personne que la caméra est allumée/coupée
let remoteCamOn = true;
function sendCamState() {
  if (dataConn && dataConn.open) dataConn.send({ type: 'cam', value: isCamOn });
}
// On montre l'image seulement si l'autre a sa caméra allumée ET que des images arrivent vraiment.
// Sinon (caméra coupée, absente, ou image toute noire) : avatar. Ça ne dépend plus du seul
// message « cam », qui n'arrive pas si le canal de données n'a pas pu s'ouvrir.
let remoteFrameOk = false;
let frameTimer = null;
function applyRemoteCam() {
  const show = remoteCamOn && remoteFrameOk;
  $('remoteAvatar').style.display = show ? 'none' : 'flex';
}
function watchRemoteFrames() {
  clearInterval(frameTimer);
  const v = $('remote');
  let canvas, ctx, dark = 0;
  try {
    canvas = document.createElement('canvas');
    canvas.width = canvas.height = 8;
    ctx = canvas.getContext('2d', { willReadFrequently: true });
  } catch (e) { ctx = null; }
  frameTimer = setInterval(() => {
    let ok;
    try {
      if (!(v.videoWidth > 0 && v.readyState >= 2)) ok = false;       // aucune image reçue
      else if (!ctx) ok = true;                                        // pas de canvas : on fait confiance
      else {
        ctx.drawImage(v, 0, 0, 8, 8);
        const d = ctx.getImageData(0, 0, 8, 8).data;
        let sum = 0;
        for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
        ok = sum > 64 * 3 * 2;                                         // pas entièrement noir
      }
    } catch (e) { ok = true; }
    if (ok) { dark = 0; if (!remoteFrameOk) { remoteFrameOk = true; applyRemoteCam(); } }
    else if (++dark >= 3 && remoteFrameOk) { remoteFrameOk = false; applyRemoteCam(); }
  }, 1000);
}

function showUnmuteButton(v) {
  let b = $('unmuteBtn');
  if (!b) {
    b = document.createElement('button');
    b.id = 'unmuteBtn';
    b.className = 'primary';
    b.textContent = '🔊 Activer le son';
    b.style.cssText = 'position:absolute;top:14px;left:50%;transform:translateX(-50%);z-index:6;';
    b.onclick = () => { v.muted = false; v.play().catch(() => {}); b.remove(); };
    $('remoteTile').appendChild(b);
  }
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
  if (data.type === 'cam') {
    remoteCamOn = !!data.value;
    applyRemoteCam();
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

// ---- Caméra avant / arrière (mobile) ----
let facing = 'user';
async function flipCamera() {
  $('menu').classList.remove('show');
  if (!localStream || !localStream.getVideoTracks()[0]) {
    return alert('Active d\'abord la caméra (mode audio uniquement).');
  }
  const next = facing === 'user' ? 'environment' : 'user';
  const p = QUALITY_PRESETS[quality] || QUALITY_PRESETS.low;
  const old = localStream.getVideoTracks()[0];
  try {
    old.stop(); // un mobile ne peut souvent pas ouvrir deux caméras à la fois
    const s = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: next },
        width: { ideal: p.width || 160 },
        height: { ideal: p.height || 120 },
        frameRate: { ideal: p.fps || 10, max: p.fps || 10 }
      }
    });
    const t = s.getVideoTracks()[0];
    t.enabled = isCamOn;
    if (currentCall) {
      const sender = currentCall.peerConnection.getSenders()
        .find(x => x.track && x.track.kind === 'video');
      if (sender) await sender.replaceTrack(t);
    }
    localStream.removeTrack(old);
    localStream.addTrack(t);
    $('local').srcObject = localStream;
    facing = next;
  } catch (e) {
    console.error(e);
    await replaceVideoTrack(quality);   // on récupère la caméra précédente
    alert('Impossible de changer de caméra.');
  }
}

// ---- Garder l'écran allumé pendant l'appel (mobile) ----
let wakeLock = null;
async function keepAwake() {
  try {
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  } catch (e) {}
}
function releaseAwake() {
  try { if (wakeLock) wakeLock.release(); } catch (e) {}
  wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && peer) keepAwake();
});

// ---- Quitter ----
function hangup() {
  clearTimeout(joinTimer);
  clearTimeout(openTimer);
  clearTimeout(discTimer);
  usingRelay = false;
  redials = 0;
  if (currentCall) currentCall.close();
  if (dataConn) dataConn.close();
  if (peer) peer.destroy();
  dataConn = null;
  isHost = false;
  remoteName = 'Correspondant';
  remoteCamOn = true;
  clearInterval(frameTimer);
  remoteFrameOk = false;
  if ($('unmuteBtn')) $('unmuteBtn').remove();
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

  releaseAwake();
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

  // Adapter l'interface à l'appareil
  const isTouch = window.matchMedia('(pointer: coarse)').matches;
  const hide = (id) => { const el = $(id); if (el) el.style.display = 'none'; };
  if (!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia)) {
    hide('btnScreen');                           // pas de partage d'écran sur mobile
  }
  if (!document.documentElement.requestFullscreen) {
    hide('btnFull');                             // iPhone / Safari
  }
  if (isTouch) {
    const flip = $('btnFlip');
    if (flip) flip.classList.remove('hidden');   // caméra avant/arrière
    hide('btnPickCam');                          // sélecteur par prompt() peu adapté au tactile
    hide('btnPickMic');
  }
  // L'aperçu caméra à l'accueil n'est plus lancé : il allumait la caméra
  // (et demandait l'autorisation) avant même de rejoindre un appel.
});
