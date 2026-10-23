'use strict';

// Initialize Supabase Client with your project URL and Token
const SUPABASE_URL = 'https://feiqyrcmxhdniwwuqjum.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9... eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx5YmtjdmF5ZmdjY3l3bGJyZ3FvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI2OTA3NDIsImV4cCI6MjEwODI2Njc0Mn0.a6g39tO7zZV1Ph7UojPxGLH60vNrlE96Y2oUbLi7h48';
const supabase = window.supabase ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

// The dashboard needs a signed-in teacher. auth.js has already started the
// redirect to the login page when nobody is signed in.
const currentUser = Auth.getSession();
if (!currentUser) throw new Error('Not signed in. Going back to the login page.');

/* ------------------------------------------------------------------
 * IndexedDB setup
 * ------------------------------------------------------------------ */
const DB_NAME = 'attendance-db';
const DB_VERSION = 1;
const STORE = 'records';
const VALID_STATUSES = ['Present', 'Late', 'Absent'];

let dbPromise = null;

/** Opens (and creates/upgrades) the database. The connection is reused. */
function openDB() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('teacherId', 'teacherId', { unique: false });
        store.createIndex('timestamp', 'timestamp', { unique: false });
        store.createIndex('status', 'status', { unique: false });
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      // If another tab upgrades the DB, close so we don't block it.
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };

    request.onerror = () => { dbPromise = null; reject(request.error); };
    request.onblocked = () => { dbPromise = null; reject(new Error('Database upgrade is blocked by another tab.')); };
  });

  return dbPromise;
}

/**
 * Saves one attendance record locally.
 * @param {string} teacherId
 * @param {'Present'|'Late'|'Absent'} status
 * @returns {Promise<object>} the saved record, including its generated id
 */
async function saveAttendanceRecord(teacherId, status) {
  const cleanId = String(teacherId || '').trim();
  if (!cleanId) throw new Error('Teacher ID is required.');
  if (!VALID_STATUSES.includes(status)) throw new Error('Status must be Present, Late or Absent.');

  const record = {
    teacherId: cleanId,
    timestamp: new Date().toISOString(),
    status,
    synced: false // handy flag for a future sync-to-server step
  };

  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const request = tx.objectStore(STORE).add(record);

    request.onsuccess = () => { record.id = request.result; };
    // Resolve only when the transaction has fully committed to disk.
    tx.oncomplete = () => resolve(record);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted.'));
  });
}

/** Returns all saved records, newest first. */
async function getAllRecords() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const results = [];
    const tx = db.transaction(STORE, 'readonly');
    const cursorRequest = tx.objectStore(STORE).index('timestamp').openCursor(null, 'prev');

    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (cursor) {
        results.push(cursor.value);
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve(results);
    tx.onerror = () => reject(tx.error);
  });
}

/** Records not yet sent to the admin server, oldest first. */
async function getPendingRecords() {
  const all = await getAllRecords(); // newest first
  return all.filter((rec) => !rec.synced).reverse();
}

/** Deletes records by id in a single transaction. */
async function deleteRecords(ids) {
  if (!ids.length) return;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    ids.forEach((id) => store.delete(id));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction aborted.'));
  });
}

/* ------------------------------------------------------------------
 * Geofence (location + time check)
 * ------------------------------------------------------------------ */

const SCHOOL = { latitude: 28.7519732, longitude: 77.4988376};
const GEOFENCE_RADIUS_M = 500;
const EARTH_RADIUS_M = 6371000;

const WINDOW_START_SECONDS = 0;
const WINDOW_END_SECONDS = 24*3600-1;

function haversineDistance(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function isWithinTimeWindow(date = new Date()) {
  const seconds = date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds();
  return seconds >= WINDOW_START_SECONDS && seconds <= WINDOW_END_SECONDS;
}

function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new Error('This device or browser does not support location.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 15000,
      maximumAge: 0
    });
  });
}

function describeGeoError(err) {
  switch (err && err.code) {
    case 1: return 'Location permission was denied. Allow location access for this site in your browser settings, then try again.';
    case 2: return 'Your location is unavailable right now. Move to an open area or check that location services are on, then try again.';
    case 3: return 'Finding your location took too long. Try again.';
    default: return (err && err.message) || 'Could not get your location.';
  }
}

