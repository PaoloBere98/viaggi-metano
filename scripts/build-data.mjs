#!/usr/bin/env node
// Costruisce public/data/metano.json a partire da MIMIT (prezzi + anagrafica) e OpenStreetMap.
//
// Uso:
//   node scripts/build-data.mjs                      scarica tutto dalla rete
//   node scripts/build-data.mjs --mimit-dir DIR      usa CSV MIMIT già scaricati in DIR
//   node scripts/build-data.mjs --osm-file FILE      usa una risposta Overpass già scaricata
//
// Se Overpass non risponde, riusa la copia in data-cache/osm-cng.json (se ha meno di
// OSM_CACHE_MAX_DAYS giorni), dichiarandone la data reale nel file prodotto.
// Se MIMIT non risponde o il formato è cambiato, lo script fallisce senza toccare i dati
// pubblicati: meglio dati di ieri che dati sbagliati.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { decodeMimit, parseAnagrafica, parsePrezzi, collectMetanoPrices } from './lib/mimit.mjs';
import { fetchOverpass, parseOverpass } from './lib/osm.mjs';
import { matchStations } from './lib/match.mjs';
import { COMUNI_QUERY, parseComuni, buildComuniIndex, checkComune } from './lib/comuni.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_FILE = join(ROOT, 'public', 'data', 'metano.json');
const OSM_CACHE = join(ROOT, 'data-cache', 'osm-cng.json');
const OSM_CACHE_MAX_DAYS = 14;
const COMUNI_CACHE = join(ROOT, 'data-cache', 'comuni.json');
const COMUNI_REFRESH_DAYS = 30; // i confini comunali cambiano raramente
const MIN_STATIONS = 1000; // sotto questa soglia qualcosa è andato storto

export const MIMIT_BASE = 'https://www.mimit.gov.it/images/exportCSV/';
const UA = 'Mozilla/5.0 (compatible; viaggi-metano-data/1.0)';

async function fetchMimit(name) {
  const url = MIMIT_BASE + name;
  console.log(`MIMIT: ${url}`);
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return decodeMimit(new Uint8Array(await res.arrayBuffer()));
    } catch (e) {
      lastErr = e;
      const cause = e.cause ? ` (${e.cause.code ?? e.cause.message ?? e.cause})` : '';
      lastErr = new Error(`${e.message}${cause}`);
      console.log(`  tentativo ${attempt} fallito: ${e.message}${cause}`);
      await new Promise((r) => setTimeout(r, 5000 * attempt));
    }
  }
  throw new Error(`MIMIT ${name} non scaricabile: ${lastErr?.message}`);
}

async function loadOsm(osmFile) {
  if (osmFile) return JSON.parse(await readFile(osmFile, 'utf8'));
  try {
    const json = await fetchOverpass();
    await mkdir(dirname(OSM_CACHE), { recursive: true });
    await writeFile(OSM_CACHE, JSON.stringify(json));
    return json;
  } catch (e) {
    console.log(`Overpass non disponibile (${e.message}): provo la copia in cache`);
    const json = JSON.parse(await readFile(OSM_CACHE, 'utf8'));
    const ts = Date.parse(json.osm3s?.timestamp_osm_base ?? '');
    const ageDays = (Date.now() - ts) / 86_400_000;
    if (!(ageDays <= OSM_CACHE_MAX_DAYS)) throw new Error(`cache OSM troppo vecchia (${ageDays.toFixed(1)} giorni)`);
    return json;
  }
}

/** Confini comunali ridotti (nome + riquadro), aggiornati ogni COMUNI_REFRESH_DAYS giorni. */
async function loadComuni() {
  let cached = null;
  try {
    cached = JSON.parse(await readFile(COMUNI_CACHE, 'utf8'));
  } catch { /* nessuna cache */ }
  const age = cached ? (Date.now() - Date.parse(cached.savedAt)) / 86_400_000 : Infinity;
  if (age <= COMUNI_REFRESH_DAYS) return cached.comuni;
  try {
    const comuni = parseComuni(await fetchOverpass({ query: COMUNI_QUERY }));
    if (comuni.length < 7000) throw new Error(`solo ${comuni.length} comuni`);
    await mkdir(dirname(COMUNI_CACHE), { recursive: true });
    await writeFile(COMUNI_CACHE, JSON.stringify({ savedAt: new Date().toISOString(), comuni }));
    return comuni;
  } catch (e) {
    console.log(`Confini comunali non aggiornati (${e.message})${cached ? ': uso la cache' : ': controllo coordinate saltato'}`);
    return cached?.comuni ?? null;
  }
}

const round6 = (x) => Math.round(x * 1e6) / 1e6;

