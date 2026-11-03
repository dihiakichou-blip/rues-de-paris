// Constantes et fonctions partagées entre l'interface et le Web Worker.

export const RULES = {
  maxAccuracy: 30, // m : points moins précis ignorés
  maxKmh: 7, // km/h : au-delà, ce n'est plus de la marche
  matchDist: 20, // m : distance max point → tronçon
  step: 5, // m : pas de densification entre deux points
  maxGapS: 180, // s : au-delà, deux points ne sont pas reliés
  maxGapM: 300, // m : idem en distance
  threshold: 0.6, // part de la longueur à couvrir pour « visiter » un tronçon
};

const DROP_MOTION = /driving|automotive|cycling/;

// Projection locale équirectangulaire autour de Paris (mètres), suffisante à cette échelle.
export const LON0 = 2.3488;
export const LAT0 = 48.8534;
export const KX = 111320 * Math.cos((LAT0 * Math.PI) / 180);
export const KY = 110540;

/** Point compact : [ts(ms), lat, lon, précision|null, vitesse m/s|null, activité|null, source] */
export function distM(a, b) {
  return Math.hypot((a[2] - b[2]) * KX, (a[1] - b[1]) * KY);
}

/** Raison du rejet d'un point, ou null s'il est conservé. `prev` = point précédent jugé précis. */
export function rejectReason(p, prev) {
  const acc = p[3], spd = p[4], mo = p[5];
  if (acc != null && acc > RULES.maxAccuracy) return 'précision';
  if (mo && DROP_MOTION.test(mo)) return 'activité';
  if (spd != null && spd >= 0 && spd * 3.6 >= RULES.maxKmh) return 'vitesse';
  if (prev) {
    const dt = (p[0] - prev[0]) / 1000;
    if (dt <= 0) return 'doublon';
    const d = distM(prev, p);
    if (dt <= RULES.maxGapS && d > 25 && (d / dt) * 3.6 >= RULES.maxKmh) return 'vitesse';
  }
  return null;
}

/** Deux points conservés successifs appartiennent-ils à la même marche ? */
export function connected(a, b) {
  const dt = (b[0] - a[0]) / 1000;
  if (dt <= 0 || dt > RULES.maxGapS) return false;
  const d = distM(a, b);
  return d <= RULES.maxGapM && (d < 25 || (d / dt) * 3.6 < RULES.maxKmh * 1.3);
}

export function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
