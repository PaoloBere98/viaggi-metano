// Distributori di metano da OpenStreetMap tramite Overpass API.

export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

export const OVERPASS_QUERY = `[out:json][timeout:180];
area["ISO3166-1"="IT"][admin_level=2]->.it;
nwr["amenity"="fuel"]["fuel:cng"="yes"](area.it);
out center tags;`;

/** Esegue la query provando più server, con un tentativo per ciascuno. */
export async function fetchOverpass({ query = OVERPASS_QUERY, fetchImpl = fetch, log = console.log } = {}) {
  let lastErr;
  for (const url of OVERPASS_ENDPOINTS) {
    try {
      log(`Overpass: ${url}`);
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'viaggi-metano-data/1.0 (aggiornamento giornaliero)',
        },
        body: 'data=' + encodeURIComponent(query),
        signal: AbortSignal.timeout(240_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (!Array.isArray(json.elements)) throw new Error('risposta senza "elements"');
      return json;
    } catch (e) {
      const cause = e.cause ? ` (${e.cause.code ?? e.cause.message ?? e.cause})` : '';
      lastErr = new Error(`${url}: ${e.message}${cause}`);
      log(`  fallito: ${e.message}${cause}`);
    }
  }
  throw new Error(`Overpass non raggiungibile: ${lastErr?.message}`);
}

function yesNo(v) {
  if (v == null) return null;
  if (/^(yes|only)$/i.test(v)) return true;
  if (/^no$/i.test(v)) return false;
  return null;
}

/**
 * Converte la risposta Overpass in un elenco di distributori.
 * Considera solo amenity=fuel con fuel:cng=yes.
 */
export function parseOverpass(json) {
  const out = [];
  for (const e of json.elements ?? []) {
    const t = e.tags ?? {};
    if (t.amenity !== 'fuel' || t['fuel:cng'] !== 'yes') continue;
    const lat = e.lat ?? e.center?.lat;
    const lon = e.lon ?? e.center?.lon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const addr = [t['addr:street'], t['addr:housenumber']].filter(Boolean).join(' ');
    out.push({
      osmId: `${e.type}/${e.id}`,
      lat,
      lon,
      name: t.name ?? null,
      brand: t.brand ?? null,
      operator: t.operator ?? null,
      // Orario specifico dell'erogatore metano, se mappato, altrimenti quello dell'impianto.
      oh: t['fuel:cng:opening_hours'] ?? t.opening_hours ?? null,
      ohScope: t['fuel:cng:opening_hours'] ? 'cng' : t.opening_hours ? 'impianto' : null,
      selfService: yesNo(t.self_service),
      automated: yesNo(t.automated),
      phone: t.phone ?? t['contact:phone'] ?? null,
      website: t.website ?? t['contact:website'] ?? null,
      address: addr || null,
      city: t['addr:city'] ?? null,
      checkDate: t['check_date:opening_hours'] ?? t.check_date ?? null,
    });
  }
  return out;
}
