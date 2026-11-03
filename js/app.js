import { kv, addPoints, eachPointChunk, pointsBetween, countPoints, clearAll } from './db.js';

const STREETS_URL = new URL('../data/streets.json.gz', import.meta.url).href;
const STYLES = {
  light: 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json',
  dark: 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json',
};
const COLORS = {
  light: { base: '#d3cdc3', partial: '#ffb59c', visited: '#ff4f1f', hl: '#2563eb', trace: '#2563eb' },
  dark: { base: '#4b505d', partial: '#7a3a26', visited: '#ff6a3d', hl: '#60a5fa', trace: '#60a5fa' },
};
const LIST_MAX = 300;

const $ = (id) => document.getElementById(id);
const nf1 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1, minimumFractionDigits: 0 });
const nf0 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 0 });
const collator = new Intl.Collator('fr', { sensitivity: 'base', numeric: true });
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const theme = () => (darkQuery.matches ? 'dark' : 'light');

const arrLabel = (n) => (n === 1 ? '1er' : `${n}e`);
const pct = (r) => {
  const v = r * 100;
  return `${v > 0 && v < 10 ? nf1.format(Math.round(v * 10) / 10) : nf0.format(Math.round(v))} %`;
};
const km = (m) => nf1.format(m >= 10 ? Math.round(m) : Math.round(m * 10) / 10);
const len = (m) => (m < 1000 ? `${nf0.format(Math.max(10, Math.round(m / 10) * 10))} m` : `${km(m / 1000)} km`);
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[-'’]/g, ' ');

// ------------------------------------------------------------------ état

let settings = { url: '', token: '' };
let meta = null; // métadonnées fixes des rues (venant du worker)
let stats = null; // statistiques courantes
let geo = null; // GeoJSON des tronçons
let states = new Uint8Array(0); // 0 = jamais, 1 = entamé, 2 = visité
let shown = null; // états déjà appliqués sur la carte
let normNames = [];
let map = null;
let styleReady = false;
let traceLines = null;
let highlight = -1;
let syncing = false;
let lastSync = 0;
let currentTab = 'map';
let streetFilter = 'visited';

// ------------------------------------------------------------------ Web Worker (RPC)

const worker = new Worker(new URL('./match.worker.js', import.meta.url), { type: 'module' });
const pending = new Map();
let rpcId = 0;
worker.onmessage = (e) => {
  const m = e.data;
  const p = pending.get(m.id);
  if (!p) return;
  pending.delete(m.id);
  m.type === 'error' ? p.reject(new Error(m.message)) : p.resolve(m);
};
worker.onerror = (e) => fatal(`Erreur du calcul : ${e.message || 'module non chargé'}`);
function call(msg) {
  return new Promise((resolve, reject) => {
    const id = ++rpcId;
    pending.set(id, { resolve, reject });
    worker.postMessage({ ...msg, id });
  });
}
// Les traitements sont exécutés l'un après l'autre.
let queue = Promise.resolve();
const enqueue = (fn) => (queue = queue.then(fn, fn));

async function applyResult(r) {
  stats = r.stats;
  applyStates(r.states);
  await kv.set('match', r.state);
  renderAll();
}

function processNew(points) {
  return enqueue(async () => {
    if (!points.length) return 0;
    const r = await call({ type: 'process', points });
    await applyResult(r);
    return r.fresh.length;
  });
}

function rebuild() {
  return enqueue(async () => {
    toast('Recalcul de toutes les rues…', 60000);
    let r = null;
    await eachPointChunk(0, Infinity, 50000, async (chunk) => {
      r = await call({ type: 'process', points: chunk, reset: !r });
    });
    if (!r) r = await call({ type: 'process', points: [], reset: true });
    await applyResult(r);
    toast(`Recalcul terminé : ${nf0.format(stats.visSegs)} tronçons visités.`);
  });
}

// ------------------------------------------------------------------ carte

function initMap() {
  map = new maplibregl.Map({
    container: 'map',
    style: STYLES[theme()],
    center: [2.3428, 48.8575],
    zoom: 11.6,
    minZoom: 10,
    maxBounds: [[2.1, 48.74], [2.6, 48.97]],
    attributionControl: { compact: true },
    dragRotate: false,
    pitchWithRotate: false,
  });
  map.touchZoomRotate.disableRotation();
  map.on('style.load', () => {
    styleReady = true;
    addOverlay();
  });
  darkQuery.addEventListener('change', () => {
    styleReady = false;
    map.setStyle(STYLES[theme()], { diff: false });
  });

  map.on('click', (e) => {
    if (currentTab !== 'map') return openTab('map');
    const f = map.queryRenderedFeatures([[e.point.x - 10, e.point.y - 10], [e.point.x + 10, e.point.y + 10]], { layers: ['streets-hit'] })
      .sort((a, b) => states[b.id] - states[a.id])[0];
    if (!f) {
      setHighlight(-1);
      return;
    }
    const s = f.properties.s;
    const st = states[f.id];
    const ratio = stats.streetVis[s] / meta.streetLen[s];
    new maplibregl.Popup({ closeButton: true, maxWidth: '260px' })
      .setLngLat(e.lngLat)
      .setHTML(
        `<b>${esc(meta.names[s])}</b><br><span class="muted small">${arrLabel(f.properties.a)} arr. · ${
          st === 2 ? 'tronçon visité ✓' : st === 1 ? 'tronçon entamé' : 'tronçon jamais parcouru'
        }</span><br><span class="small">Rue parcourue à ${pct(ratio)} (${len(meta.streetLen[s])})</span>`
      )
      .addTo(map);
  });
  map.on('mouseenter', 'streets-hit', () => (map.getCanvas().style.cursor = 'pointer'));
  map.on('mouseleave', 'streets-hit', () => (map.getCanvas().style.cursor = ''));
}

function addOverlay() {
  if (!geo || !styleReady || map.getSource('streets')) return;
  const c = COLORS[theme()];
  // Au-dessus de toutes les routes du fond de carte, mais sous les libellés.
  const layers = map.getStyle().layers;
  let lastLine = -1;
  layers.forEach((l, i) => l.type !== 'symbol' && (lastLine = i));
  const firstSymbol = (layers.slice(lastLine + 1).find((l) => l.type === 'symbol') || {}).id;
  const width = (k, lo = k) => ['interpolate', ['exponential', 1.6], ['zoom'], 11, 0.5 * lo, 14, 1.6 * k, 17, 5 * k];
  const isState = (v) => ['case', ['==', ['feature-state', 's'], v], 1, 0];

  map.addSource('streets', { type: 'geojson', data: geo });
  map.addLayer({ id: 'streets-base', type: 'line', source: 'streets', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': c.base, 'line-width': width(0.9) } }, firstSymbol);
  map.addLayer({ id: 'streets-partial', type: 'line', source: 'streets', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': c.partial, 'line-width': width(1.1, 2.5), 'line-opacity': isState(1) } }, firstSymbol);
  map.addLayer({ id: 'streets-visited', type: 'line', source: 'streets', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': c.visited, 'line-width': width(1.6, 5), 'line-opacity': isState(2) } }, firstSymbol);
  map.addLayer({ id: 'streets-hl', type: 'line', source: 'streets', filter: ['==', ['get', 's'], highlight],
    layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': c.hl, 'line-width': width(2.2) } }, firstSymbol);
  map.addLayer({ id: 'streets-hit', type: 'line', source: 'streets', paint: { 'line-color': '#000', 'line-opacity': 0, 'line-width': 16 } });

  map.addSource('trace', { type: 'geojson', data: traceGeo() });
  map.addLayer({ id: 'trace', type: 'line', source: 'trace', layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': c.trace, 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 2, 16, 5], 'line-opacity': 0.85 } });

  shown = new Uint8Array(states.length);
  applyStates(states);
}

function applyStates(next) {
  states = next;
  if (!map || !shown || !map.getSource('streets')) return;
  for (let i = 0; i < next.length; i++) {
    if (shown[i] !== next[i]) {
      map.setFeatureState({ source: 'streets', id: i }, { s: next[i] });
      shown[i] = next[i];
    }
  }
}

function setHighlight(s) {
  highlight = s;
  if (map.getLayer('streets-hl')) map.setFilter('streets-hl', ['==', ['get', 's'], s]);
}

function fitBox(box, i, maxZoom = 16) {
  const b = [box[i * 4], box[i * 4 + 1], box[i * 4 + 2], box[i * 4 + 3]];
  if (!b.every(Number.isFinite)) return;
  map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: mapPadding(), maxZoom, duration: 800 });
}

function mapPadding() {
  const wide = innerWidth >= 720;
  return { top: 110, bottom: 110, left: 40, right: wide ? 460 : 40 };
}

function traceGeo() {
  return { type: 'FeatureCollection', features: traceLines ? [{ type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: traceLines } }] : [] };
}

async function showTrace(key, day) {
  const [y, m, d] = key.split('-').map(Number);
  const from = new Date(y, m - 1, d).getTime();
  const to = new Date(y, m - 1, d + 1).getTime() - 1;
  const pts = await pointsBetween(from, to);
  const r = await call({ type: 'trace', points: pts });
  traceLines = r.lines.filter((l) => l.length > 1);
  if (map.getSource('trace')) map.getSource('trace').setData(traceGeo());
  openTab('map');
  const all = traceLines.flat();
  if (all.length) {
    const lo = all.map((p) => p[0]), la = all.map((p) => p[1]);
    map.fitBounds([[Math.min(...lo), Math.min(...la)], [Math.max(...lo), Math.max(...la)]], { padding: mapPadding(), maxZoom: 16, duration: 800 });
  }
  $('traceLabel').textContent = `${new Date(from).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })} · ${km(day.km)} km`;
  $('traceBar').hidden = false;
}

function hideTrace() {
  traceLines = null;
  if (map.getSource('trace')) map.getSource('trace').setData(traceGeo());
  $('traceBar').hidden = true;
}

let locMarker = null;
function locate() {
  if (!navigator.geolocation) return toast('Localisation indisponible sur cet appareil.');
  navigator.geolocation.getCurrentPosition(
    (p) => {
      const ll = [p.coords.longitude, p.coords.latitude];
      if (!locMarker) {
        const el = document.createElement('div');
        el.style.cssText = 'width:16px;height:16px;border-radius:50%;background:#2563eb;border:3px solid #fff;box-shadow:0 0 0 6px rgba(37,99,235,.25)';
        locMarker = new maplibregl.Marker({ element: el });
      }
      locMarker.setLngLat(ll).addTo(map);
      map.flyTo({ center: ll, zoom: Math.max(map.getZoom(), 15.5) });
    },
    () => toast('Autorisez la localisation pour vous situer sur la carte.'),
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

// ------------------------------------------------------------------ rendu des panneaux

function renderAll() {
  renderHud();
  if (currentTab === 'stats') renderStats();
  if (currentTab === 'streets') renderStreets();
  if (currentTab === 'history') renderHistory();
}

function renderHud() {
  if (!stats) return;
  $('hudPct').textContent = pct(stats.visLen / stats.totalLen);
  $('hudSub').textContent = `de Paris · ${km(stats.km)} km`;
}

function renderStats() {
  const r = stats.visLen / stats.totalLen;
  $('statPct').textContent = pct(r);
  $('ringFg').style.strokeDashoffset = String(326.7 * (1 - Math.min(1, r)));
  $('statKm').textContent = km(stats.km);
  $('statStreets').textContent = nf0.format(stats.streetsStarted);
  $('statStreetsSub').textContent = `rues parcourues sur ${nf0.format(stats.streetCount)}`;
  $('statDone').textContent = nf0.format(stats.streetsDone);
  $('statSegs').textContent = nf0.format(stats.visSegs);
  $('statSegsSub').textContent = `tronçons sur ${nf0.format(stats.segCount)}`;
  const list = $('arrList');
  list.innerHTML = '';
  for (let a = 1; a <= 20; a++) {
    const ratio = meta.arrLen[a] ? stats.arrVis[a] / meta.arrLen[a] : 0;
    const li = document.createElement('li');
    li.innerHTML = `<b>${arrLabel(a)}</b><div class="bar"><i style="width:${Math.min(100, ratio * 100)}%"></i></div><span class="pct">${pct(ratio)}</span>`;
    li.onclick = () => {
      openTab('map');
      fitBox(meta.arrBox, a, 15);
    };
    list.append(li);
  }
}

function renderStreets() {
  const q = norm($('streetSearch').value.trim());
  const n = meta.names.length;
  const items = [];
  for (let s = 0; s < n; s++) {
    const visited = stats.streetSegsVis[s] > 0;
    if (streetFilter === 'visited' && !visited) continue;
    if (streetFilter === 'never' && visited) continue;
    if (q && !normNames[s].includes(q)) continue;
    items.push(s);
  }
  if (streetFilter === 'visited') items.sort((a, b) => stats.streetVis[b] / meta.streetLen[b] - stats.streetVis[a] / meta.streetLen[a] || collator.compare(meta.names[a], meta.names[b]));
  else items.sort((a, b) => collator.compare(meta.names[a], meta.names[b]));

  const label = { visited: 'rue(s) visitée(s)', never: 'rue(s) jamais visitée(s)', all: 'rue(s)' }[streetFilter];
  $('streetCount').textContent = `${nf0.format(items.length)} ${label}${items.length > LIST_MAX ? ` — ${LIST_MAX} premières affichées, affinez la recherche` : ''}`;
  const ul = $('streetList');
  ul.innerHTML = '';
  if (!items.length) {
    ul.innerHTML = `<li class="empty">${streetFilter === 'visited' && !q ? 'Aucune rue visitée pour l’instant. Allez marcher !' : 'Aucune rue trouvée.'}</li>`;
    return;
  }
  const frag = document.createDocumentFragment();
  for (const s of items.slice(0, LIST_MAX)) {
    const ratio = stats.streetVis[s] / meta.streetLen[s];
    const arrs = [];
    for (let a = 1; a <= 20; a++) if (meta.streetArr[s] & (1 << a)) arrs.push(arrLabel(a));
    const li = document.createElement('li');
    li.innerHTML = `<span class="name">${esc(meta.names[s])}</span><span class="pct">${pct(ratio)}</span>
      <span class="sub">${arrs.join(', ')} · ${len(meta.streetLen[s])} · ${stats.streetSegsVis[s]}/${meta.streetSegs[s]} tronçons${ratio >= 0.6 ? '<span class="badge">complétée</span>' : ''}</span>`;
    li.onclick = () => {
      openTab('map');
      setHighlight(s);
      fitBox(meta.streetBox, s, 17);
      toast(meta.names[s]);
    };
    frag.append(li);
  }
  ul.append(frag);
}

function renderHistory() {
  const ul = $('dayList');
  ul.innerHTML = '';
  const days = Object.entries(stats.days).filter(([, d]) => d.km >= 0.05 || d.n > 0).sort((a, b) => (a[0] < b[0] ? 1 : -1));
  if (!days.length) {
    ul.innerHTML = '<li class="empty">Aucune marche enregistrée pour l’instant.</li>';
    return;
  }
  const frag = document.createDocumentFragment();
  for (const [key, d] of days) {
    const [y, m, dd] = key.split('-').map(Number);
    const date = cap(new Date(y, m - 1, dd).toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }));
    const li = document.createElement('li');
    li.innerHTML = `<span class="date">${date}</span><span class="km">${km(d.km)} <small>km</small></span>
      <span class="sub">${duration(d.s)}${d.n ? ` · <b>${d.n}</b> nouveau${d.n > 1 ? 'x' : ''} tronçon${d.n > 1 ? 's' : ''}` : ''}</span>`;
    li.onclick = () => showTrace(key, d);
    frag.append(li);
  }
  ul.append(frag);
}

function duration(s) {
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}`;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ------------------------------------------------------------------ onglets

function openTab(name) {
  if (name === currentTab && name !== 'map') name = 'map';
  currentTab = name;
  for (const b of document.querySelectorAll('.tabbar button')) b.toggleAttribute('aria-current', b.dataset.tab === name);
  for (const s of document.querySelectorAll('.sheet')) s.hidden = s.id !== `sheet-${name}`;
  if (!stats) return;
  if (name === 'stats') renderStats();
  if (name === 'streets') renderStreets();
  if (name === 'history') renderHistory();
  if (name === 'settings') renderSettings();
}

// ------------------------------------------------------------------ serveur

function baseUrl(u = settings.url) {
  return u.trim().replace(/\/+$/, '');
}

function overlandUrl(s = settings) {
  if (!s.url || !s.token) return null;
  return `${baseUrl(s.url)}/overland?token=${encodeURIComponent(s.token)}`;
}

async function api(path, s = settings) {
  let res;
  try {
    res = await fetch(baseUrl(s.url) + path, { headers: { Authorization: `Bearer ${s.token}` }, cache: 'no-store' });
  } catch {
    throw new Error('Serveur injoignable (adresse incorrecte ou pas de réseau).');
  }
  if (res.status === 401) throw new Error('Jeton refusé par le serveur.');
  const data = await res.json().catch(() => null);
  if (!res.ok || !data) throw new Error((data && data.error) || `Erreur du serveur (${res.status}).`);
  return data;
}

async function testConnection(s) {
  if (!/^https?:\/\//.test(s.url)) throw new Error('L’adresse doit commencer par https://');
  if (!s.token) throw new Error('Indiquez le jeton secret.');
  const r = await api('/status', s);
  const last = r.last ? ` · dernière position ${new Date(r.last).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}` : '';
  return `✓ Connecté — ${nf0.format(r.points)} position(s) sur le serveur${last}`;
}

async function sync({ silent = false } = {}) {
  if (!settings.url || !settings.token || syncing || !meta) {
    if (!silent && (!settings.url || !settings.token)) toast('Configurez d’abord le serveur dans les Réglages.');
    return;
  }
  syncing = true;
  setSyncUi('busy');
  try {
    let cursor = (await kv.get('cursor')) || 0;
    let received = 0, fresh = 0;
    for (;;) {
      const r = await api(`/points?since=${cursor}&limit=5000`);
      const pts = r.points.map(([, ts, lat, lon, acc, spd, mo]) => [ts, lat, lon, acc, spd, mo || null, 'ov']);
      const added = await addPoints(pts);
      fresh += await processNew(added);
      received += added.length;
      cursor = r.next;
      await kv.set('cursor', cursor);
      if (!r.more) break;
    }
    lastSync = Date.now();
    await kv.set('lastSync', lastSync);
    setSyncUi('ok');
    if (fresh) toast(`🎉 ${fresh} nouveau${fresh > 1 ? 'x' : ''} tronçon${fresh > 1 ? 's' : ''} découvert${fresh > 1 ? 's' : ''} !`);
    else if (!silent) toast(received ? `${nf0.format(received)} position(s) reçue(s).` : 'Aucune nouvelle position.');
  } catch (e) {
    setSyncUi('err');
    if (!silent) toast(e.message);
  } finally {
    syncing = false;
  }
}

function setSyncUi(mode) {
  const btn = $('syncBtn');
  btn.classList.toggle('busy', mode === 'busy');
  btn.classList.toggle('err', mode === 'err');
  if (mode === 'busy') $('syncLabel').textContent = 'Synchro…';
  else if (mode === 'err') $('syncLabel').textContent = 'Hors ligne';
  else $('syncLabel').textContent = !settings.url ? 'Non connecté' : lastSync ? ago(lastSync) : 'Synchroniser';
}

function ago(t) {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'à l’instant';
  if (m < 60) return `il y a ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `il y a ${h} h`;
  return new Date(t).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
}

// ------------------------------------------------------------------ réglages

async function saveSettings(s) {
  settings = { url: baseUrl(s.url), token: s.token.trim() };
  await kv.set('settings', settings);
  updateOverlandUrls();
  setSyncUi('ok');
}

function updateOverlandUrls() {
  const u = overlandUrl();
  $('overlandUrl').textContent = u || 'Renseignez d’abord l’adresse et le jeton.';
  $('obOverlandUrl').textContent = u || 'Renseignez d’abord l’étape 2.';
}

async function renderSettings() {
  $('setUrl').value = settings.url;
  $('setToken').value = settings.token;
  updateOverlandUrls();
  const n = await countPoints();
  $('aboutInfo').textContent = `${nf0.format(n)} position(s) stockée(s) sur cet appareil · fichier des rues du ${meta.date} (${nf0.format(meta.segCount)} tronçons, ${nf0.format(meta.names.length)} rues).`;
}

function parseGpx(text, fileName) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error(`${fileName} : fichier GPX illisible.`);
  const out = [];
  let noTime = 0;
  for (const el of doc.getElementsByTagName('trkpt')) {
    const lat = parseFloat(el.getAttribute('lat')), lon = parseFloat(el.getAttribute('lon'));
    const t = el.getElementsByTagName('time')[0];
    const ts = t ? Date.parse(t.textContent.trim()) : NaN;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (!Number.isFinite(ts)) {
      noTime++;
      continue;
    }
    const sp = el.getElementsByTagName('speed')[0];
    const spd = sp ? parseFloat(sp.textContent) : null;
    out.push([ts, lat, lon, null, Number.isFinite(spd) ? spd : null, null, 'gpx']);
  }
  if (!out.length) throw new Error(noTime ? `${fileName} : la trace n’a pas d’horaires, impossible de vérifier qu’il s’agit de marche.` : `${fileName} : aucun point de trace.`);
  return out;
}

async function importGpx(files) {
  let added = 0, fresh = 0;
  for (const f of files) {
    try {
      const pts = parseGpx(await f.text(), f.name);
      const a = await addPoints(pts);
      added += a.length;
      fresh += await processNew(a);
    } catch (e) {
      toast(e.message, 5000);
      await wait(2500);
    }
  }
  toast(`${nf0.format(added)} point(s) importé(s)${fresh ? `, ${fresh} nouveau(x) tronçon(s)` : ''}.`);
}

async function exportBackup() {
  toast('Préparation de la sauvegarde…');
  const points = [];
  await eachPointChunk(0, Infinity, 50000, (c) => void points.push(...c));
  const data = { app: 'rues-de-paris', format: 1, exportedAt: new Date().toISOString(), workerUrl: settings.url,
                 cursor: (await kv.get('cursor')) || 0, points };
  const name = `rues-de-paris-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([JSON.stringify(data)], name, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Sauvegarde Rues de Paris' });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

async function importBackup(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    return toast('Ce fichier n’est pas une sauvegarde valide.');
  }
  if (!data || data.app !== 'rues-de-paris' || !Array.isArray(data.points)) return toast('Ce fichier n’est pas une sauvegarde de Rues de Paris.');
  const pts = data.points.filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[2]));
  const added = await addPoints(pts);
  if (data.cursor && !(await kv.get('cursor'))) await kv.set('cursor', data.cursor);
  if (data.workerUrl && !settings.url) await saveSettings({ url: data.workerUrl, token: settings.token });
  toast(`${nf0.format(added.length)} position(s) restaurée(s).`);
  await rebuild();
}

// ------------------------------------------------------------------ guide de démarrage

const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
let installPrompt = null;
addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
});

function renderInstallStep() {
  const box = $('obInstall');
  if (isStandalone()) {
    box.innerHTML = '<p class="done-box">✓ L’app est installée. Parfait !</p>';
    return;
  }
  if (isIos) {
    const share = '<svg class="share-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3m0 0L8 7m4-4 4 4M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1"/></svg>';
    box.innerHTML = `<ol class="install-steps">
        <li>Touchez le bouton <b>Partager</b> ${share} dans la barre de Safari.</li>
        <li>Faites défiler et choisissez <b>« Sur l’écran d’accueil »</b>.</li>
        <li>Touchez <b>Ajouter</b>, puis ouvrez <b>Rues de Paris</b> depuis son icône.</li>
      </ol>
      <p class="muted small">Important : poursuivez ce guide <b>depuis l’icône</b> sur l’écran d’accueil. Sur iPhone, l’app installée a son propre stockage, séparé de Safari.</p>`;
    return;
  }
  box.innerHTML = `<p>Installez l’app pour l’ouvrir en plein écran comme une vraie application.</p>
    ${installPrompt ? '<button class="btn primary wide" id="obInstallBtn">Installer l’app</button>' : '<p class="muted small">Dans le menu du navigateur, choisissez « Installer l’application » ou « Ajouter à l’écran d’accueil ». Vous pouvez aussi continuer dans le navigateur.</p>'}`;
  const b = $('obInstallBtn');
  if (b) b.onclick = async () => {
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    renderInstallStep();
  };
}

function guideUrl() {
  const h = location.hostname;
  if (h.endsWith('.github.io')) {
    const repo = location.pathname.split('/').filter(Boolean)[0];
    return `https://github.com/${h.split('.')[0]}/${repo || h}#readme`;
  }
  return new URL('README.md', location.href).href;
}

function showOnboarding() {
  const ob = $('onboard');
  const steps = $('obSteps');
  const n = steps.children.length;
  ob.hidden = false;
  renderInstallStep();
  $('obGuideLink').href = guideUrl();
  $('obUrl').value = settings.url;
  $('obToken').value = settings.token;
  updateOverlandUrls();
  $('obDots').innerHTML = '<i></i>'.repeat(n);
  steps.scrollLeft = 0;
  const idx = () => Math.round(steps.scrollLeft / steps.clientWidth);
  const update = () => {
    const i = idx();
    [...$('obDots').children].forEach((d, k) => d.classList.toggle('on', k === i));
    $('obPrev').style.visibility = i ? 'visible' : 'hidden';
    $('obNext').textContent = i === 0 ? 'Commencer' : i === n - 1 ? 'Ouvrir la carte' : 'Suivant';
  };
  steps.onscroll = () => requestAnimationFrame(update);
  update();
  const go = (i) => steps.scrollTo({ left: i * steps.clientWidth, behavior: 'smooth' });
  $('obPrev').onclick = () => go(idx() - 1);
  $('obNext').onclick = () => (idx() >= n - 1 ? finishOnboarding() : go(idx() + 1));
  $('obSkip').onclick = finishOnboarding;
}

async function finishOnboarding() {
  $('onboard').hidden = true;
  await kv.set('onboarded', true);
  sync({ silent: true });
}

// ------------------------------------------------------------------ divers

let toastTimer = null;
function toast(msg, ms = 3000) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function fatal(msg) {
  $('loading').innerHTML = `<p style="max-width:320px;text-align:center;padding:20px">${esc(msg)}</p>`;
  $('loading').classList.remove('gone');
}

function bindUi() {
  for (const b of document.querySelectorAll('.tabbar button')) b.onclick = () => openTab(b.dataset.tab);
  $('scoreBtn').onclick = () => openTab('stats');
  $('syncBtn').onclick = () => (settings.url ? sync() : openTab('settings'));
  $('locateBtn').onclick = locate;
  $('traceClose').onclick = hideTrace;

  $('streetSearch').oninput = () => renderStreets();
  for (const b of document.querySelectorAll('.seg-ctrl button'))
    b.onclick = () => {
      streetFilter = b.dataset.filter;
      for (const o of document.querySelectorAll('.seg-ctrl button')) o.setAttribute('aria-selected', String(o === b));
      renderStreets();
    };

  $('setSave').onclick = async () => {
    const s = { url: baseUrl($('setUrl').value), token: $('setToken').value.trim() };
    const out = $('setStatus');
    out.className = 'status small';
    out.textContent = 'Test en cours…';
    try {
      const msg = await testConnection(s);
      await saveSettings(s);
      out.textContent = msg;
      out.classList.add('ok');
      sync({ silent: true });
    } catch (e) {
      out.textContent = e.message;
      out.classList.add('err');
    }
  };
  $('setSync').onclick = () => sync();
  $('obTest').onclick = async () => {
    const s = { url: baseUrl($('obUrl').value), token: $('obToken').value.trim() };
    const out = $('obStatus');
    out.className = 'status small';
    out.textContent = 'Test en cours…';
    try {
      const msg = await testConnection(s);
      await saveSettings(s);
      out.textContent = `${msg}. Passez à l’étape suivante.`;
      out.classList.add('ok');
    } catch (e) {
      out.textContent = e.message;
      out.classList.add('err');
    }
  };
  for (const b of document.querySelectorAll('[data-copy]'))
    b.onclick = async () => {
      const text = $(b.dataset.copy).textContent;
      if (!text.startsWith('http')) return toast('Rien à copier pour l’instant.');
      try {
        await navigator.clipboard.writeText(text);
        toast('Adresse copiée. Collez-la dans Overland.');
      } catch {
        const r = document.createRange();
        r.selectNodeContents($(b.dataset.copy));
        getSelection().removeAllRanges();
        getSelection().addRange(r);
        toast('Sélectionnée : appuyez sur Copier.');
      }
    };

  $('gpxInput').onchange = (e) => {
    importGpx([...e.target.files]);
    e.target.value = '';
  };
  $('backupInput').onchange = (e) => {
    if (e.target.files[0]) importBackup(e.target.files[0]);
    e.target.value = '';
  };
  $('exportBtn').onclick = exportBackup;
  $('rebuildBtn').onclick = rebuild;
  $('guideBtn').onclick = () => {
    openTab('map');
    showOnboarding();
  };
  $('wipeBtn').onclick = async () => {
    if (!confirm('Effacer toutes les positions, les rues visitées et les réglages de cet appareil ? Les données du serveur ne sont pas touchées.')) return;
    await clearAll();
    location.reload();
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - lastSync > 60000) sync({ silent: true });
  });
  setInterval(() => !syncing && setSyncUi('ok'), 60000);
}

async function start() {
  bindUi();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (!window.maplibregl) return fatal('Impossible de charger la carte. Vérifiez votre connexion puis rouvrez l’app.');
  settings = (await kv.get('settings')) || settings;
  lastSync = (await kv.get('lastSync')) || 0;
  setSyncUi('ok');
  initMap();
  const r = await call({ type: 'init', url: STREETS_URL, state: await kv.get('match') }).catch((e) => fatal(e.message));
  if (!r) return;
  meta = r.meta;
  geo = r.geojson;
  stats = r.stats;
  normNames = meta.names.map(norm);
  applyStates(r.states);
  addOverlay();
  renderAll();
  $('loading').classList.add('gone');
  if (r.rebuild) await rebuild(); // le fichier des rues a changé : on recalcule depuis les points
  if (!(await kv.get('onboarded'))) showOnboarding();
  else sync({ silent: true });
}

start();
