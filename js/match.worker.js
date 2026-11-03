// Web Worker : charge les rues, rattache les points GPS aux tronçons et calcule les statistiques.
import { RULES, LON0, LAT0, KX, KY, rejectReason, connected, dayKey } from './core.js';

const CELL = 50; // m, taille des cases de l'index spatial
const BIN_M = 10; // m, résolution de la couverture d'un tronçon
const MAX_BINS = 25; // tient dans un entier 32 bits

let S = null; // rues chargées
let st = null; // état de couverture { v, masks, days, lastKept, lastRaw }

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'init') {
      await loadStreets(msg.url);
      const ok = msg.state && msg.state.v === S.v && msg.state.masks && msg.state.masks.length === S.n;
      st = ok ? msg.state : emptyState();
      self.postMessage({ type: 'ready', id: msg.id, meta: meta(), geojson: geojson(), states: segStates(), stats: stats(), rebuild: !ok && !!msg.state });
    } else if (msg.type === 'process') {
      if (msg.reset) st = emptyState();
      const fresh = processPoints(msg.points);
      self.postMessage({ type: 'result', id: msg.id, state: st, states: segStates(), stats: stats(), fresh });
    } else if (msg.type === 'trace') {
      self.postMessage({ type: 'trace', id: msg.id, lines: trace(msg.points) });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: msg.id, message: String((err && err.message) || err) });
  }
};

function emptyState() {
  return { v: S.v, masks: new Uint32Array(S.n), days: {}, lastKept: null, lastRaw: null, anchor: null };
}

// ---------------------------------------------------------------- chargement

async function gunzip(buf) {
  if (typeof DecompressionStream !== 'undefined') {
    const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).text();
  }
  const { gunzipSync, strFromU8 } = await import('https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js');
  return strFromU8(gunzipSync(buf));
}

