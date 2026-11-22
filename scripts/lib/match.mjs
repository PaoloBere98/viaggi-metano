// Abbinamento tra impianti MIMIT e distributori OSM per vicinanza geografica.
//
// Regole (su dati del 22/11/2026: 1.110 impianti entro 100 m, 37 tra 100 e 250 m):
//  - abbinamento 1:1, si accoppiano prima le coppie più vicine (greedy);
//  - entro MAX_DIST metri sempre;
//  - entro MAX_DIST_BRAND metri solo se il marchio coincide.

import { haversine } from '../../public/js/lib/geo.js';

export const MAX_DIST = 150;
export const MAX_DIST_BRAND = 300;

const STOP = new Set(['pompe', 'bianche', 'spa', 'srl', 'snc', 'sas', 'italia', 'the', 'di']);
const ALIAS = { agip: 'eni', enilive: 'eni', esso: 'esso', tamoil: 'tamoil', ip: 'ip', api: 'ip' };

export function brandTokens(s) {
  if (!s) return new Set();
  return new Set(
    s.toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 2 && !STOP.has(w))
      .map((w) => ALIAS[w] ?? w),
  );
}

export function sameBrand(a, b) {
  const ta = brandTokens(a);
  if (ta.size === 0) return false;
  for (const w of brandTokens(b)) if (ta.has(w)) return true;
  return false;
}

/**
 * @param {Array<{id, lat, lon, bandiera}>} mimit  impianti con coordinate valide
 * @param {Array<{osmId, lat, lon, brand, name}>} osm
 * @returns {Map<string, {osm: object, dist: number}>} id MIMIT -> distributore OSM abbinato
 */
export function matchStations(mimit, osm, { maxDist = MAX_DIST, maxDistBrand = MAX_DIST_BRAND } = {}) {
  // Indice a griglia (~1 km) per non confrontare tutte le coppie.
  const CELL = 0.01;
  const key = (lat, lon) => `${Math.floor(lat / CELL)},${Math.floor(lon / CELL)}`;
  const grid = new Map();
  for (const o of osm) {
    const k = key(o.lat, o.lon);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(o);
  }

  const pairs = [];
  for (const m of mimit) {
    const cy = Math.floor(m.lat / CELL);
    const cx = Math.floor(m.lon / CELL);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (const o of grid.get(`${cy + dy},${cx + dx}`) ?? []) {
          const dist = haversine(m, o);
          if (dist > maxDistBrand) continue;
          if (dist > maxDist && !sameBrand(m.bandiera, o.brand ?? o.name)) continue;
          pairs.push({ m, o, dist });
        }
      }
    }
  }
  pairs.sort((a, b) => a.dist - b.dist);

  const result = new Map();
  const usedOsm = new Set();
  for (const { m, o, dist } of pairs) {
    if (result.has(m.id) || usedOsm.has(o.osmId)) continue;
    result.set(m.id, { osm: o, dist });
    usedOsm.add(o.osmId);
  }
  return result;
}