/** Unisce MIMIT e OSM nell'elenco finale dei distributori. Esportata per i test. */
export function buildStations({ anagrafica, prices, osm, comuniIdx = null }) {
  const metanoAnag = anagrafica.filter((a) => prices.has(a.id));
  const withCoords = metanoAnag.filter((a) => a.lat !== null);
  // Coordinate lontane dal comune dichiarato: posizione inaffidabile. Non le abbiniamo a
  // OSM, perché il distributore OSM vicino sarebbe con ogni probabilità un altro impianto.
  const farIds = new Set(
    comuniIdx ? withCoords.filter((a) => checkComune(comuniIdx, a.comune, a.lat, a.lon) === 'lontano').map((a) => a.id) : [],
  );
  const matches = matchStations(withCoords.filter((a) => !farIds.has(a.id)), osm);
  const usedOsm = new Set([...matches.values()].map((m) => m.osm.osmId));

  const stations = [];
  for (const a of withCoords) {
    const mt = matches.get(a.id);
    const o = mt?.osm;
    stations.push({
      ...(farIds.has(a.id) ? { posDubbia: true } : {}),
      id: `m${a.id}`,
      src: o ? 'mimit+osm' : 'mimit',
      name: o?.name || a.nome || a.bandiera,
      brand: a.bandiera,
      operator: a.gestore,
      address: a.indirizzo,
      city: a.comune,
      prov: a.provincia,
      // Le coordinate OSM sono di solito più precise di quelle dichiarate dai gestori.
      lat: round6(o ? o.lat : a.lat),
      lon: round6(o ? o.lon : a.lon),
      highway: a.autostradale,
      prices: prices.get(a.id),
      osm: o ? osmPart(o, mt.dist) : null,
    });
  }
  // Distributori presenti solo su OSM: non confermati dal MIMIT (potrebbero essere chiusi
  // o non vendere più metano). Il pianificatore li tratta con cautela.
  for (const o of osm) {
    if (usedOsm.has(o.osmId)) continue;
    stations.push({
      id: `o${o.osmId.replace('/', ':')}`,
      src: 'osm',
      name: o.name || o.brand || 'Distributore metano',
      brand: o.brand,
      operator: o.operator,
      address: o.address,
      city: o.city,
      prov: null,
      lat: round6(o.lat),
      lon: round6(o.lon),
      highway: null,
      prices: null,
      osm: osmPart(o, null),
    });
  }
  return {
    stations,
    stats: {
      mimitMetano: metanoAnag.length,
      mimitSenzaCoordinate: metanoAnag.length - withCoords.length,
      osmCng: osm.length,
      abbinati: matches.size,
      soloOsm: osm.length - usedOsm.size,
      conOrari: stations.filter((s) => s.osm?.oh).length,
      posizioneDubbia: farIds.size,
    },
  };
}

function osmPart(o, dist) {
  const p = { id: o.osmId };
  if (dist !== null) p.dist = Math.round(dist);
  for (const k of ['oh', 'ohScope', 'selfService', 'automated', 'phone', 'website', 'checkDate']) {
    if (o[k] !== null && o[k] !== undefined) p[k] = o[k];
  }
  return p;
}

async function main() {
  const { values } = parseArgs({
    options: { 'mimit-dir': { type: 'string' }, 'osm-file': { type: 'string' }, out: { type: 'string' } },
  });
  const readLocal = async (name) => decodeMimit(await readFile(join(values['mimit-dir'], name)));
  const getMimit = values['mimit-dir'] ? readLocal : fetchMimit;

  const anag = parseAnagrafica(await getMimit('anagrafica_impianti_attivi.csv'));
  const prez = parsePrezzi(await getMimit('prezzo_alle_8.csv'));
  const { byId: prices, discarded } = collectMetanoPrices(prez.rows);
  const osmJson = await loadOsm(values['osm-file']);
  const osm = parseOverpass(osmJson);
  const comuni = await loadComuni();
  const comuniIdx = comuni ? buildComuniIndex(comuni) : null;

  const { stations, stats } = buildStations({ anagrafica: anag.rows, prices, osm, comuniIdx });

  console.log(`Anagrafica: ${anag.rows.length} impianti, ${anag.warnings.length} avvisi`);
  for (const w of anag.warnings.slice(0, 5)) console.log(`  ${w}`);
  console.log(`Prezzi: ${prez.rows.length} righe, ${prez.warnings.length} avvisi; prezzi metano scartati: ${discarded.length}`);
  for (const d of discarded) console.log(`  id ${d.id}: ${d.prezzo} €/kg`);
  console.log('Statistiche:', stats);

  if (stats.mimitMetano < MIN_STATIONS) {
    throw new Error(`solo ${stats.mimitMetano} impianti a metano: dati sospetti, file non aggiornato`);
  }

  const out = {
    version: 1,
    generatedAt: new Date().toISOString(),
    sources: {
      mimit: {
        anagrafica: anag.extractionDate,
        prezzi: prez.extractionDate,
        url: 'https://www.mimit.gov.it/it/open-data/elenco-dataset/carburanti-prezzi-praticati-e-anagrafica-degli-impianti',
        licenza: 'IODL 2.0',
      },
      osm: {
        timestamp: osmJson.osm3s?.timestamp_osm_base ?? null,
        licenza: '© OpenStreetMap contributors, ODbL',
      },
    },
    stats,
    stations,
  };
  const outFile = values.out ? resolve(values.out) : OUT_FILE;
  await mkdir(dirname(outFile), { recursive: true });
  await writeFile(outFile, JSON.stringify(out));
  console.log(`Scritto ${outFile} (${stations.length} distributori)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`ERRORE: ${e.message}`);
    // su GitHub Actions l'errore compare anche come annotazione nel riepilogo dell'esecuzione
    if (process.env.GITHUB_ACTIONS) console.log(`::error title=Aggiornamento dati::${e.message.replace(/\r?\n/g, ' ')}`);
    process.exit(1);
  });
}