async function loadStreets(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fichier des rues introuvable (${res.status})`);
  const buf = new Uint8Array(await res.arrayBuffer());
  // Le serveur peut avoir déjà décompressé (Content-Encoding) : on vérifie l'en-tête gzip.
  const text = buf[0] === 0x1f && buf[1] === 0x8b ? await gunzip(buf) : new TextDecoder().decode(buf);
  const d = JSON.parse(text);

  const n = d.seg.length;
  const name = new Int32Array(n), arr = new Uint8Array(n), off = new Int32Array(n + 1);
  let total = 0;
  for (const r of d.seg) total += (r.length - 2) / 2;
  const lon = new Float64Array(total), lat = new Float64Array(total);
  const x = new Float64Array(total), y = new Float64Array(total), cum = new Float64Array(total);
  const len = new Float64Array(n), nb = new Uint8Array(n);

  let k = 0;
  for (let i = 0; i < n; i++) {
    const r = d.seg[i];
    name[i] = r[0];
    arr[i] = r[1];
    off[i] = k;
    let qx = 0, qy = 0;
    for (let j = 2; j < r.length; j += 2) {
      qx += r[j];
      qy += r[j + 1];
      lon[k] = qx / 1e5;
      lat[k] = qy / 1e5;
      x[k] = (lon[k] - LON0) * KX;
      y[k] = (lat[k] - LAT0) * KY;
      cum[k] = j === 2 ? 0 : cum[k - 1] + Math.hypot(x[k] - x[k - 1], y[k] - y[k - 1]);
      k++;
    }
    len[i] = cum[k - 1];
    nb[i] = Math.max(1, Math.min(MAX_BINS, Math.round(len[i] / BIN_M)));
  }
  off[n] = k;

  // Index spatial : chaque tronçon est inscrit dans les cases que traversent ses morceaux.
  const grid = new Map();
  for (let i = 0; i < n; i++) {
    const seen = new Set();
    for (let v = off[i]; v < off[i + 1] - 1; v++) {
      const c0x = Math.floor(Math.min(x[v], x[v + 1]) / CELL), c1x = Math.floor(Math.max(x[v], x[v + 1]) / CELL);
      const c0y = Math.floor(Math.min(y[v], y[v + 1]) / CELL), c1y = Math.floor(Math.max(y[v], y[v + 1]) / CELL);
      for (let cx = c0x; cx <= c1x; cx++)
        for (let cy = c0y; cy <= c1y; cy++) {
          const key = cellKey(cx, cy);
          if (seen.has(key)) continue;
          seen.add(key);
          let list = grid.get(key);
          if (!list) grid.set(key, (list = []));
          list.push(i);
        }
    }
  }

  // Agrégats fixes par rue et par arrondissement.
  const nNames = d.names.length;
  const streetLen = new Float64Array(nNames), streetSegs = new Uint32Array(nNames), streetArr = new Uint32Array(nNames);
  const streetBox = new Float64Array(nNames * 4).fill(NaN);
  const arrLen = new Float64Array(21), arrBox = new Float64Array(21 * 4).fill(NaN);
  for (let i = 0; i < n; i++) {
    const s = name[i];
    streetLen[s] += len[i];
    streetSegs[s]++;
    streetArr[s] |= 1 << arr[i];
    arrLen[arr[i]] += len[i];
    for (let v = off[i]; v < off[i + 1]; v++) {
      grow(streetBox, s, lon[v], lat[v]);
      grow(arrBox, arr[i], lon[v], lat[v]);
    }
  }

  S = { v: d.v, date: d.date, names: d.names, n, name, arr, off, lon, lat, x, y, cum, len, nb, grid,
        streetLen, streetSegs, streetArr, streetBox, arrLen, arrBox, stamp: new Int32Array(n), tick: 0 };
}

function cellKey(cx, cy) {
  return (cx + 20000) * 40000 + (cy + 20000);
}

function grow(box, i, lo, la) {
  const b = i * 4;
  if (!(box[b] <= lo)) box[b] = lo;
  if (!(box[b + 1] <= la)) box[b + 1] = la;
  if (!(box[b + 2] >= lo)) box[b + 2] = lo;
  if (!(box[b + 3] >= la)) box[b + 3] = la;
}

function meta() {
  return {
    v: S.v, date: S.date, names: S.names, segCount: S.n,
    streetLen: S.streetLen, streetSegs: S.streetSegs, streetArr: S.streetArr, streetBox: S.streetBox,
    arrLen: S.arrLen, arrBox: S.arrBox,
  };
}

function geojson() {
  const features = new Array(S.n);
  for (let i = 0; i < S.n; i++) {
    const coords = [];
    for (let v = S.off[i]; v < S.off[i + 1]; v++) coords.push([S.lon[v], S.lat[v]]);
    features[i] = { type: 'Feature', id: i, properties: { s: S.name[i], a: S.arr[i] }, geometry: { type: 'LineString', coordinates: coords } };
  }
  return { type: 'FeatureCollection', features };
}

// ---------------------------------------------------------------- correspondance

function popcount(m) {
  m -= (m >>> 1) & 0x55555555;
  m = (m & 0x33333333) + ((m >>> 2) & 0x33333333);
  return (((m + (m >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

function isVisited(i) {
  return popcount(st.masks[i]) / S.nb[i] >= RULES.threshold;
}

/** Distance du point (px,py) au tronçon i : [distance, abscisse le long, dx, dy du morceau]. */
function nearestOn(i, px, py) {
  let best = Infinity, along = 0, dx = 0, dy = 0;
  const { x, y, cum } = S;
  for (let v = S.off[i]; v < S.off[i + 1] - 1; v++) {
    const ax = x[v], ay = y[v], bx = x[v + 1] - ax, by = y[v + 1] - ay;
    const l2 = bx * bx + by * by;
    const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * bx + (py - ay) * by) / l2)) : 0;
    const d = Math.hypot(px - ax - t * bx, py - ay - t * by);
    if (d < best) {
      best = d;
      along = cum[v] + t * Math.sqrt(l2);
      const l = Math.sqrt(l2) || 1;
      dx = bx / l;
      dy = by / l;
    }
  }
  return [best, along, dx, dy];
}

/** Rattache un échantillon au tronçon le plus proche (en tenant compte de la direction de marche). */
function matchSample(px, py, hx, hy, fresh, day) {
  const R = RULES.matchDist;
  const tick = ++S.tick;
  const cands = [];
  for (let cx = Math.floor((px - R) / CELL); cx <= Math.floor((px + R) / CELL); cx++)
    for (let cy = Math.floor((py - R) / CELL); cy <= Math.floor((py + R) / CELL); cy++) {
      const list = S.grid.get(cellKey(cx, cy));
      if (!list) continue;
      for (const i of list) {
        if (S.stamp[i] === tick) continue;
        S.stamp[i] = tick;
        const [d, along, dx, dy] = nearestOn(i, px, py);
        if (d > R) continue;
        const cos = hx || hy ? Math.abs(dx * hx + dy * hy) : 1;
        cands.push({ i, d, along, cos, score: d + 8 * (1 - cos) });
      }
    }
  if (!cands.length) return;
  let best = cands[0];
  for (const c of cands) if (c.score < best.score) best = c;
  mark(best.i, best.along, fresh, day);
  // Voies doubles (boulevards à deux chaussées) : la chaussée parallèle de même nom compte aussi.
  for (const c of cands)
    if (c !== best && S.name[c.i] === S.name[best.i] && c.cos > 0.9 && c.d <= R) mark(c.i, c.along, fresh, day);
}

function mark(i, along, fresh, day) {
  const nb = S.nb[i];
  const b = Math.min(nb - 1, Math.floor((along / (S.len[i] || 1)) * nb));
  const before = isVisited(i);
  st.masks[i] |= 1 << b;
  if (!before && isVisited(i)) {
    fresh.push(i);
    day.n++;
  }
}

function project(p) {
  return [(p[2] - LON0) * KX, (p[1] - LAT0) * KY];
}

function processPoints(points) {
  const fresh = [];
  points.sort((a, b) => a[0] - b[0]);
  for (const p of points) {
    // Point hors de la séquence (import d'une ancienne trace) : il ne se relie pas au dernier point.
    let prevRaw = st.lastRaw && st.lastRaw[0] < p[0] ? st.lastRaw : null;
    if (rejectReason(p, prevRaw)) {
      if (p[3] == null || p[3] <= RULES.maxAccuracy) if (!st.lastRaw || p[0] > st.lastRaw[0]) st.lastRaw = p;
      continue;
    }
    const key = dayKey(p[0]);
    const day = st.days[key] || (st.days[key] = { km: 0, s: 0, n: 0, p: 0 });
    day.p++;
    const [px, py] = project(p);
    const prev = st.lastKept;
    if (prev && connected(prev, p)) {
      const [qx, qy] = project(prev);
      const d = Math.hypot(px - qx, py - qy);
      // Distance mesurée par paliers de 15 m pour ne pas compter le zigzag du bruit GPS.
      const anchor = st.anchor || prev;
      const [ax, ay] = project(anchor);
      const da = Math.hypot(px - ax, py - ay);
      if (da >= 15) {
        day.km += da / 1000;
        st.anchor = p;
      } else st.anchor = anchor;
      day.s += (p[0] - prev[0]) / 1000;
      const hx = d ? (px - qx) / d : 0, hy = d ? (py - qy) / d : 0;
      const steps = Math.max(1, Math.ceil(d / RULES.step));
      for (let k = 1; k <= steps; k++) {
        const t = k / steps;
        matchSample(qx + (px - qx) * t, qy + (py - qy) * t, hx, hy, fresh, day);
      }
    } else {
      st.anchor = p;
      matchSample(px, py, 0, 0, fresh, day);
    }
    if (!st.lastKept || p[0] > st.lastKept[0]) st.lastKept = p;
    if (!st.lastRaw || p[0] > st.lastRaw[0]) st.lastRaw = p;
  }
  return fresh;
}

/** Polylignes d'une journée (points filtrés, coupées aux interruptions) pour l'affichage. */
function trace(points) {
  points.sort((a, b) => a[0] - b[0]);
  const lines = [];
  let cur = null, prevRaw = null, prevKept = null;
  for (const p of points) {
    const bad = rejectReason(p, prevRaw);
    if (p[3] == null || p[3] <= RULES.maxAccuracy) prevRaw = p;
    if (bad) continue;
    if (!prevKept || !connected(prevKept, p)) lines.push((cur = []));
    cur.push([p[2], p[1]]);
    prevKept = p;
  }
  return lines;
}

// ---------------------------------------------------------------- statistiques

function segStates() {
  const out = new Uint8Array(S.n);
  for (let i = 0; i < S.n; i++) out[i] = st.masks[i] ? (isVisited(i) ? 2 : 1) : 0;
  return out;
}

function stats() {
  const nNames = S.names.length;
  const streetVis = new Float64Array(nNames), streetSegsVis = new Uint32Array(nNames);
  const arrVis = new Float64Array(21);
  let visLen = 0, visSegs = 0, totalLen = 0;
  for (let i = 0; i < S.n; i++) {
    totalLen += S.len[i];
    if (!isVisited(i)) continue;
    visSegs++;
    visLen += S.len[i];
    streetVis[S.name[i]] += S.len[i];
    streetSegsVis[S.name[i]]++;
    arrVis[S.arr[i]] += S.len[i];
  }
  let streetsDone = 0, streetsStarted = 0;
  for (let s = 0; s < nNames; s++) {
    if (streetSegsVis[s]) streetsStarted++;
    if (streetVis[s] / S.streetLen[s] >= RULES.threshold) streetsDone++;
  }
  let km = 0, walkDays = 0;
  for (const k in st.days) {
    km += st.days[k].km;
    if (st.days[k].km >= 0.1) walkDays++;
  }
  return { totalLen, visLen, visSegs, segCount: S.n, streetVis, streetSegsVis, streetsDone, streetsStarted,
           streetCount: nNames, arrVis, km, walkDays, days: st.days };
}

