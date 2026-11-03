// Stockage local IndexedDB : points GPS (clé = horodatage, ce qui dédoublonne) et réglages/état.
const DB_NAME = 'rues-de-paris';
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('points'); // clé : ts (ms) ; valeur : [lat, lon, précision, vitesse, activité, source]
      db.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx(store, mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(store, mode);
        const result = fn(t.objectStore(store));
        t.oncomplete = () => resolve(result && 'result' in result ? result.result : result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      })
  );
}

export const kv = {
  get: (k) => tx('kv', 'readonly', (s) => s.get(k)),
  set: (k, v) => tx('kv', 'readwrite', (s) => void s.put(v, k)),
  del: (k) => tx('kv', 'readwrite', (s) => void s.delete(k)),
};

/** Ajoute des points ([ts, lat, lon, acc, spd, motion, src]) ; renvoie ceux qui étaient nouveaux. */
export function addPoints(points) {
  const added = [];
  return tx('points', 'readwrite', (s) => {
    for (const p of points) {
      const req = s.add(p.slice(1), p[0]);
      req.onsuccess = () => added.push(p);
      req.onerror = (e) => {
        e.preventDefault(); // déjà présent : doublon ignoré
        e.stopPropagation();
      };
    }
  }).then(() => added);
}

/** Parcourt les points par paquets triés, entre deux horodatages (inclus). */
export async function eachPointChunk(from, to, size, cb) {
  let lower = from;
  let open_ = false;
  for (;;) {
    const range = IDBKeyRange.bound(lower, to, open_, false);
    const [keys, vals] = await tx('points', 'readonly', (s) => {
      const out = [null, null];
      s.getAllKeys(range, size).onsuccess = (e) => (out[0] = e.target.result);
      s.getAll(range, size).onsuccess = (e) => (out[1] = e.target.result);
      return out;
    });
    if (!keys.length) return;
    await cb(keys.map((k, i) => [k, ...vals[i]]));
    if (keys.length < size) return;
    lower = keys[keys.length - 1];
    open_ = true;
  }
}

export async function pointsBetween(from, to) {
  const all = [];
  await eachPointChunk(from, to, 20000, (c) => void all.push(...c));
  return all;
}

export const countPoints = () => tx('points', 'readonly', (s) => s.count());

export const clearAll = () =>
  Promise.all([tx('points', 'readwrite', (s) => void s.clear()), tx('kv', 'readwrite', (s) => void s.clear())]);
