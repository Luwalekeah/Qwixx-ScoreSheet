// Plain JavaScript service worker. No bundler, no imports, no Supabase URL,
// no key, no reference to any environment variable.

const CACHE_NAME = 'qwixx-shell-v1';
const PRECACHE_URLS = [
  '/',
  '/rules',
  '/offline',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  if (url.pathname.startsWith('/api/')) {
    // Network only. Never cached, never stored.
    return;
  }

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((response) => response)
        .catch(() =>
          caches.match(event.request).then((cached) => cached || caches.match('/offline')),
        ),
    );
    return;
  }

  if (url.pathname.startsWith('/_next/static/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          return response;
        });
      }),
    );
    return;
  }

  // Everything else: network only.
});

// iOS Safari does not implement Background Sync, so this is an enhancement
// only. The page-level flusher in lib/sync.ts is the primary path and this
// handler duplicates only the happy (200) case, exactly per the sync design.
self.addEventListener('sync', (event) => {
  if (event.tag !== 'qwixx-flush') return;
  event.waitUntil(flushFromServiceWorker());
});

function idbOpen() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('qwixx', 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function idbGet(db, storeName, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGetAllByIndex(db, storeName, indexName, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).index(indexName).getAll(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(db, storeName, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).put(value);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbDelete(db, storeName, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).delete(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function flushFromServiceWorker() {
  let db;
  try {
    db = await idbOpen();
  } catch {
    return;
  }

  const lastGame = await idbGet(db, 'meta', 'lastGame');
  if (!lastGame || !lastGame.code) return;
  const code = lastGame.code;

  const sheetRecord = await idbGet(db, 'sheets', code);
  if (!sheetRecord) return;

  const queueEntries = await idbGetAllByIndex(db, 'queue', 'code', code);
  if (!queueEntries || queueEntries.length === 0) return;

  const batch = queueEntries.slice(0, 50);
  const mutations = batch.map((entry) => entry.mutation);

  let response;
  try {
    response = await fetch(`/api/games/${code}/mutations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseVersion: sheetRecord.lastAckedVersion, mutations }),
    });
  } catch {
    // Leave the queue and sheet untouched. The page reconciles next time it opens.
    return;
  }

  if (response.status !== 200) {
    // Handle only the 200 case. Anything else is left for the page.
    return;
  }

  let body;
  try {
    body = await response.json();
  } catch {
    return;
  }

  sheetRecord.serverSheet = body.sheet;
  sheetRecord.lastAckedVersion = body.version;
  sheetRecord.lockedRows = body.lockedRows;
  sheetRecord.gameStatus = body.gameStatus;

  await idbPut(db, 'sheets', sheetRecord);
  for (const entry of batch) {
    await idbDelete(db, 'queue', entry.seq);
  }
}
