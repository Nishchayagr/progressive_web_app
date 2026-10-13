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
      if (startFace) startFaceVerification(); // location passed: open the camera
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

/* ------------------------------------------------------------------
 * Face check (MediaPipe Face Landmarker + simple liveness)
 *
 * Face Landmarker is MediaPipe's current version of Face Mesh: the same
 * face mesh landmarks, plus blink scores. It loads from the CDN, and
 * sw.js caches the files so it keeps working offline.
 * ------------------------------------------------------------------ */

// Keep in sync with MEDIAPIPE_VERSION in sw.js.
const MEDIAPIPE_VERSION = '0.10.35';
const MP_BUNDLE_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/vision_bundle.mjs`;
const MP_WASM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;
const FACE_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

// Liveness tuning
const BLINK_CLOSED = 0.5;      // average eyeBlink score at or above this = eyes closed
const BLINK_OPEN = 0.3;        // at or below this = eyes open again
const TURN_THRESHOLD = 0.12;   // nose offset from face center, as a fraction of face width (about 20 degrees)
const VERIFY_TIMEOUT_MS = 30000;

// Landmark indexes in the face mesh
const NOSE_TIP = 1;
const FACE_EDGE_A = 234;
const FACE_EDGE_B = 454;

const verifyPanel = document.getElementById('verify');
const cameraFrame = document.getElementById('camera-frame');
const cameraEl = document.getElementById('camera');
const livenessEl = document.getElementById('liveness');
const verifyMessage = document.getElementById('verify-message');
const verifyHeadline = document.getElementById('verify-headline');
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

/** Average of the two eye-blink scores (0 = open, 1 = closed), or null if unavailable. */
function getBlinkScore(result) {
  const shapes = result.faceBlendshapes && result.faceBlendshapes[0];
  if (!shapes) return null;
  const left = shapes.categories.find((c) => c.categoryName === 'eyeBlinkLeft');
  const right = shapes.categories.find((c) => c.categoryName === 'eyeBlinkRight');
  return left && right ? (left.score + right.score) / 2 : null;
}

/**
 * How far the nose sits from the middle of the face, as a fraction of face width.
 * Positive = turned to the user's own left, negative = turned to their right
 * (in the raw, unmirrored camera image).
 */
function getYawRatio(landmarks) {
  const nose = landmarks[NOSE_TIP];
  const a = landmarks[FACE_EDGE_A];
  const b = landmarks[FACE_EDGE_B];
  const width = Math.abs(b.x - a.x);
  if (width < 0.05) return 0; // face too small to measure
  return (nose.x - (a.x + b.x) / 2) / width;
}

function setVerifyMessage(state, text) {
  verifyMessage.dataset.state = state;
  if (verifyHeadline.textContent !== text) verifyHeadline.textContent = text;
}

function markStep(step, done) {
  const item = livenessEl.querySelector(`[data-step="${step}"]`);
  if (item) item.dataset.done = String(done);
}

function resetLivenessUI() {
  for (const item of livenessEl.children) item.dataset.done = 'false';
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

function describeFaceError(err) {
  switch (err && err.name) {
    case 'NotAllowedError':
      return 'Camera permission was denied. Allow camera access for this site, then tap Verify my location again.';
    case 'NotFoundError':
      return 'No camera was found on this device.';
    case 'NotReadableError':
      return 'The camera is in use by another app. Close it, then tap Verify my location again.';
    default:
      return navigator.onLine
        ? 'Face detection could not start. Check your connection and tap Verify my location again.'
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

function instructionFor(progress) {
  if (progress.left) return 'Now turn your head to the right.';
  if (progress.right) return 'Now turn your head to the left.';
  return 'Blink, or turn your head left and then right.';
}

/**
 * Watches the camera until the person blinks, or turns their head both ways.
 * Resolves 'passed', 'timeout' or 'cancelled'.
 */
async function runLiveness(landmarker, mine) {
  const progress = { eyesClosed: false, blinked: false, left: false, right: false };
  const deadline = performance.now() + VERIFY_TIMEOUT_MS;
  let lastVideoTime = -1;

  while (mine.active) {
    if (performance.now() > deadline) return 'timeout';
    await nextFrame();
    if (!mine.active) break;

    // Only analyze new video frames.
    if (cameraEl.readyState < 2 || cameraEl.currentTime === lastVideoTime) continue;
    lastVideoTime = cameraEl.currentTime;

    const result = landmarker.detectForVideo(cameraEl, performance.now());
    const face = result.faceLandmarks && result.faceLandmarks[0];
    if (!face) {
      setVerifyMessage('loading', 'Look at the camera so your face is in the frame.');
      continue;
    }
    markStep('face', true);

    // Blink: both eyes close, then open again.
    const blink = getBlinkScore(result);
    if (blink !== null) {
      if (blink >= BLINK_CLOSED) {
        progress.eyesClosed = true;
      } else if (blink <= BLINK_OPEN && progress.eyesClosed && !progress.blinked) {
        progress.blinked = true;
        markStep('blink', true);
      }
    }

    // Head turn: both directions are needed. Order doesn't matter.
    const yaw = getYawRatio(face);
    if (yaw >= TURN_THRESHOLD && !progress.left) {
      progress.left = true;
      markStep('left', true);
    } else if (yaw <= -TURN_THRESHOLD && !progress.right) {
      progress.right = true;
      markStep('right', true);
    }

    if (progress.blinked || (progress.left && progress.right)) return 'passed';
    setVerifyMessage('loading', instructionFor(progress));
  }
  return 'cancelled';
}

/** Opens the front camera and runs the face check. Called when the location check passes. */
async function startFaceVerification() {
  cancelFaceVerification();
  const mine = { active: true };
  session = mine;

  resetLivenessUI();
  verifyPanel.hidden = false;
  setVerifyMessage('loading', 'Starting the camera…');
  setTile('face', 'busy', 'Verifying…');

  try {
    await openCamera(mine);
    if (!mine.active) return;

    setVerifyMessage('loading', 'Loading face detection…');
    const landmarker = await getFaceLandmarker();
    if (!mine.active) return;

    setVerifyMessage('loading', instructionFor({}));
    const outcome = await runLiveness(landmarker, mine);

    if (outcome === 'passed') {
      const time = formatClock(new Date());
      verifiedAt = Date.now();
      setTile('face', 'ok', `Verified at ${time}`);
      setVerifyMessage('pass', `Face check complete. Live face confirmed at ${time}.`);
      showMessage('Face check complete. You can now mark attendance.', 'ok');
    } else if (outcome === 'timeout') {
      setTile('face', 'bad', 'Not verified');
      setVerifyMessage('fail', 'The face check timed out. Tap Verify my location to try again.');
    }
  } catch (err) {
    console.error(err);
    if (mine.active) {
      setTile('face', 'bad', 'Could not start');
      setVerifyMessage('error', describeFaceError(err));
    }
  } finally {
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
