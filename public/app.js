'use strict';

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

// TODO: replace with your school's real coordinates (decimal degrees).
const SCHOOL = { latitude: 28.7519732, longitude: 77.4988376};

const GEOFENCE_RADIUS_M = 500;
const EARTH_RADIUS_M = 6371000;

// Check-in window in device-local time, inclusive: 7:30:00 AM to 8:15:00 AM.
const WINDOW_START_SECONDS = 0;
const WINDOW_END_SECONDS = 24*3600-1;

/** Great-circle distance in meters between two lat/lon points (Haversine). */
function haversineDistance(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** True if the device's local time is between 7:30 AM and 8:15 AM (inclusive). */
function isWithinTimeWindow(date = new Date()) {
  const seconds = date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds();
  return seconds >= WINDOW_START_SECONDS && seconds <= WINDOW_END_SECONDS;
}

/** Promise wrapper around navigator.geolocation.getCurrentPosition. */
function getCurrentPosition() {
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new Error('This device or browser does not support location.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 15000,
      maximumAge: 0 // always ask for a fresh fix
    });
  });
}

/** Turns a GeolocationPositionError (or any error) into a message a person can act on. */
function describeGeoError(err) {
  switch (err && err.code) {
    case 1: return 'Location permission was denied. Allow location access for this site in your browser settings, then try again.';
    case 2: return 'Your location is unavailable right now. Move to an open area or check that location services are on, then try again.';
    case 3: return 'Finding your location took too long. Try again.';
    default: return (err && err.message) || 'Could not get your location.';
  }
}

/**
 * Full geofence evaluation. Resolves with the details the UI needs,
 * or rejects if the location cannot be read.
 */
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
    distance,   // meters
    accuracy,   // meters, as reported by the device
    checkedAt
  };
}

/**
 * Geofence: resolves true only if the device is within 100 m of the target
 * AND the device time is between 7:30 AM and 8:15 AM. Otherwise false.
 * Rejects if the location cannot be read.
 */
async function geofence(targetLat = SCHOOL.latitude, targetLon = SCHOOL.longitude) {
  const result = await evaluateGeofence(targetLat, targetLon);
  return result.allowed;
}

/* ------------------------------------------------------------------
 * Dashboard: status tiles and actions
 * ------------------------------------------------------------------ */
const $ = (id) => document.getElementById(id);

const WINDOW_LABEL = 'the allowed hours (all day)';

// A passed face check is good for this long. After that, verify again.
const VERIFICATION_VALID_MS = 10 * 60 * 1000;
const HISTORY_LIMIT = 100;

const lastMarkedKey = `attendance.lastMarked.${currentUser.employeeId}`;
const historyKey = `attendance.history.${currentUser.employeeId}`;

