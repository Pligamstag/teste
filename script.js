// ---------- Variables globales ----------
let peer = null;
let currentCall = null;
let localStream = null;
let screenStream = null;
let roomCode = null;
let isMicOn = true;
let isCamOn = true;
let isScreenSharing = false;

const $ = (id) => document.getElementById(id);

// ---------- Création de réunion ----------
function createRoom() {
  const name = $('name').value.trim();
  if (!name) return alert('Renseigne un pseudo.');
  roomCode = generateCode();
  $('code_out').textContent = roomCode;
  $('inviteBox').classList.remove('hidden');
}

function generateCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function copyCode() {
  navigator.clipboard.writeText(roomCode)
    .then(() => alert('Code copié !'))
    .catch(() => alert('Copie impossible'));
}

// ---------- Rejoindre une réunion ----------
function joinRoom() {
  const code = $('code').value.trim().toUpperCase();
  if (!code) return alert('Renseigne un code.');
  roomCode = code;
  enterCall();
}

// ---------- Entrer dans l'appel ----------
async function enterCall() {
  const name = $('name').value.trim() || 'Anonyme';
  $('selfLabel').textContent = name;
  $('join').style.display = 'none';
  $('call').classList.add('active');

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true
    });
    $('local').srcObject = localStream;
  } catch (err) {
    alert('Impossible d\'accéder à la caméra/micro : ' + err.message);
    return;
  }

  peer = new Peer('pli-' + roomCode, {
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    }
  });

  peer.on('open', (id) => {
    console.log('Peer connecté :', id);
    $('status').textContent = 'Connecté au serveur.';
  });

  peer.on('call', (call) => {
    call.answer(localStream);
    currentCall = call;
    attachRemote(call);
  });

  peer.on('error', (err) => {
    console.error(err);
    if (err.type === 'unavailable-id') {
      alert('Ce code de réunion est déjà utilisé. Essaie d\'en rejoindre un autre.');
      hangup();
    }
  });
}

function attachRemote(call) {
  call.on('stream', (remoteStream) => {
    $('remote').srcObject = remoteStream;
    $('remote').style.display = 'block';
    $('remoteAvatar').style.display = 'none';
  });
  call.on('close', () => {
    $('remote').srcObject = null;
    $('remoteAvatar').style.display = 'flex';
    $('remoteLabel').textContent = 'Appel terminé';
  });
}

// ---------- Contrôles ----------
function toggleMic() {
  if (!localStream) return;
  isMicOn = !isMicOn;
  localStream.getAudioTracks().forEach(t => (t.enabled = isMicOn));
  $('btnMic').classList.toggle('off', !isMicOn);
}

function toggleCam() {
  if (!localStream) return;
  isCamOn = !isCamOn;
  localStream.getVideoTracks().forEach(t => (t.enabled = isCamOn));
  $('btnCam').classList.toggle('off', !isCamOn);
}

async function toggleScreen() {
  if (!currentCall) return;

  if (!isScreenSharing) {
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const videoTrack = screenStream.getVideoTracks()[0];
      const sender = currentCall.peerConnection
        .getSenders()
        .find(s => s.track && s.track.kind === 'video');
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
  const sender = currentCall.peerConnection
    .getSenders()
    .find(s => s.track && s.track.kind === 'video');
  if (sender && videoTrack) await sender.replaceTrack(videoTrack);

  screenStream.getTracks().forEach(t => t.stop());
  screenStream = null;
  isScreenSharing = false;
  $('local').srcObject = localStream;
}

function toggleEmoji() {
  $('emojiPanel').classList.toggle('show');
  $('menu').classList.remove('show');
  const panel = $('emojiPanel');
  if (!panel.dataset.filled) {
    ['👍','👎','😂','❤️','🎉','😮','😢','👏'].forEach(e => {
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
    showFloatingEmoji(emoji);
  }
  $('emojiPanel').classList.remove('show');
}

function showFloatingEmoji(emoji) {
  const el = document.createElement('div');
  el.textContent = emoji;
  el.style.cssText = `
    position:fixed;bottom:100px;left:50%;transform:translateX(-50%);
    font-size:64px;pointer-events:none;z-index:999;
    animation:floatUp 2s ease-out forwards;
  `;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2000);
}

// Animation CSS injectée dynamiquement
const style = document.createElement('style');
style.textContent = `
  @keyframes floatUp {
    0%   { opacity: 1; transform: translate(-50%, 0) scale(1); }
    100% { opacity: 0; transform: translate(-50%, -200px) scale(1.6); }
  }
`;
document.head.appendChild(style);

function toggleChat() {
  $('chatPanel').classList.toggle('open');
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
  addChatMsg('Moi', text);
}

function addChatMsg(author, text) {
  const div = document.createElement('div');
  div.className = 'msg';
  div.innerHTML = `<b>${escapeHtml(author)}</b> : ${escapeHtml(text)}`;
  $('chatLog').appendChild(div);
  $('chatLog').scrollTop = $('chatLog').scrollHeight;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  })[c]);
}

function toggleFull() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
  } else {
    document.exitFullscreen();
  }
}

function toggleMenu() {
  $('menu').classList.toggle('show');
  $('emojiPanel').classList.remove('show');
}

async function switchDevice(kind) {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const list = devices.filter(d => d.kind === kind);
    if (!list.length) return alert('Aucun périphérique trouvé.');
    const choice = prompt(
      'Choisis un périphérique (numéro) :\n' +
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

    const oldTracks = (kind === 'audioinput'
      ? localStream.getAudioTracks()
      : localStream.getVideoTracks());
    oldTracks.forEach(t => { t.stop(); localStream.removeTrack(t); });
    localStream.addTrack(newTrack);

    if (kind === 'videoinput') $('local').srcObject = localStream;
  } catch (err) {
    console.error(err);
    alert('Impossible de changer de périphérique.');
  }
}

function hangup() {
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

  $('local').srcObject = null;
  $('remote').srcObject = null;
  $('call').classList.remove('active');
  $('join').style.display = 'flex';
  $('chatLog').innerHTML = '';
  $('inviteBox').classList.add('hidden');
  $('btnMic').classList.remove('off');
  $('btnCam').classList.remove('off');
}

// ---------- Réception des messages data ----------
function handleData(data) {
  if (data.type === 'chat') addChatMsg('Correspondant', data.value);
  if (data.type === 'emoji') showFloatingEmoji(data.value);
}

// Hook : attacher le handler data quand un appel arrive
const _attachRemote = attachRemote;
attachRemote = function(call) {
  _attachRemote(call);
  call.on('data', handleData);
};

// Idem pour l'appelant (si tu ajoutes un bouton "appeler")
// -> il suffira d'ajouter : call.on('data', handleData);
