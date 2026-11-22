// Stato di apertura di un distributore in un dato istante, con fonte e data della fonte.
//
// REGOLA FONDAMENTALE: "aperto" solo se un dato lo sostiene (orario OSM o Google, oppure
// una segnalazione personale). Senza dati si arriva al massimo a "probabilmente aperto".
//
// Ordine delle fonti:
//   1. segnalazioni personali ("Trovato chiuso", "Sicuro nei festivi")
//   2. Google Places (se l'utente ha una chiave e l'orario è stato richiesto)
//   3. OpenStreetMap opening_hours (interpretato con opening_hours.js, festivi PH inclusi)
//   4. euristica: self service o autostradale -> probabilmente aperto
//   5. nient'altro -> orario sconosciuto

import OpeningHours from 'opening_hours';
import { holidayOn, isSundayOrHoliday, italianDateKey } from './festivi.js';

export const STATUS = Object.freeze({
  OPEN: 'aperto',
  PROBABLE: 'probabile',
  UNKNOWN: 'sconosciuto',
  CLOSED: 'chiuso',
});
/** Ordine di preferenza (più basso = migliore). Un distributore chiuso non è mai una sosta. */
export const STATUS_RANK = Object.freeze({ aperto: 0, probabile: 1, sconosciuto: 2, chiuso: 9 });

export const REPORT = Object.freeze({ CLOSED: 'chiuso', SAFE_HOLIDAYS: 'sicuro-festivi' });

const OH_NOMINATIM = { lat: 42.5, lon: 12.5, address: { country_code: 'it', state: '' } };
const ohCache = new Map();

/** Interpreta una stringa opening_hours (con cache). Restituisce null se non valida. */
export function parseOpeningHours(value) {
  if (ohCache.has(value)) return ohCache.get(value);
  let oh = null;
  try {
    // mode 0: solo orari (niente "points in time"); tag_key per i warning
    oh = new OpeningHours(value, OH_NOMINATIM, { mode: 0, tag_key: 'opening_hours', locale: 'it' });
  } catch {
    oh = null;
  }
  ohCache.set(value, oh);
  return oh;
}

const hhmm = (d) =>
  new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit' }).format(d);

/** "lun 28/12" */
const dayLabel = (d) =>
  new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', weekday: 'short', day: '2-digit', month: '2-digit' })
    .format(d).replace(',', '');

function capStatus(result, max, note) {
  if (STATUS_RANK[result.status] < STATUS_RANK[max] && result.status !== STATUS.CLOSED) {
    return { ...result, status: max, notes: [...result.notes, note] };
  }
  return { ...result, notes: [...result.notes, note] };
}

/** Dice se una segnalazione personale si applica all'istante `when`. */
function reportApplies(report, when) {
  if (report.type === REPORT.SAFE_HOLIDAYS) return isSundayOrHoliday(when);
  // "Trovato chiuso" vale sempre: la data della segnalazione è quella in cui si preme il
  // pulsante, non necessariamente quella in cui lo si è trovato chiuso. Escludere un
  // distributore è la scelta prudente; la segnalazione si toglie con un tocco.
  if (report.type === REPORT.CLOSED) return true;
  return false;
}

/** Il distributore è self service secondo i dati? Restituisce la fonte o null. */
export function selfServiceSource(station) {
  const p = station.prices;
  if (p?.metano?.self || p?.lgnc?.self) return 'MIMIT (prezzo self comunicato)';
  if (station.osm?.automated === true) return 'OSM (automated=yes)';
  if (station.osm?.selfService === true) return 'OSM (self_service=yes)';
  return null;
}

/**
 * @param {object} station   distributore da metano.json
 * @param {Date} when        istante di arrivo previsto
 * @param {object} [ctx]
 * @param {Record<string, {type: string, date: string}>} [ctx.reports]  segnalazioni per id
 * @param {Map<string, {isOpenAt: (d: Date) => boolean|null, fetchedAt: string}>} [ctx.google]
 * @param {string} [ctx.osmTimestamp]  data dell'estratto OSM (sources.osm.timestamp)
 * @returns {{status: string, source: string|null, sourceLabel: string, updated: string|null,
 *            notes: string[], rule?: string, closesAt?: Date}}
 */