const tiles = {
  location:   { root: $('tile-location'),   value: $('location-value'),   detail: $('location-detail') },
  internet:   { root: $('tile-internet'),   value: $('internet-value'),   detail: $('internet-detail') },
  attendance: { root: $('tile-attendance'), value: $('attendance-value'), detail: $('attendance-detail') },
  face:       { root: $('tile-face'),       value: $('face-value'),       detail: $('face-detail') }
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

let verifiedAt = null; // when the face check last passed (ms since 1970), or null
let pendingCount = 0;  // records saved on this device and not yet sent

/** Updates one status tile. state: idle | busy | ok | warn | bad. Leave detail undefined to keep it. */
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

/* Small per-teacher notes kept on this device */
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

/* Tiles */
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

/** Refreshes the waiting-to-sync count, and the history list if it is open. Also called by the sync code. */
async function renderRecords() {
  pendingCount = (await getPendingRecords()).length;
  refreshInternetTile();
  if (!historyPanel.hidden) await renderHistory();
}

/** Shows whether this teacher has a Face ID saved on this device. */
async function refreshFaceIdStatus() {
  const template = await FaceID.getTemplate(currentUser.employeeId).catch(() => null);
  faceIdDetail.textContent = template ? 'Face ID: set up' : 'Face ID: not set up';
  $('profile-faceid').textContent = template ? 'Set up' : 'Not set up';
  enrollBtn.textContent = template ? 'Replace Face ID (administrator)' : 'Set up Face ID (administrator)';
}

/** Location passed: open the camera for the face check, if this account has a Face ID. */
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

/* Verify my location (and, when asked, open the face check) */
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
      if (startFace) await openFaceCheck(); // location passed: open the camera
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

/* Mark attendance: needs a recent passed face check, and only once per day */
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
    verifiedAt = null; // one verification, one attendance mark

    writeJSON(lastMarkedKey, { date: dateKey(new Date(saved.timestamp)), timestamp: saved.timestamp, status: saved.status });
    const log = readJSON(historyKey, []);
    log.unshift({ id: saved.id, timestamp: saved.timestamp, status: saved.status });
    writeJSON(historyKey, log.slice(0, HISTORY_LIMIT));

    refreshAttendanceTile();
    showMessage(
      navigator.onLine
        ? 'Attendance marked. Sending to the admin server…'
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

/* Attendance history (this device) */
async function renderHistory() {
  const waitingIds = new Set((await getPendingRecords()).map((rec) => rec.id));
  const entries = readJSON(historyKey, []); // newest first
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

/* Profile and logout */
function openProfile() {
  refreshFaceIdStatus();
  $('profile-name').textContent = currentUser.name;
  $('profile-id').textContent = currentUser.employeeId;
  $('profile-institution').textContent = currentUser.institution || 'Not set';
  $('profile-signed-in').textContent = formatTime(currentUser.loggedInAt);

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
      `${countRecords(waiting)} ${waiting === 1 ? 'has' : 'have'} not been sent to the admin server yet. ` +
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
$('profile-btn').addEventListener('click', openProfile);
$('logout-btn').addEventListener('click', logout);
window.addEventListener('online', refreshInternetTile);
window.addEventListener('offline', refreshInternetTile);

/* Setting up a Face ID: needs the administrator's passcode first */
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

/* ------------------------------------------------------------------
 * Face check: random actions (MediaPipe) + Face ID (faceid.js)
 *
 *  1. The person must do 4 random actions, in a random order, each one after
 *     looking straight at the camera. A recorded video cannot know what will
 *     be asked, so it cannot do them in time.
 *  2. While they do that, faceid.js looks at the camera: is it a live face
 *     (not a screen or a print), and is it the Face ID saved for this employee?
 *
 * MediaPipe Face Landmarker is MediaPipe's current version of Face Mesh: the
 * same face mesh landmarks, plus blink and mouth scores. It loads from the CDN,
 * and sw.js caches the files so it keeps working offline.
 * ------------------------------------------------------------------ */

// Keep in sync with MEDIAPIPE_VERSION in sw.js.
const MEDIAPIPE_VERSION = '0.10.35';
const MP_BUNDLE_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/vision_bundle.mjs`;
const MP_WASM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;
const FACE_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

// Action tuning
const BLINK_CLOSED = 0.5;          // average eyeBlink score at or above this = eyes closed
const BLINK_OPEN = 0.3;            // at or below this = eyes open again
const MOUTH_OPEN = 0.45;           // jawOpen score at or above this = mouth wide open
const MOUTH_CLOSED = 0.15;         // at or below this = mouth closed
const TURN_THRESHOLD = 0.12;       // nose offset from face center, as a fraction of face width (about 20 degrees)
const CENTER_LIMIT = 0.07;         // below this = looking straight at the camera
const CHALLENGE_COUNT = 4;         // random actions per check (4 = all of them, in a random order)
const MAX_STRAY_MOVES = 1;         // wrong turns / mouth openings allowed before the check fails
const MAX_FAILED_CHECKS = 3;       // failed face checks allowed ...
const LOCKOUT_MS = 10 * 60 * 1000; // ... within this time, then the account waits
const NEUTRAL_HOLD_MS = 400;       // must look straight for this long before each action
const CHALLENGE_TIMEOUT_MS = 8000; // time allowed for each action
const SESSION_TIMEOUT_MS = 60000;  // hard limit for the whole check
const SAMPLE_INTERVAL_MS = 450;    // how often Face ID looks at the camera
const FINAL_WAIT_MS = 8000;        // extra time to get clear frames after the actions
const FACE_DEBUG = /[?&]debug\b/.test(location.search); // add ?debug to the address to see the scores

const CHALLENGES = {
  blink: { text: 'Blink twice', label: 'Blink twice' },
  left:  { text: 'Turn your head to your left', label: 'Turn left' },
  right: { text: 'Turn your head to your right', label: 'Turn right' },
  mouth: { text: 'Open your mouth wide', label: 'Open mouth' }
};

const FACE_FAIL_MESSAGES = {
  'not-enough-frames': 'We could not get a clear view of your face. Move closer, face the light and try again.',
  'multiple-faces': 'More than one face was seen. Only you should be in front of the camera. Try again.',
  'spoof': 'The camera could not confirm a live face. Do not use a photo or a video. Try again in good light.',
  'no-match': 'Your face does not match the Face ID saved for this account.',
  'unexpected-movement': 'That was not the action we asked for. Follow the instructions on the screen and try again.',
  'inconsistent': 'The face changed during set up. Only one person should be in front of the camera. Try again.'
};

const verifyPanel = document.getElementById('verify');
const verifyHeading = document.getElementById('verify-heading');
const cameraFrame = document.getElementById('camera-frame');
const cameraEl = document.getElementById('camera');
const livenessEl = document.getElementById('liveness');
const verifyMessage = document.getElementById('verify-message');
const verifyHeadline = document.getElementById('verify-headline');
const verifyDebug = document.getElementById('verify-debug');
const verifyClose = document.getElementById('verify-close');

let landmarkerPromise = null;
let cameraStream = null;
let session = null; // the face check currently running, if any

/** Loads MediaPipe from the CDN once, and reuses it. */
function getFaceLandmarker() {
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      const { FaceLandmarker, FilesetResolver } = await import(MP_BUNDLE_URL);
      const fileset = await FilesetResolver.forVisionTasks(MP_WASM_BASE);
      const create = (delegate) => FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: FACE_MODEL_URL, delegate },
        runningMode: 'VIDEO',
        numFaces: 1,
        outputFaceBlendshapes: true
      });
      try {
        return await create('GPU');
      } catch (err) {
        console.warn('GPU delegate unavailable, using CPU.', err);
        return await create('CPU');
      }
    })().catch((err) => {
      landmarkerPromise = null; // allow a retry
      throw err;
    });
  }
  return landmarkerPromise;
}

/* ---------- Reading the face ---------- */
function getBlendshape(result, name) {
  const shapes = result.faceBlendshapes && result.faceBlendshapes[0];
  const item = shapes && shapes.categories.find((c) => c.categoryName === name);
  return item ? item.score : null;
}

/** Average of the two eye-blink scores (0 = open, 1 = closed), or null if unavailable. */
function getBlinkScore(result) {
  const left = getBlendshape(result, 'eyeBlinkLeft');
  const right = getBlendshape(result, 'eyeBlinkRight');
  return left !== null && right !== null ? (left + right) / 2 : null;
}

/**
 * How far the nose sits from the middle of the face, as a fraction of face width.
 * Positive = turned to the user's own left, negative = turned to their right
 * (in the raw, unmirrored camera image).
 */
function getYawRatio(landmarks) {
  const nose = landmarks[1];
  const a = landmarks[234];
  const b = landmarks[454];
  const width = Math.abs(b.x - a.x);
  if (width < 0.05) return 0; // face too small to measure
  return (nose.x - (a.x + b.x) / 2) / width;
}

/** Blink, mouth and head-turn readings for one frame, or null if no face. */
function readPose(result) {
  const face = result.faceLandmarks && result.faceLandmarks[0];
  if (!face) return null;
  return { blink: getBlinkScore(result), mouth: getBlendshape(result, 'jawOpen'), yaw: getYawRatio(face) };
}

/** Looking straight at the camera, eyes open, mouth closed. */
function isNeutral(pose) {
  return pose.blink !== null && pose.mouth !== null &&
    Math.abs(pose.yaw) < CENTER_LIMIT && pose.blink <= BLINK_OPEN && pose.mouth <= MOUTH_CLOSED;
}

function newActionState() {
  return { eyesClosed: false, blinks: 0 };
}

/** True once the requested action has been done. */
function checkAction(id, pose, state) {
  switch (id) {
    case 'blink':
      if (pose.blink >= BLINK_CLOSED) {
        state.eyesClosed = true;
      } else if (pose.blink <= BLINK_OPEN && state.eyesClosed) {
        state.eyesClosed = false;
        state.blinks++;
      }
      return state.blinks >= 2;
    case 'left':  return pose.yaw >= TURN_THRESHOLD;
    case 'right': return pose.yaw <= -TURN_THRESHOLD;
    case 'mouth': return pose.mouth !== null && pose.mouth >= MOUTH_OPEN;
    default:      return false;
  }
}

function randomInt(max) {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  return buffer[0] % max;
}

/** A random selection of actions, in a random order. */
function pickChallenges(count = CHALLENGE_COUNT) {
  const ids = Object.keys(CHALLENGES);
  for (let i = ids.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return ids.slice(0, count);
}

/** A different action from the one asked for. (Blinking is natural, so it never counts.) */
function isStrayMove(id, pose) {
  if (pose.yaw >= TURN_THRESHOLD && id !== 'left') return true;
  if (pose.yaw <= -TURN_THRESHOLD && id !== 'right') return true;
  return pose.mouth !== null && pose.mouth >= MOUTH_OPEN && id !== 'mouth';
}

/* ---------- Too many failed checks: wait a while ---------- */
const failedChecksKey = `attendance.faceFails.${currentUser.employeeId}`;

function recentFailedChecks() {
  return readJSON(failedChecksKey, []).filter((t) => Date.now() - t < LOCKOUT_MS);
}

/** Minutes left to wait, or 0 if the teacher may try. */
function lockoutMinutes() {
  const recent = recentFailedChecks();
  if (recent.length < MAX_FAILED_CHECKS) return 0;
  const unlocksAt = recent[recent.length - MAX_FAILED_CHECKS] + LOCKOUT_MS;
  return Math.max(1, Math.ceil((unlocksAt - Date.now()) / 60000));
}

function recordFailedCheck() {
  writeJSON(failedChecksKey, [...recentFailedChecks(), Date.now()]);
}

function clearFailedChecks() {
  try { localStorage.removeItem(failedChecksKey); } catch (err) { /* nothing to clear */ }
}

/* ---------- Panel ---------- */
function setVerifyMessage(state, text) {
  verifyMessage.dataset.state = state;
  if (verifyHeadline.textContent !== text) verifyHeadline.textContent = text;
}

function markStep(step, done) {
  const item = livenessEl.querySelector(`[data-step="${step}"]`);
  if (item) item.dataset.done = String(done);
}

function renderChips(challenges, enrolling) {
  livenessEl.textContent = '';
  const items = [
    ['face', 'Face found'],
    ...challenges.map((id) => [id, CHALLENGES[id].label]),
    ['faceid', enrolling ? 'Face ID saved' : 'Face ID match']
  ];
  for (const [step, label] of items) {
    const li = document.createElement('li');
    li.dataset.step = step;
    li.dataset.done = 'false';
    li.textContent = label;
    livenessEl.appendChild(li);
  }
}

function showFaceDebug(result) {
  verifyDebug.hidden = !FACE_DEBUG;
  if (!FACE_DEBUG) return;
  const n = (v) => (typeof v === 'number' ? v.toFixed(2) : '-');
  verifyDebug.textContent =
    `match ${n(result.similarity)} | real ${n(result.real)} | live ${n(result.live)} | clear frames ${result.goodFrames}/${result.frames}`;
}

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function describeFaceError(err) {
  switch (err && err.name) {
    case 'NotAllowedError':
      return 'Camera permission was denied. Allow camera access for this site, then try again.';
    case 'NotFoundError':
      return 'No camera was found on this device.';
    case 'NotReadableError':
      return 'The camera is in use by another app. Close it, then try again.';
    case 'NotEnrolled':
      return 'Face ID is not set up for this account. Ask your administrator to set it up.';
    default:
      return navigator.onLine
        ? 'Face detection could not start. Check your connection and try again.'
        : 'The face check files are not on this device yet. Connect to the internet once, reload the app, and try again.';
  }
}

async function openCamera(mine) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('This browser cannot access the camera.');
  }
  const media = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
    audio: false
  });
  if (!mine.active) { // cancelled while the permission prompt was open
    media.getTracks().forEach((track) => track.stop());
    return;
  }
  cameraStream = media;
  cameraEl.srcObject = media;
  cameraFrame.hidden = false;
  await cameraEl.play();
}

function stopCamera() {
  if (cameraStream) {
    cameraStream.getTracks().forEach((track) => track.stop());
    cameraStream = null;
  }
  cameraEl.srcObject = null;
  cameraFrame.hidden = true;
}

/* ---------- The check itself ---------- */

/** Face ID looks at the camera now and then, for as long as the check runs. */
async function sampleLoop(mine) {
  let failures = 0;
  while (mine.active && !mine.done) {
    const started = Date.now();
    try {
      const sampleResult = await FaceID.sample(cameraEl);
      if (sampleResult && mine.active && !mine.done) mine.samples.push(sampleResult);
    } catch (err) {
      console.warn('Face ID could not read a frame.', err);
      if (++failures > 5) { mine.sampleFailed = err; return; }
    }
    await sleep(Math.max(50, SAMPLE_INTERVAL_MS - (Date.now() - started)));
  }
}

/** After the actions: keep looking until there are enough clear frames. */
async function waitForClearFrames(mine) {
  const until = Date.now() + FINAL_WAIT_MS;
  while (mine.active && !mine.sampleFailed && Date.now() < until && FaceID.countGood(mine.samples) < FaceID.MIN_GOOD_SAMPLES) {
    setVerifyMessage('loading', 'Hold still and look at the camera…');
    await sleep(150);
  }
}

/**
 * Asks for the random actions one by one. Each one starts only after the person
 * has looked straight at the camera, so it has to be a fresh movement.
 * Resolves 'passed', 'timeout', 'unexpected-movement' or 'cancelled'.
 */
async function runChallenges(landmarker, mine, challenges) {
  const sessionDeadline = performance.now() + SESSION_TIMEOUT_MS;
  let step = 0;
  let neutralSince = null;
  let actionDeadline = null; // set once the action has been asked for
  let action = newActionState();
  let strays = 0;
  let strayActive = false;
  let lastVideoTime = -1;

  while (mine.active && step < challenges.length) {
    const now = performance.now();
    if (now > sessionDeadline) return 'timeout';
    if (actionDeadline !== null && now > actionDeadline) return 'timeout';

    await nextFrame();
    if (!mine.active) break;

    // Only analyze new video frames.
    if (cameraEl.readyState < 2 || cameraEl.currentTime === lastVideoTime) continue;
    lastVideoTime = cameraEl.currentTime;

    const pose = readPose(landmarker.detectForVideo(cameraEl, performance.now()));
    if (!pose) {
      neutralSince = null;
      setVerifyMessage('loading', 'Look at the camera so your face is in the frame.');
      continue;
    }
    markStep('face', true);
    const id = challenges[step];

    if (actionDeadline === null) {
      // Look straight at the camera first.
      if (isNeutral(pose)) {
        if (neutralSince === null) neutralSince = now;
        if (now - neutralSince >= NEUTRAL_HOLD_MS) {
          actionDeadline = now + CHALLENGE_TIMEOUT_MS;
          action = newActionState();
          setVerifyMessage('loading', `${CHALLENGES[id].text}.`);
        } else {
          setVerifyMessage('loading', 'Look straight at the camera.');
        }
      } else {
        neutralSince = null;
        setVerifyMessage('loading', 'Look straight at the camera, with your mouth closed.');
      }
      continue;
    }

    if (checkAction(id, pose, action)) {
      markStep(id, true);
      step++;
      actionDeadline = null;
      neutralSince = null;
      strayActive = false;
    } else {
      // Doing a different action than the one asked for? Once is a mistake; more is suspicious.
      const stray = isStrayMove(id, pose);
      if (stray && !strayActive) {
        strays++;
        if (strays > MAX_STRAY_MOVES) return 'unexpected-movement';
        setVerifyMessage('loading', `Not that one. ${CHALLENGES[id].text}.`);
      }
      strayActive = stray;
    }
  }
  return mine.active ? 'passed' : 'cancelled';
}

/**
 * Opens the front camera and runs the face check.
 * mode 'verify': prove it is the signed-in teacher. mode 'enroll': save a new Face ID.
 */
async function startFaceSession(mode) {
  cancelFaceVerification();
  const mine = { active: true, done: false, mode, samples: [], sampleFailed: null };
  session = mine;
  const enrolling = mode === 'enroll';
  const challenges = pickChallenges();

  verifyHeading.textContent = enrolling ? 'Set up Face ID' : 'Face check';
  verifyDebug.hidden = true;
  renderChips(challenges, enrolling);
  verifyPanel.hidden = false;
  setVerifyMessage('loading', 'Starting the camera…');
  setTile('face', 'busy', enrolling ? 'Setting up…' : 'Verifying…');

  try {
    const template = enrolling ? null : await FaceID.getTemplate(currentUser.employeeId);
    if (!enrolling && !template) {
      const notEnrolled = new Error('Face ID is not set up for this account.');
      notEnrolled.name = 'NotEnrolled';
      throw notEnrolled;
    }

    await openCamera(mine);
    if (!mine.active) return;

    setVerifyMessage('loading', 'Loading face detection…');
    const [landmarker] = await Promise.all([getFaceLandmarker(), FaceID.loadHuman()]);
    if (!mine.active) return;

    const sampler = sampleLoop(mine);
    let outcome;
    try {
      outcome = await runChallenges(landmarker, mine, challenges);
      if (outcome === 'passed') await waitForClearFrames(mine);
    } finally {
      mine.done = true;
    }
    await sampler;
    if (mine.sampleFailed) throw mine.sampleFailed;
    if (!mine.active) return;

    if (outcome === 'timeout' || outcome === 'unexpected-movement') {
      const text = outcome === 'timeout'
        ? (enrolling ? 'Face ID set up timed out. Try again.' : 'The face check timed out. Tap Verify my location to try again.')
        : FACE_FAIL_MESSAGES['unexpected-movement'];
      if (!enrolling) recordFailedCheck();
      setTile('face', 'bad', enrolling ? 'Set up failed' : 'Not verified');
      setVerifyMessage('fail', text);
      return;
    }

    setVerifyMessage('loading', enrolling ? 'Saving Face ID…' : 'Checking your face…');
    const result = enrolling
      ? await FaceID.buildTemplate(mine.samples)
      : await FaceID.verify(mine.samples, template);
    showFaceDebug(result);
    if (!mine.active) return;

    if (!result.ok) {
      const text = FACE_FAIL_MESSAGES[result.reason] || 'The face check failed. Try again.';
      // Poor lighting is not suspicious. Everything else counts toward the limit.
      if (!enrolling && result.reason !== 'not-enough-frames') recordFailedCheck();
      setTile('face', 'bad', enrolling ? 'Set up failed' : 'Not verified');
      setVerifyMessage('fail', text);
      showMessage(text, 'error');
    } else if (enrolling) {
      await FaceID.saveTemplate({
        employeeId: currentUser.employeeId,
        embeddings: result.embeddings,
        enrolledAt: new Date().toISOString()
      });
      markStep('faceid', true);
      setTile('face', 'idle', 'Not started');
      setVerifyMessage('pass', 'Face ID saved. Tap Verify my location to mark attendance.');
      showMessage(`Face ID saved for ${currentUser.employeeId}.`, 'ok');
      await refreshFaceIdStatus();
    } else {
      const time = formatClock(new Date());
      verifiedAt = Date.now();
      clearFailedChecks();
      markStep('faceid', true);
      setTile('face', 'ok', `Verified at ${time}`);
      setVerifyMessage('pass', `Face check complete. Face ID matched at ${time}.`);
      showMessage('Face check complete. You can now mark attendance.', 'ok');
    }
  } catch (err) {
    console.error(err);
    if (mine.active) {
      setTile('face', 'bad', 'Could not start');
      setVerifyMessage('error', describeFaceError(err));
    }
  } finally {
    mine.done = true;
    if (session === mine) { // not replaced or cancelled: turn the camera off
      mine.active = false;
      session = null;
      stopCamera();
    }
  }
}

/** Stops any running face check, turns the camera off and hides the panel. */
function cancelFaceVerification() {
  if (session) {
    session.active = false;
    session = null;
  }
  stopCamera();
  verifyPanel.hidden = true;
  if (!verifiedAt) setTile('face', 'idle', 'Not started');
}

verifyClose.addEventListener('click', cancelFaceVerification);
window.addEventListener('pagehide', stopCamera);

/* ------------------------------------------------------------------
 * Offline status for the face check files
 * ------------------------------------------------------------------ */
const aiStatusEl = document.getElementById('face-detail');

function onServiceWorkerMessage(event) {
  const data = event.data;
  if (!data || data.type !== 'AI_CACHE_STATUS') return;

  if (data.cached >= data.total) {
    aiStatusEl.textContent = 'Face check is ready to use offline.';
  } else if (navigator.onLine) {
    aiStatusEl.textContent =
      `Some face check files did not download (${data.cached} of ${data.total}). Reload the app to try again.`;
  } else {
    aiStatusEl.textContent =
      'Face check files are not on this device yet. Connect to the internet once so they can download.';
  }
}

/* ------------------------------------------------------------------
 * Background sync: send saved records to the admin server
 * ------------------------------------------------------------------ */

// TODO: your real admin server endpoint. A real server must allow CORS from this app's
// origin, and should require authentication (e.g. an Authorization header added below).
const ADMIN_ENDPOINT = 'https://admin.example.com/api/attendance/sync';

// true = no network request is made; a fake server answers after a short delay.
// Set to false to POST to ADMIN_ENDPOINT for real.
const SIMULATE_SERVER = true;
const SIMULATED_LATENCY_MS = 1200;
const SIMULATED_FAILURE_RATE = 0; // 0 to 1. Try 0.5 to test the retry path.

const SYNC_BATCH_SIZE = 50;

const syncStatusEl = actionMessage; // sync messages share the line under the buttons
const syncNowButton = document.getElementById('sync-now');

const countRecords = (n) => (n === 1 ? '1 record' : `${n} records`);

function setSyncStatus(text, type) {
  syncStatusEl.textContent = text;
  syncStatusEl.className = 'message ' + (type || '');
}

/** Stands in for the admin server: waits, then answers like fetch() would. */
async function simulatedFetch(url, options) {
  await new Promise((resolve) => setTimeout(resolve, SIMULATED_LATENCY_MS));

  if (!navigator.onLine || Math.random() < SIMULATED_FAILURE_RATE) {
    throw new TypeError('Failed to fetch (simulated)');
  }

  const { records } = JSON.parse(options.body);
  console.log(`[simulated server] POST ${url}`, records);
  return new Response(JSON.stringify({ received: records.length }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

function postToServer(url, options) {
  return SIMULATE_SERVER ? simulatedFetch(url, options) : fetch(url, options);
}

/**
 * Sends one batch. Resolves only if the server answered with a 2xx status.
 * If the response is lost after the server saved the data, the same records
 * are sent again next time, so the server should ignore duplicates
 * (teacherId + timestamp identifies a record).
 */
async function sendBatch(batch) {
  const response = await postToServer(ADMIN_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(currentUser.token ? { Authorization: `Bearer ${currentUser.token}` } : {})
    },
    body: JSON.stringify({
      records: batch.map(({ id, teacherId, timestamp, status }) => ({ id, teacherId, timestamp, status }))
    })
  });
  if (!response.ok) throw new Error(`The server answered ${response.status}.`);
}

async function runSync(manual) {
  if (!navigator.onLine) {
    if (manual) setSyncStatus('You are offline. Records will be sent when the connection returns.', '');
    return;
  }

  let sent = 0;
  try {
    for (;;) {
      const pending = await getPendingRecords();
      if (!pending.length) break;

      const batch = pending.slice(0, SYNC_BATCH_SIZE);
      setSyncStatus(`Sending ${countRecords(pending.length)} to the admin server…`, '');

      await sendBatch(batch);
      // Delete only what was sent. Records saved while sending stay for the next round.
      await deleteRecords(batch.map((rec) => rec.id));
      sent += batch.length;
      await renderRecords();
    }

    if (sent > 0) setSyncStatus(`Sent ${countRecords(sent)} to the admin server.`, 'ok');
    else if (manual) setSyncStatus('Nothing is waiting to sync.', '');
  } catch (err) {
    console.error('Sync failed:', err);
    const left = (await getPendingRecords().catch(() => [])).length;
    setSyncStatus(
      `Could not reach the admin server. ${countRecords(left)} will stay on this device and be sent when the connection returns, or tap Sync now.`,
      'error'
    );
  }
}

let syncPromise = null;

/** Sends all pending records. If a sync is already running, shares that one. */
function syncPendingRecords({ manual = false } = {}) {
  if (!syncPromise) {
    syncNowButton.disabled = true;
    syncPromise = runSync(manual).finally(() => {
      syncPromise = null;
      syncNowButton.disabled = false;
    });
  }
  return syncPromise;
}

// The connection came back: send everything that was saved while offline.
window.addEventListener('online', () => syncPendingRecords());

syncNowButton.addEventListener('click', () => syncPendingRecords({ manual: true }));

/* ------------------------------------------------------------------
 * Startup
 * ------------------------------------------------------------------ */
async function init() {
  $('user-name').textContent = currentUser.name;
  $('user-id').textContent = currentUser.employeeId;
  $('user-institution').textContent = currentUser.institution || 'Not set';

  refreshAttendanceTile();
  refreshInternetTile();
  refreshFaceIdStatus();

  // Ask the browser not to evict our data under storage pressure.
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(() => {});
  }

  try {
    await openDB();
    await renderRecords();
    // The 'online' event doesn't fire if the app opens already online,
    // so send anything left over from an earlier session.
    if (navigator.onLine) syncPendingRecords();
  } catch (err) {
    console.error(err);
    showMessage('Local storage is unavailable, so attendance cannot be saved.', 'error');
  }

  // Fill in the "Location status" tile as soon as the dashboard opens.
  verifyLocation({ startFace: false });
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', onServiceWorkerMessage);

  window.addEventListener('load', async () => {
    try {
      await navigator.serviceWorker.register('sw.js');
      const registration = await navigator.serviceWorker.ready;
      aiStatusEl.textContent = 'Preparing the face check for offline use…';
      // The worker downloads any missing MediaPipe files, then reports back.
      registration.active.postMessage({ type: 'PRECACHE_AI' });
    } catch (err) {
      console.error('Service worker setup failed:', err);
    }
  });
} else {
  aiStatusEl.textContent = 'Offline use is not supported in this browser.';
}

init();
