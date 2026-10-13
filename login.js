'use strict';

const loginForm = document.getElementById('login-form');
const employeeInput = document.getElementById('employee-id');
const passwordInput = document.getElementById('password');
const loginButton = document.getElementById('login-btn');
const loginMessage = document.getElementById('login-message');
const demoHint = document.getElementById('demo-hint');

function setLoginMessage(text, type) {
  loginMessage.textContent = text;
  loginMessage.className = 'message ' + (type || '');
}

// Only shown while Auth is in demo mode.
if (Auth.demoHint) {
  demoHint.textContent = Auth.demoHint;
  demoHint.hidden = false;
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  loginButton.disabled = true;
  setLoginMessage('Signing in…', '');

  try {
    await Auth.login(employeeInput.value, passwordInput.value);
    location.replace('dashboard.html');
  } catch (err) {
    console.error(err);
    setLoginMessage(err.message || 'Could not log in. Try again.', 'error');
    loginButton.disabled = false;
  }
});

// Register the service worker on the first page people see, so the app
// is ready for offline use even before the first login.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => {
      console.error('Service worker registration failed:', err);
    });
  });
}