export function evaluateStation(station, when, ctx = {}) {
  let r = evaluateCore(station, when, ctx);
  if (station.src === 'osm') {
    r = capStatus(r, STATUS.PROBABLE, 'Non presente negli open data MIMIT: verifica che venda ancora metano.');
  }
  if (station.posDubbia) {
    r = capStatus(r, STATUS.UNKNOWN, 'Posizione dichiarata al MIMIT lontana dal comune: da verificare.');
  }
  return r;
}

function evaluateCore(station, when, ctx) {
  const notes = [];
  const holiday = holidayOn(when);
  if (holiday) notes.push(`Festivo: ${holiday.name}.`);

  // 1. Segnalazioni personali
  const rep = ctx.reports?.[station.id];
  if (rep && reportApplies(rep, when)) {
    const closed = rep.type === REPORT.CLOSED;
    return {
      status: closed ? STATUS.CLOSED : STATUS.OPEN,
      source: 'segnalazione',
      sourceLabel: closed ? 'Tua segnalazione: trovato chiuso' : 'Tua segnalazione: sicuro nei festivi',
      updated: rep.date ?? null,
      notes,
    };
  }

  // 2. Google Places
  const g = ctx.google?.get(station.id);
  if (g) {
    const open = g.isOpenAt(when);
    if (g.note) notes.push(`${g.note}.`);
    if (open === true || open === false) {
      return {
        status: open ? STATUS.OPEN : STATUS.CLOSED,
        source: 'google',
        sourceLabel: 'Google Maps (orari, inclusi quelli speciali)',
        updated: g.fetchedAt,
        notes,
      };
    }
  }

  // 3. OpenStreetMap
  const rule = station.osm?.oh;
  const osmUpdated = station.osm?.checkDate ?? (ctx.osmTimestamp ? ctx.osmTimestamp.slice(0, 10) : null);
  if (rule) {
    const oh = parseOpeningHours(rule);
    if (!oh) {
      notes.push(`Orario OSM non interpretabile: "${rule}".`);
    } else if (oh.getUnknown(when)) {
      notes.push(`Orario OSM incerto in questo momento: "${rule}".`);
    } else {
      const base = { source: 'osm', sourceLabel: 'OpenStreetMap', updated: osmUpdated, rule };
      if (!oh.getState(when)) {
        const next = oh.getNextChange(when, new Date(when.getTime() + 7 * 86_400_000));
        if (next) notes.push(`Riapre ${italianDateKey(next) === italianDateKey(when) ? '' : dayLabel(next) + ' '}alle ${hhmm(next)}.`);
        return { ...base, status: STATUS.CLOSED, notes };
      }
      const is247 = /^\s*24\/7\s*$/.test(rule);
      const next = oh.getNextChange(when, new Date(when.getTime() + 2 * 3_600_000));
      const result = { ...base, status: STATUS.OPEN, notes };
      if (next) {
        result.closesAt = next;
        notes.push(`Chiude alle ${hhmm(next)}.`);
      }
      if (station.osm.ohScope === 'impianto' && is247) {
        notes.push("24/7 riferito all'impianto, non specifico per il metano.");
      }
      // Festivo e regola senza indicazioni per i festivi: l'orario feriale non basta a dire "aperto".
      if (holiday && !is247 && !/\bPH\b/.test(rule)) {
        result.status = STATUS.PROBABLE;
        notes.push("L'orario OSM non indica nulla per i festivi.");
      }
      return result;
    }
  }

  // 4. Euristica
  const selfSrc = selfServiceSource(station);
  if (station.highway) {
    return {
      status: STATUS.PROBABLE, source: 'mimit', updated: null, notes,
      sourceLabel: 'Nessun orario: distributore autostradale (MIMIT)',
    };
  }
  if (selfSrc) {
    return {
      status: STATUS.PROBABLE, source: selfSrc.startsWith('MIMIT') ? 'mimit' : 'osm',
      updated: selfSrc.startsWith('MIMIT') ? latestPriceDate(station) : osmUpdated, notes,
      sourceLabel: `Nessun orario: self service secondo ${selfSrc}`,
    };
  }

  // 5. Nessun dato
  return { status: STATUS.UNKNOWN, source: null, sourceLabel: 'Orario sconosciuto', updated: null, notes };
}

function latestPriceDate(station) {
  let best = null;
  for (const kind of Object.values(station.prices ?? {})) {
    for (const v of Object.values(kind ?? {})) if (v?.d && (!best || v.d > best)) best = v.d;
  }
  return best ? best.slice(0, 10) : null;
}