async function evaluateGeofence(targetLat = SCHOOL.latitude, targetLon = SCHOOL.longitude) {
  const position = await getCurrentPosition();
  const checkedAt = new Date();
  const { latitude, longitude, accuracy } = position.coords;

  const distance = haversineDistance(latitude, longitude, targetLat, targetLon);
  const withinRadius = distance <= GEOFENCE_RADIUS_M;
  const withinTime = isWithinTimeWindow(checkedAt);

  return {
    allowed: withinRadius && withinTime,
    withinRadius,
    withinTime,
    distance,
    accuracy,
    checkedAt
  };
}

async function geofence(targetLat = SCHOOL.latitude, targetLon = SCHOOL.longitude) {
  const result = await evaluateGeofence(targetLat, targetLon);
  return result.allowed;
}

/* ------------------------------------------------------------------
 * Dashboard: status tiles and actions
 * ------------------------------------------------------------------ */
const $ = (id) => document.getElementById(id);

const WINDOW_LABEL = 'the allowed hours (all day)';
const VERIFICATION_VALID_MS = 10 * 60 * 1000;
const HISTORY_LIMIT = 100;

const lastMarkedKey = `attendance.lastMarked.${currentUser.employeeId}`;
const historyKey = `attendance.history.${currentUser.employeeId}`;

const tiles = {
  location:   { root: $('tile-location'),   value: $('location-value'),   detail:$('location-detail') },
  internet:   { root: $('tile-internet'),   value: $('internet-value'),   detail:$('internet-detail') },
  attendance: { root: $('tile-attendance'), value: $('attendance-value'), detail:$('attendance-detail') },
  face:       { root: $('tile-face'),       value: $('face-value'),       detail:$('face-detail') }
};
const actionMessage = $('action-message');
const verifyBtn = $('verify-btn');
const markBtn = $('mark-btn');
const historyBtn = $('history-btn');
const historyPanel = $('history');
const historyList = $('history-list');
const historyEmpty = $('history-empty');
const profileDialog = $('profile-dialog');
const faceIdDetail = $('faceid-detail');
const enrollBtn = $('enroll-btn');
const adminDialog = $('admin-dialog');
const adminForm = $('admin-form');
const adminPasscode = $('admin-passcode');
const adminMessage = $('admin-message');

let verifiedAt = null;
let pendingCount = 0;

function setTile(name, state, value, detail) {
  const tile = tiles[name];
  tile.root.dataset.state = state;
  tile.value.textContent = value;
  if (detail !== undefined) tile.detail.textContent = detail;
}

function showMessage(text, type) {
  actionMessage.textContent = text;
  actionMessage.className = 'message ' + (type || '');
}

