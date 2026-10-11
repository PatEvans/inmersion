// Persistent translation cache (IndexedDB) with a small in-memory LRU in front.
// Repeated UI strings ("Reply", "Share", "2 hours ago") are paid for once, ever.

const DB = "esx";
const STORE = "tr";
const MAX_MEMORY = 20000;

const memory = new Map();
let dbPromise;

function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

// cyrb53: fast 53-bit string hash; with the length appended collisions are negligible.
export function hash(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36) + "." + str.length.toString(36);
}

export const cacheKey = (lang, engine, source) => `${lang}|${engine}|${hash(source)}`;

function remember(k, v) {
  memory.delete(k);
  memory.set(k, v);
  if (memory.size > MAX_MEMORY) memory.delete(memory.keys().next().value);
}

/** Look up many keys at once. Returns Map(key → translation). */
export async function getMany(keys) {
  const found = new Map();
  const missing = [];
  for (const k of keys) {
    const v = memory.get(k);
    if (v !== undefined) found.set(k, v);
    else missing.push(k);
  }
  if (!missing.length) return found;
  const d = await db();
  await new Promise((resolve) => {
    const tx = d.transaction(STORE, "readonly");
    const store = tx.objectStore(STORE);
    for (const k of missing) {
      const req = store.get(k);
      req.onsuccess = () => {
        if (req.result !== undefined) {
          found.set(k, req.result.v);
          remember(k, req.result.v);
        }
      };
    }
    tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
  });
  return found;
}

let pending = [];
let flushTimer = null;

export function put(k, v) {
  remember(k, v);
  pending.push([k, v]);
  flushTimer ??= setTimeout(flush, 500);
}

async function flush() {
  flushTimer = null;
  const batch = pending;
  pending = [];
  const d = await db();
  const tx = d.transaction(STORE, "readwrite");
  const store = tx.objectStore(STORE);
  const t = Date.now();
  for (const [k, v] of batch) store.put({ v, t }, k);
}

export async function stats() {
  const d = await db();
  return new Promise((resolve) => {
    const req = d.transaction(STORE, "readonly").objectStore(STORE).count();
    req.onsuccess = () => resolve({ entries: req.result });
    req.onerror = () => resolve({ entries: 0 });
  });
}

export async function clear() {
  memory.clear();
  const d = await db();
  await new Promise((resolve) => {
    const tx = d.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    tx.oncomplete = tx.onerror = () => resolve();
  });
}
