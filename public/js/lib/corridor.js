// Corridoio del percorso: trova i distributori vicini al tracciato e calcola per ciascuno
// km progressivi, distanza dal percorso, deviazione stimata e tempo di guida dalla partenza.
// Modulo puro (nessun accesso a rete o DOM): usato dal browser e dai test Node.

import { haversine } from './geo.js';

const RAD = Math.PI / 180;

/**
 * Deviazione stimata per raggiungere un distributore a distanza d dal percorso:
 * andata e ritorno (2d) per un fattore di tortuosità stradale. È una stima prudente;
 * per le soste scelte si misura la deviazione reale con il servizio di routing.
 */
export const DETOUR_ROAD_FACTOR = 1.4;
export const DETOUR_SPEED_KMH = 40;
/**
 * Minuti in più per uscire dall'autostrada e rientrare (casello, svincoli). Tarato su
 * misure reali Milano–Roma: Firenze a ~5 km stimati 7 min, reali 18–20 min.
 */
export const TOLL_EXIT_PENALTY_MIN = 10;
/** Sotto questa distanza un distributore autostradale è "sul" percorso, ma forse sulla carreggiata opposta. */
export const HIGHWAY_SIDE_DIST_KM = 0.3;

/**
 * Prepara il percorso per le interrogazioni.
 * @param {Array<[number, number]>} coordsLonLat  coordinate GeoJSON [lon, lat]
 * @param {object} [opts]
 * @param {number} [opts.distance]  distanza totale ufficiale (m); se data, i km vengono riscalati
 * @param {number} [opts.duration]  durata totale (s)
 * @param {Array<{from: number, to: number, duration: number}>} [opts.steps]
 *        tratti con durata nota (indici dei punti, inclusivi), per distribuire i tempi
 * @param {Uint8Array} [opts.toll]  per ogni segmento i→i+1: 1 se a pedaggio (autostrada)
 * @returns {{pts, cumDist: Float64Array, cumTime: Float64Array, distance: number, duration: number, bbox, toll}}
 */
export function prepareRoute(coordsLonLat, { distance, duration, steps, toll = null } = {}) {
  const pts = coordsLonLat.map(([lon, lat]) => ({ lat, lon }));
  const n = pts.length;
  if (n < 2) throw new Error('Percorso con meno di due punti');
  const cumDist = new Float64Array(n);
  for (let i = 1; i < n; i++) cumDist[i] = cumDist[i - 1] + haversine(pts[i - 1], pts[i]);
  const geomLen = cumDist[n - 1];
  if (distance && geomLen > 0) {
    const k = distance / geomLen;
    for (let i = 1; i < n; i++) cumDist[i] *= k;
  }
  const total = cumDist[n - 1];

  // Tempi cumulativi: dentro ogni tratto la durata è distribuita in proporzione alla distanza.
  const cumTime = new Float64Array(n);
  if (steps?.length) {
    for (const s of steps) {
      const d0 = cumDist[s.from];
      const span = cumDist[s.to] - d0;
      const t0 = cumTime[s.from];
      for (let i = s.from + 1; i <= s.to; i++) {
        cumTime[i] = t0 + (span > 0 ? (s.duration * (cumDist[i] - d0)) / span : 0);
      }
    }
    // eventuali punti finali non coperti dai tratti
    for (let i = 1; i < n; i++) if (cumTime[i] < cumTime[i - 1]) cumTime[i] = cumTime[i - 1];
  } else {
    const dur = duration ?? total / (80 / 3.6); // 80 km/h se non si sa nulla
    for (let i = 0; i < n; i++) cumTime[i] = total > 0 ? (dur * cumDist[i]) / total : 0;
  }

  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const p of pts) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }
  return {
    pts, cumDist, cumTime,
    distance: total,
    duration: cumTime[n - 1],
    bbox: { minLat, maxLat, minLon, maxLon },
    toll,
  };
}

/**
 * Proiezione di p sul segmento a-b in coordinate piane locali (metri).
 * @returns {{dist: number, t: number}} distanza dal segmento e frazione 0..1 lungo il segmento
 */