function formatClock(date) {
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function formatTime(iso) {
  return new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

function formatDistance(meters) {
  return meters >= 1000 ? (meters / 1000).toFixed(1) + ' km' : Math.round(meters) + ' m';
}

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (err) {
    return fallback;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    console.warn('Could not save to local storage.', err);
  }
}

function dateKey(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function getMarkedToday() {
  const marked = readJSON(lastMarkedKey, null);
  return marked && marked.date === dateKey() ? marked : null;
}

function refreshAttendanceTile() {
  const marked = getMarkedToday();
  if (marked) {
    setTile('attendance', 'ok', `Marked at ${formatClock(new Date(marked.timestamp))}`, `Status: ${marked.status}`);
  } else {
    setTile('attendance', 'idle', 'Not marked', '');
  }
}

function refreshInternetTile() {
  const online = navigator.onLine;
  const waiting = pendingCount === 0 ? 'Nothing waiting to sync' : `${countRecords(pendingCount)} waiting to sync`;
  setTile('internet', online ? 'ok' : 'warn', online ? 'Connected' : 'Offline', waiting);
}

async function renderRecords() {
  pendingCount = (await getPendingRecords()).length;
  refreshInternetTile();
  if (!historyPanel.hidden) await renderHistory();
}

async function refreshFaceIdStatus() {
  const template = await FaceID.getTemplate(currentUser.employeeId).catch(() => null);
  faceIdDetail.textContent = template ? 'Face ID: set up' : 'Face ID: not set up';
  $('profile-faceid').textContent = template ? 'Set up' : 'Not set up';
  enrollBtn.textContent = template ? 'Replace Face ID (administrator)' : 'Set up Face ID (administrator)';
}

async function openFaceCheck() {
  const wait = lockoutMinutes();
  if (wait > 0) {
    setTile('face', 'bad', 'Locked');
    showMessage(`Too many failed face checks. Try again in ${wait} minute${wait === 1 ? '' : 's'}, or ask your administrator.`, 'error');
    return;
  }
  const template = await FaceID.getTemplate(currentUser.employeeId).catch(() => null);
  if (!template) {
    setTile('face', 'warn', 'Face ID not set up');
    showMessage('Face ID is not set up for this account. Ask your administrator to set it up: tap Profile, then Set up Face ID.', 'error');
    return;
  }
  startFaceSession('verify');
}

async function verifyLocation({ startFace }) {
  cancelFaceVerification();
  verifiedAt = null;
  setTile('face', 'idle', 'Not started');
  if (startFace) showMessage('', '');
  verifyBtn.disabled = true;
  setTile('location', 'busy', 'Checking location…', '');

  try {
    const r = await evaluateGeofence();
    const distance = `${formatDistance(r.distance)} from school (±${Math.round(r.accuracy)} m accuracy)`;

    if (r.allowed) {
      setTile('location', 'ok', 'At school', distance);
      if (startFace) await openFaceCheck();
    } else if (!r.withinRadius) {
      setTile('location', 'bad', 'Outside school area', distance);
      if (startFace) showMessage(`Move within ${GEOFENCE_RADIUS_M} m of the school, then tap Verify my location again.`, 'error');
    } else {
      setTile('location', 'bad', 'Outside check-in hours', `${distance}. Check-in is open ${WINDOW_LABEL}.`);
      if (startFace) showMessage('Attendance can only be verified during check-in hours.', 'error');
    }
  } catch (err) {
    console.error(err);
    setTile('location', 'warn', 'Location unavailable', describeGeoError(err));
  } finally {
    verifyBtn.disabled = false;
  }
}

async function markAttendance() {
  if (getMarkedToday()) {
    showMessage('Your attendance is already marked for today.', 'ok');
    return;
  }
  if (!verifiedAt) {
    showMessage('Tap Verify my location and complete the face check before marking attendance.', 'error');
    return;
  }
  if (Date.now() - verifiedAt > VERIFICATION_VALID_MS) {
    verifiedAt = null;
    setTile('face', 'idle', 'Not started');
    showMessage('Your verification has expired. Tap Verify my location to start again.', 'error');
    return;
  }

  markBtn.disabled = true;
  try {
    const saved = await saveAttendanceRecord(currentUser.employeeId, 'Present');
    verifiedAt = null;

    writeJSON(lastMarkedKey, { date: dateKey(new Date(saved.timestamp)), timestamp: saved.timestamp, status: saved.status });
    const log = readJSON(historyKey, []);
    log.unshift({ id: saved.id, timestamp: saved.timestamp, status: saved.status });
    writeJSON(historyKey, log.slice(0, HISTORY_LIMIT));

    refreshAttendanceTile();
    showMessage(
      navigator.onLine
        ? 'Attendance marked. Sending to Supabase…'
        : 'Attendance marked. It will be sent when you are back online.',
      'ok'
    );
    await renderRecords();
    if (navigator.onLine) syncPendingRecords();
  } catch (err) {
    console.error(err);
    showMessage('Could not save attendance. ' + err.message, 'error');
  } finally {
    markBtn.disabled = false;
  }
}

async function renderHistory() {
  const waitingIds = new Set((await getPendingRecords()).map((rec) => rec.id));
  const entries = readJSON(historyKey, []);
  historyList.textContent = '';

  for (const entry of entries) {
    const li = document.createElement('li');
    li.className = String(entry.status).toLowerCase();

    const status = document.createElement('span');
    status.className = 'rec-status';
    status.textContent = entry.status;

    const badge = document.createElement('span');
    const waiting = waitingIds.has(entry.id);
    badge.className = 'rec-badge';
    badge.dataset.sent = String(!waiting);
    badge.textContent = waiting ? 'Waiting to sync' : 'Sent';

    const time = document.createElement('span');
    time.className = 'rec-time';
    time.textContent = formatTime(entry.timestamp);

    li.append(status, badge, time);
    historyList.appendChild(li);
  }
  historyEmpty.hidden = entries.length > 0;
}

async function toggleHistory() {
  if (!historyPanel.hidden) {
    historyPanel.hidden = true;
    return;
  }
  historyPanel.hidden = false;
  await renderHistory();
  historyPanel.scrollIntoView({ block: 'nearest' });
}

function openProfile() {
  refreshFaceIdStatus();
  $('profile-name').textContent = currentUser.name;
  $('profile-id').textContent = currentUser.employeeId;
  $('profile-institution').textContent = currentUser.institution \vert{}\vert{} 'Not set';$('profile-signed-in').textContent = formatTime(currentUser.loggedInAt);

  if (typeof profileDialog.showModal === 'function') {
    profileDialog.showModal();
  } else {
    alert(`${currentUser.name}\nEmployee ID: ${currentUser.employeeId}\n${currentUser.institution || ''}`);
  }
}

async function logout() {
  const waiting = (await getPendingRecords().catch(() => [])).length;
  if (waiting > 0) {
    const ok = confirm(
      `${countRecords(waiting)} ${waiting === 1 ? 'has' : 'have'} not been sent to the server yet. ` +
      'They stay on this device and are sent the next time someone logs in here while online. Log out anyway?'
    );
    if (!ok) return;
  }
  cancelFaceVerification();
  Auth.logout();
  location.replace('index.html');
}

verifyBtn.addEventListener('click', () => verifyLocation({ startFace: true }));
markBtn.addEventListener('click', markAttendance);
historyBtn.addEventListener('click', toggleHistory);
$('history-close').addEventListener('click', () => { historyPanel.hidden = true; });
$('profile-btn').addEventListener('click', openProfile);$('logout-btn').addEventListener('click', logout);
window.addEventListener('online', refreshInternetTile);
window.addEventListener('offline', refreshInternetTile);

enrollBtn.addEventListener('click', () => {
  profileDialog.close();
  adminPasscode.value = '';
  adminMessage.textContent = '';
  if (typeof adminDialog.showModal === 'function') adminDialog.showModal();
  else alert('This browser cannot show the passcode box. Update your browser and try again.');
});
$('admin-cancel').addEventListener('click', () => adminDialog.close());
adminForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  let ok = false;
  try {
    ok = await FaceID.checkAdminPasscode(adminPasscode.value);
  } catch (err) {
    adminMessage.textContent = 'This browser cannot check the passcode. Open the app over HTTPS.';
    adminMessage.className = 'message error';
    return;
  }
  adminPasscode.value = '';
  if (!ok) {
    adminMessage.textContent = 'Incorrect passcode.';
    adminMessage.className = 'message error';
    return;
  }
  adminDialog.close();
  startFaceSession('enroll');
});

// MediaPipe & Face setup variables...
const MEDIAPIPE_VERSION = '0.10.35';
const MP_BUNDLE_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/vision_bundle.mjs`;
const MP_WASM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;
const FACE_MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

const BLINK_CLOSED = 0.5;
const BLINK_OPEN = 0.3;
const MOUTH_OPEN = 0.45;
const MOUTH_CLOSED = 0.15;
const TURN_THRESHOLD = 0.12;
const CENTER_LIMIT = 0.07;
const CHALLENGE_COUNT = 4;
const MAX_STRAY_MOVES = 1;
const MAX_FAILED_CHECKS = 3;
const LOCKOUT_MS = 10 * 60 * 1000;
const NEUTRAL_HOLD_MS = 400;
const CHALLENGE_TIMEOUT_MS = 8000;
const SESSION_TIMEOUT_MS = 60000;
const SAMPLE_INTERVAL_MS = 450;
const FINAL_WAIT_MS = 8000;
const FACE_DEBUG = /[?&]debug\b/.test(location.search);

const CHALLENGES = {
  blink: { text: 'Blink twice', label: 'Blink twice' },
  left:  { text: 'Turn your head to
