const loginScreen = document.getElementById('login');
const callScreen = document.getElementById('call');
const pseudoInput = document.getElementById('pseudo');
const joinBtn = document.getElementById('joinBtn');
const leaveBtn = document.getElementById('leaveBtn');
const chatForm = document.getElementById('chatForm');
const chatInput = document.getElementById('chatInput');
const messages = document.getElementById('messages');
const participants = document.getElementById('participants');

let pseudo = '';

function showScreen(screen) {
  loginScreen.classList.remove('active');
  callScreen.classList.remove('active');
  screen.classList.add('active');
}

joinBtn.addEventListener('click', () => {
  pseudo = pseudoInput.value.trim();
  if (!pseudo) return;
  participants.innerHTML = `<div class="participant">${pseudo} (toi)</div>`;
  showScreen(callScreen);
});

leaveBtn.addEventListener('click', () => {
  messages.innerHTML = '';
  showScreen(loginScreen);
});

chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  const msg = document.createElement('div');
  msg.textContent = `${pseudo} : ${text}`;
  messages.appendChild(msg);
  messages.scrollTop = messages.scrollHeight;
  chatInput.value = '';
});script.js
