/**
 * Rues de Paris — récepteur Overland (Cloudflare Worker + D1).
 *
 * Routes (toutes protégées par le jeton, en en-tête `Authorization: Bearer <jeton>`
 * ou en paramètre `?token=<jeton>`) :
 *   POST /overland            reçoit les lots GeoJSON envoyés par Overland
 *   GET  /points?since=<id>   renvoie les points stockés après le curseur <id>
 *   GET  /status              test de connexion (nombre de points, dernier point)
 *
 * Bindings requis : DB (base D1), TOKEN (secret).
 * Variables facultatives : MAX_ACCURACY_M, MAX_SPEED_KMH, ALLOWED_ORIGIN.
 */

const MOTION_DROP = new Set(['driving', 'automotive_navigation', 'cycling']);
const PAGE_MAX = 5000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(env, request);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    if (url.pathname === '/' && request.method === 'GET') {
      return json({ name: 'rues-de-paris', ok: true }, 200, cors);
    }

    if (!env.TOKEN) return json({ error: 'Secret TOKEN non configuré sur le Worker' }, 500, cors);
    if (!env.DB) return json({ error: 'Base D1 non liée (binding "DB")' }, 500, cors);
    if (!checkToken(request, url, env.TOKEN)) return json({ error: 'Jeton invalide' }, 401, cors);

    try {
      if (url.pathname === '/overland' && request.method === 'POST') return await receive(request, env, cors);
      if (url.pathname === '/points' && request.method === 'GET') return await listPoints(url, env, cors);
      if (url.pathname === '/status' && request.method === 'GET') return await status(env, cors);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500, cors);
    }
    return json({ error: 'Route inconnue' }, 404, cors);
  },
};

async function receive(request, env, cors) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'JSON invalide' }, 400, cors);
  }
  const maxAcc = Number(env.MAX_ACCURACY_M || 60);
  const maxSpeed = Number(env.MAX_SPEED_KMH || 15) / 3.6;
  const now = Date.now();
  const rows = [];

  for (const f of body.locations || []) {
    const c = f && f.geometry && f.geometry.coordinates;
    const p = (f && f.properties) || {};
    if (!Array.isArray(c) || c.length < 2) continue;
    const ts = Date.parse(p.timestamp);
    if (!Number.isFinite(ts)) continue;
    const acc = num(p.horizontal_accuracy);
    const speed = num(p.speed);
    const motion = (Array.isArray(p.motion) ? p.motion.join(',') : p.motion) || null;
    // Pré-filtre lâche : on n'enregistre pas ce qui ne peut pas être de la marche.
    if (acc != null && acc > maxAcc) continue;
    if (speed != null && speed > maxSpeed) continue;
    if (motion && motion.split(',').some((m) => MOTION_DROP.has(m))) continue;
    rows.push([String(p.device_id || ''), ts, +c[1], +c[0], acc, speed, motion, now]);
  }

  if (rows.length) {
    const stmt = env.DB.prepare(
      'INSERT OR IGNORE INTO points (device, ts, lat, lon, acc, speed, motion, received) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    // D1 limite la taille d'un batch : on découpe par paquets de 100.
    for (let i = 0; i < rows.length; i += 100) {
      await env.DB.batch(rows.slice(i, i + 100).map((r) => stmt.bind(...r)));
    }
  }
  // Overland considère le lot comme reçu uniquement avec cette réponse exacte.
  return json({ result: 'ok', accepted: rows.length }, 200, cors);
}

async function listPoints(url, env, cors) {
  const since = Math.max(0, parseInt(url.searchParams.get('since') || '0', 10) || 0);
  const limit = Math.min(PAGE_MAX, Math.max(1, parseInt(url.searchParams.get('limit') || PAGE_MAX, 10) || PAGE_MAX));
  const { results } = await env.DB.prepare(
    'SELECT id, ts, lat, lon, acc, speed, motion FROM points WHERE id > ? ORDER BY id LIMIT ?'
  ).bind(since, limit + 1).all();
  const more = results.length > limit;
  const page = more ? results.slice(0, limit) : results;
  return json(
    {
      // Format compact : [id, ts, lat, lon, précision, vitesse, activité]
      points: page.map((r) => [r.id, r.ts, r.lat, r.lon, r.acc, r.speed, r.motion]),
      next: page.length ? page[page.length - 1].id : since,
      more,
    },
    200,
    cors
  );
}

async function status(env, cors) {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n, MAX(ts) AS last FROM points').first();
  return json({ ok: true, points: row ? row.n : 0, last: row ? row.last : null }, 200, cors);
}

function checkToken(request, url, token) {
  const auth = request.headers.get('Authorization') || '';
  const given = auth.startsWith('Bearer ') ? auth.slice(7).trim() : url.searchParams.get('token') || '';
  return safeEqual(given, token);
}

function safeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

function corsHeaders(env, request) {
  const allowed = env.ALLOWED_ORIGIN || '*';
  const origin = request.headers.get('Origin') || '';
  return {
    'Access-Control-Allow-Origin': allowed === '*' ? '*' : allowed.split(',').map((s) => s.trim()).includes(origin) ? origin : allowed.split(',')[0],
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function num(v) {
  const n = Number(v);
  return v == null || v === '' || !Number.isFinite(n) ? null : n;
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