function projectOnSegment(p, a, b) {
  const kx = Math.cos(p.lat * RAD) * 111_320;
  const ky = 110_574;
  const ax = (a.lon - p.lon) * kx, ay = (a.lat - p.lat) * ky;
  const bx = (b.lon - p.lon) * kx, by = (b.lat - p.lat) * ky;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? -(ax * dx + ay * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const x = ax + t * dx, y = ay + t * dy;
  return { dist: Math.sqrt(x * x + y * y), t };
}

/** Indice spaziale dei segmenti del percorso (celle di circa 5 km). */
function segmentGrid(route, cellDeg) {
  const grid = new Map();
  const { pts } = route;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const y0 = Math.floor(Math.min(a.lat, b.lat) / cellDeg), y1 = Math.floor(Math.max(a.lat, b.lat) / cellDeg);
    const x0 = Math.floor(Math.min(a.lon, b.lon) / cellDeg), x1 = Math.floor(Math.max(a.lon, b.lon) / cellDeg);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const k = `${y},${x}`;
        let arr = grid.get(k);
        if (!arr) grid.set(k, (arr = []));
        arr.push(i);
      }
    }
  }
  return grid;
}

/**
 * Distributori entro maxDistKm dal percorso, ordinati per km progressivo.
 * Se il percorso passa più volte vicino allo stesso distributore, vale il passaggio più vicino.
 * @returns {Array<{station, km, distKm, detourKm, detourMin, driveSec}>}
 */
export function findCorridorStations(route, stations, { maxDistKm = 5 } = {}) {
  const maxM = maxDistKm * 1000;
  const cellDeg = 0.05;
  const grid = segmentGrid(route, cellDeg);
  // quante celle controllare intorno al distributore per coprire maxDist
  const reachLat = Math.ceil(maxM / 110_574 / cellDeg);
  const padLat = maxM / 110_574;
  const padLon = maxM / (111_320 * Math.cos(((route.bbox.minLat + route.bbox.maxLat) / 2) * RAD));
  const { bbox, pts, cumDist, cumTime } = route;

  const out = [];
  for (const s of stations) {
    if (s.lat < bbox.minLat - padLat || s.lat > bbox.maxLat + padLat ||
        s.lon < bbox.minLon - padLon * 1.5 || s.lon > bbox.maxLon + padLon * 1.5) continue;
    const cy = Math.floor(s.lat / cellDeg);
    const cx = Math.floor(s.lon / cellDeg);
    const reachLon = Math.ceil(maxM / (111_320 * Math.cos(s.lat * RAD)) / cellDeg);
    const seen = new Set();
    let best = null;
    for (let dy = -reachLat; dy <= reachLat; dy++) {
      for (let dx = -reachLon; dx <= reachLon; dx++) {
        for (const i of grid.get(`${cy + dy},${cx + dx}`) ?? []) {
          if (seen.has(i)) continue;
          seen.add(i);
          const pr = projectOnSegment(s, pts[i], pts[i + 1]);
          if (pr.dist <= maxM && (!best || pr.dist < best.dist)) best = { ...pr, i };
        }
      }
    }
    if (!best) continue;
    const along = cumDist[best.i] + best.t * (cumDist[best.i + 1] - cumDist[best.i]);
    const time = cumTime[best.i] + best.t * (cumTime[best.i + 1] - cumTime[best.i]);
    const distKm = best.dist / 1000;
    const detourKm = 2 * distKm * DETOUR_ROAD_FACTOR;
    let detourMin = (detourKm / DETOUR_SPEED_KMH) * 60;
    const onTollway = route.toll ? route.toll[best.i] === 1 : null;
    // Distributore autostradale a pochi metri dal tracciato: area di servizio sulla nostra
    // autostrada, ma la carreggiata (direzione) va verificata con la deviazione reale.
    const sideUnknown = s.highway === true && distKm <= HIGHWAY_SIDE_DIST_KM;
    if (onTollway && !sideUnknown) detourMin += TOLL_EXIT_PENALTY_MIN;
    out.push({
      station: s,
      km: along / 1000,
      distKm,
      detourKm,
      detourMin,
      driveSec: time,
      onTollway,
      sideUnknown,
    });
  }
  out.sort((a, b) => a.km - b.km);
  return out;
}

/** Punto del percorso al km indicato (per mappe e link al navigatore). */
export function pointAtKm(route, km) {
  const target = km * 1000;
  const { cumDist, pts } = route;
  if (target <= 0) return pts[0];
  if (target >= cumDist[cumDist.length - 1]) return pts[pts.length - 1];
  let lo = 0, hi = cumDist.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cumDist[mid] <= target) lo = mid; else hi = mid;
  }
  const t = (target - cumDist[lo]) / (cumDist[hi] - cumDist[lo] || 1);
  return { lat: pts[lo].lat + t * (pts[hi].lat - pts[lo].lat), lon: pts[lo].lon + t * (pts[hi].lon - pts[lo].lon) };
}
