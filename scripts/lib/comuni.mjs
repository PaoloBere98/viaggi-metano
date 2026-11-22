// Controllo di plausibilità delle coordinate MIMIT: l'impianto deve cadere dentro il
// riquadro del comune dichiarato (confini comunali OSM, admin_level=8), con un margine.
// Le coordinate MIMIT sono inserite dai gestori e a volte puntano alla sede legale
// (es. un impianto di Busto Garolfo posizionato in centro a Milano).

export const COMUNI_QUERY = `[out:json][timeout:180];
area["ISO3166-1"="IT"][admin_level=2]->.it;
rel["boundary"="administrative"]["admin_level"="8"](area.it);
out tags bb;`;

export const MARGIN_KM = 2;

/** Nomi MIMIT diversi da quelli OSM (denominazioni ufficiali o comuni fusi). */
const ALIASES = {
  'REGGIO NELL EMILIA': 'REGGIO EMILIA',
  'CORIGLIANO CALABRO': 'CORIGLIANO ROSSANO',
  'ROSSANO': 'CORIGLIANO ROSSANO',
};

/** Normalizza un nome di comune: maiuscole, senza accenti, apostrofi e trattini. */
export function normName(s) {
  return (s ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[’'`´]/g, ' ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

function variants(tags) {
  const out = new Set();
  for (const k of ['name', 'name:it', 'official_name', 'official_name:it', 'alt_name', 'old_name']) {
    const v = tags[k];
    if (!v) continue;
    for (const part of [v, ...v.split(/\s+[-/]\s+|;/)]) {
      const n = normName(part);
      if (n) out.add(n);
    }
  }
  return [...out];
}

/** Riduce la risposta Overpass a [{names: string[], bbox: [minLat, minLon, maxLat, maxLon]}]. */
export function parseComuni(json) {
  const out = [];
  for (const e of json.elements ?? []) {
    const b = e.bounds;
    if (!b || !e.tags) continue;
    const names = variants(e.tags);
    if (names.length) out.push({ names, bbox: [b.minlat, b.minlon, b.maxlat, b.maxlon] });
  }
  return out;
}

/** Indice nome normalizzato -> elenco di riquadri (più comuni possono avere lo stesso nome). */
export function buildComuniIndex(comuni) {
  const idx = new Map();
  for (const c of comuni) {
    for (const n of c.names) {
      if (!idx.has(n)) idx.set(n, []);
      idx.get(n).push(c.bbox);
    }
  }
  return idx;
}

/**
 * @returns {'ok'|'lontano'|'sconosciuto'}
 *   ok: dentro il riquadro di un comune con quel nome (± margine)
 *   lontano: nessun comune con quel nome contiene il punto
 *   sconosciuto: nome del comune non trovato tra i confini OSM
 */
export function checkComune(idx, comune, lat, lon, marginKm = MARGIN_KM) {
  const n = normName(comune);
  const boxes = idx.get(n) ?? idx.get(ALIASES[n]);
  if (!boxes) return 'sconosciuto';
  const dLat = marginKm / 111;
  const dLon = marginKm / (111 * Math.cos((lat * Math.PI) / 180));
  for (const [a, b, c, d] of boxes) {
    if (lat >= a - dLat && lat <= c + dLat && lon >= b - dLon && lon <= d + dLon) return 'ok';
  }
  return 'lontano';
}
