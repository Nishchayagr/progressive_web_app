'use strict';

/*
 * Sign-in for the Smart Attendance Portal. Used by both pages.
 *
 * DEMO MODE: SIMULATE_AUTH is true, so no server is contacted and the demo
 * account below is checked in the browser. Anything in browser code can be read
 * by anyone, so this is NOT secure. Before real use, set SIMULATE_AUTH to false
 * and point LOGIN_ENDPOINT at your server, which must check the Employee ID and
 * password itself.
 */
const Auth = (() => {
  const SESSION_KEY = 'attendance.session';

  // Real server contract:
  //   POST { employeeId, password }
  //   200 -> { token, profile: { employeeId, name, institution } }
  //   401 -> wrong Employee ID or password
  const LOGIN_ENDPOINT = 'https://admin.example.com/api/login'; // TODO: your server
  const SIMULATE_AUTH = true;
  const SIMULATED_LATENCY_MS = 800;

  const DEMO_ACCOUNTS = {
    'TCH-1024': { password: 'demo1234', name: 'Teacher', institution: 'Government Inter College' },
    'P2008': { password: 'P2008', name: 'Palak', institution: 'KIET Group of Institutions' },
    'N2005': { password: 'N2005', name: 'Nishchay', institution: 'KIET Group of Institutions' },
  };

  class AuthError extends Error {}

  function getSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      return null;
    }
  }

  function saveSession(session) {
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    } catch (err) {
      throw new AuthError('This browser is blocking local storage, so you cannot stay logged in. Turn off private browsing and try again.');
    }
  }

  async function simulatedLogin(employeeId, password) {
    await new Promise((resolve) => setTimeout(resolve, SIMULATED_LATENCY_MS));
    const account = DEMO_ACCOUNTS[employeeId];
    if (!account || account.password !== password) {
      throw new AuthError('Employee ID or password is incorrect.');
    }
    return {
      profile: { employeeId, name: account.name, institution: account.institution },
      token: null
    };
  }

  async function serverLogin(employeeId, password) {
    const response = await fetch(LOGIN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeId, password })
    });
    if (response.status === 401 || response.status === 403) {
      throw new AuthError('Employee ID or password is incorrect.');
    }
    if (!response.ok) throw new AuthError('The server could not log you in. Try again later.');

    const data = await response.json();
    if (!data || !data.profile) throw new AuthError('The server sent an unexpected reply.');
    return { profile: data.profile, token: data.token || null };
  }

  /**
   * Checks the credentials and starts a session that is kept on this device
   * (so the app keeps working offline) until logout. The password is never stored.
   */
  async function login(employeeId, password) {
    const id = String(employeeId || '').trim().toUpperCase();
    if (!id || !password) throw new AuthError('Enter your Employee ID and password.');
    if (!navigator.onLine) {
      throw new AuthError('You are offline. Connect to the internet to log in. After that, the app works offline.');
    }

    let result;
    try {
      result = SIMULATE_AUTH ? await simulatedLogin(id, password) : await serverLogin(id, password);
    } catch (err) {
      if (err instanceof AuthError) throw err;
      throw new AuthError('Could not reach the server. Check your connection and try again.');
    }

    const session = {
      employeeId: result.profile.employeeId || id,
      name: result.profile.name || 'Teacher',
      institution: result.profile.institution || '',
      token: result.token,
      loggedInAt: new Date().toISOString()
    };
    saveSession(session);
    return session;
  }

  function logout() {
    try { localStorage.removeItem(SESSION_KEY); } catch (err) { /* nothing to clear */ }
  }

  /** For the dashboard: returns the session, or sends the visitor to the login page. */
  function requireSession() {
    const session = getSession();
    if (!session) location.replace('index.html');
    return session;
  }

  /** For the login page: skips straight to the dashboard if already signed in. */
  function redirectIfSignedIn() {
    if (getSession()) location.replace('dashboard.html');
  }

  const firstDemoId = Object.keys(DEMO_ACCOUNTS)[0];
  const demoHint = SIMULATE_AUTH
    ? `Demo login: ${firstDemoId} / ${DEMO_ACCOUNTS[firstDemoId].password}`
    : '';

  return { getSession, login, logout, requireSession, redirectIfSignedIn, demoHint };
})();
