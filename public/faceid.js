'use strict';

/*
 * Face ID: checks that the face in front of the camera is
 *   1. a live face, not a photo or a video playing on a screen, and
 *   2. the same person as the Face ID saved for this employee.
 *
 * Uses the Human library (https://github.com/vladmandic/human), loaded from the CDN.
 * sw.js caches the library and its models, so this also works offline.
 *
 * IMPORTANT: all of this runs inside the browser, so a technically skilled person can
 * bypass it (for example with the browser's developer tools). It stops casual
 * misuse, such as one colleague marking in for another. For real protection,
 * the matching must also be done on your server.
 */
const FaceID = (() => {
  // Keep HUMAN_VERSION in sync with sw.js.
  const HUMAN_VERSION = '3.3.6';
  const HUMAN_BASE = `https://cdn.jsdelivr.net/npm/@vladmandic/human@${HUMAN_VERSION}`;
  const HUMAN_BUNDLE_URL = `${HUMAN_BASE}/dist/human.esm.js`;
  const MODEL_BASE_PATH = `${HUMAN_BASE}/models/`;

  // Setting up or replacing a Face ID needs the school administrator's passcode.
  // Only a hash is kept here. The default passcode is:  School-Admin-2026
  // CHANGE IT: in the browser console run
  //   crypto.subtle.digest('SHA-256', new TextEncoder().encode('YOUR NEW PASSCODE')).then(b => console.log([...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('')))
  // and paste the result below. (Anyone can read this hash, so use a long passcode.)
  const ADMIN_PASSCODE_SHA256 = 'c0606816521209a5b49f0d02ffd02904b5fcf63fb84a7d260ac5bc7484398450';

  /* ---------- Tuning ---------- */
  // Recommended comparison settings for Human's default "faceres" model.
  const MATCH_OPTIONS = { order: 2, multiplier: 25, min: 0.2, max: 0.8 };
  const MATCH_THRESHOLD = 0.50;   // similarity (0 to 1) needed to count as the same person
  const MIN_REAL = 0.50;          // anti-spoof score: below this looks like a screen or a print
  const MIN_LIVE = 0.50;          // liveness score: below this looks like a recording
  const MIN_FACE_SCORE = 0.6;    // how sure the detector is that it sees a face
  const MIN_FACE_SIZE = 160;     // smallest face (pixels) that is clear enough to compare
  const MIN_GOOD_SAMPLES = 5;    // clear camera frames needed to decide
  const ENROLL_EMBEDDINGS = 5;   // face samples stored per employee
  const REQUIRE_FACE_MATCH = true;
  const REQUIRE_ANTISPOOF = true;

  const HUMAN_CONFIG = {
    cacheSensitivity: 0,                                   // always analyse the frame we give it
    modelBasePath: MODEL_BASE_PATH,
    filter: { enabled: true, equalization: true },         // evens out lighting
    face: {
      enabled: true,
      detector: { rotation: true, maxDetected: 2 },        // 2, so a second face in view is noticed
      description: { enabled: true },                      // the face "fingerprint" used for matching
      iris: { enabled: true },
      emotion: { enabled: false },
      antispoof: { enabled: true },
      liveness: { enabled: true }
    },
    body: { enabled: false },
    hand: { enabled: false },
    object: { enabled: false },
    gesture: { enabled: false }
  };

  /* ---------- Loading the models ---------- */
  let humanPromise = null;

  function loadHuman() {
    if (!humanPromise) {
      humanPromise = (async () => {
        const H = await import(HUMAN_BUNDLE_URL);
        const human = new H.Human(HUMAN_CONFIG);
        await human.load();
        return human;
      })().catch((err) => {
        humanPromise = null; // allow a retry
        throw err;
      });
    }
    return humanPromise;
  }

  /** Looks at one camera frame. Returns null if no face is visible. */
  async function sample(video) {
    const human = await loadHuman();
    const result = await human.detect(video);
    const faces = (result && result.face) || [];
    if (!faces.length) return null;

    const face = faces.slice().sort((a, b) => b.box[2] * b.box[3] - a.box[2] * a.box[3])[0];
    return {
      faces: faces.length,
      embedding: face.embedding ? Array.from(face.embedding) : null,
      real: face.real || 0,
      live: face.live || 0,
      score: face.faceScore || face.boxScore || 0,
      size: Math.min(face.box[2], face.box[3])
    };
  }

  function isGoodSample(s) {
    return !!(s && s.embedding && s.embedding.length > 0 && s.score >= MIN_FACE_SCORE && s.size >= MIN_FACE_SIZE);
  }

  function countGood(samples) {
    return samples.filter(isGoodSample).length;
  }

  /* ---------- Deciding ---------- */
  function median(values) {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function evenlySpaced(items, n) {
    if (items.length <= n) return items;
    return Array.from({ length: n }, (_, i) => items[Math.round((i * (items.length - 1)) / (n - 1))]);
  }

  async function defaultSimilarity(embedding, list) {
    const human = await loadHuman();
    return human.match.find(embedding, list, MATCH_OPTIONS).similarity;
  }

  // Checks shared by verifying and setting up: enough clear frames, one face, a live face.
  function screen(samples) {
    const good = samples.filter(isGoodSample);
    const details = { frames: samples.length, goodFrames: good.length };
    if (good.length < MIN_GOOD_SAMPLES) return { ok: false, reason: 'not-enough-frames', ...details };

    const multi = samples.filter((s) => s.faces > 1).length;
    if (multi > samples.length / 3) return { ok: false, reason: 'multiple-faces', ...details };

    details.real = median(good.map((s) => s.real));
    details.live = median(good.map((s) => s.live));
    if (REQUIRE_ANTISPOOF && (details.real < MIN_REAL || details.live < MIN_LIVE)) {
      return { ok: false, reason: 'spoof', ...details };
    }
    return { ok: true, good, details };
  }

  /**
   * Is the person in these camera samples live, and the person saved in the template?
   * Resolves { ok, reason?, similarity, real, live, frames, goodFrames }.
   */
  async function verify(samples, template, similarity = defaultSimilarity) {
    const check = screen(samples);
    if (!check.ok) return check;

    const scores = [];
    for (const s of check.good) scores.push(await similarity(s.embedding, template.embeddings));
    const details = { ...check.details, similarity: median(scores) };

    if (REQUIRE_FACE_MATCH && details.similarity < MATCH_THRESHOLD) return { ok: false, reason: 'no-match', ...details };
    return { ok: true, ...details };
  }

  /** Builds the face samples to save for a new Face ID. Resolves { ok, embeddings?, reason?, ... }. */
  async function buildTemplate(samples, similarity = defaultSimilarity) {
    const check = screen(samples);
    if (!check.ok) return check;

    const picked = evenlySpaced(check.good, ENROLL_EMBEDDINGS);
    const first = [picked[0].embedding];
    const scores = [];
    for (const s of picked.slice(1)) scores.push(await similarity(s.embedding, first));
    const details = { ...check.details, similarity: scores.length ? median(scores) : 1 };

    // All samples must be the same person, so two people can't be mixed into one Face ID.
    if (REQUIRE_FACE_MATCH && details.similarity < MATCH_THRESHOLD) return { ok: false, reason: 'inconsistent', ...details };
    return { ok: true, embeddings: picked.map((s) => s.embedding), ...details };
  }

  /* ---------- Saved Face IDs (on this device) ---------- */
  const DB_NAME = 'attendance-faceid';
  const STORE = 'templates';
  let dbPromise = null;

  function openDB() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains(STORE)) {
            request.result.createObjectStore(STORE, { keyPath: 'employeeId' });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => { dbPromise = null; reject(request.error); };
      });
    }
    return dbPromise;
  }

  async function withStore(mode, run) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = run(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request ? request.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Could not use Face ID storage.'));
    });
  }

  const getTemplate = (employeeId) => withStore('readonly', (store) => store.get(employeeId)).then((t) => t || null);
  const saveTemplate = (template) => withStore('readwrite', (store) => store.put(template));
  const deleteTemplate = (employeeId) => withStore('readwrite', (store) => store.delete(employeeId));

  /* ---------- Administrator passcode ---------- */
  async function sha256Hex(text) {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  async function checkAdminPasscode(passcode) {
    return (await sha256Hex(String(passcode))) === ADMIN_PASSCODE_SHA256;
  }

  return {
    MIN_GOOD_SAMPLES,
    loadHuman, sample, countGood, verify, buildTemplate,
    getTemplate, saveTemplate, deleteTemplate, checkAdminPasscode
  };
})();
