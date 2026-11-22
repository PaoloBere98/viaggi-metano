// Google Places API (New) — OPZIONALE, con la chiave dell'utente (resta sul dispositivo).
//
// Solo per i distributori scelti dal pianificatore (soste e riserve), mai per tutti:
//  1. Text Search "IDs only" (solo places.id, nella zona del distributore) -> place ID.
//     Il place ID si può conservare senza limiti (termini Google): lo teniamo in localStorage.
//  2. Place Details con gli orari (regularOpeningHours + currentOpeningHours, che include
//     gli orari speciali/festivi dei prossimi 7 giorni). Questi dati NON vengono salvati:
//     restano in memoria finché l'app è aperta (niente database permanente di dati Google).

const BASE = 'https://places.googleapis.com/v1';
const SEARCH_BOX_DEG = 0.003; // ~300 m intorno al distributore
const MAX_MATCH_M = 400;

export class GoogleError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function explain(status, body) {
  const msg = body?.error?.message ?? '';
  if (status === 400 && /API key/i.test(msg)) return 'Chiave Google non valida.';
  if (status === 403) return `Chiave Google non autorizzata (${msg || 'controlla restrizioni e Places API (New) attiva'}).`;
  if (status === 429) return 'Quota Google esaurita: per ora uso solo gli orari OpenStreetMap.';
  return `Errore Google Places (${status})${msg ? ': ' + msg : ''}`;
}

export class GooglePlacesClient {
  constructor(apiKey, fetchImpl = globalThis.fetch.bind(globalThis)) {
    if (!apiKey) throw new GoogleError('Manca la chiave Google.', 0);
    this.key = apiKey;
    this.fetch = fetchImpl;
  }

  async #post(path, body, fieldMask) {
    return this.#call(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': this.key, 'X-Goog-FieldMask': fieldMask },
      body: JSON.stringify(body),
    });
  }

  async #call(url, init) {
    let res;
    try {
      res = await this.fetch(url, init);
    } catch {
      throw new GoogleError('Google Places non raggiungibile.', 0);
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new GoogleError(explain(res.status, body), res.status);
    return body;
  }

  /** Place ID del distributore (ricerca solo nella sua zona, solo distributori di carburante). */
  async findPlaceId(station) {
    const text = [station.brand && !/pompe bianche/i.test(station.brand) ? station.brand : station.name, station.address, station.city]
      .filter(Boolean).join(' ');
    const body = await this.#post('/places:searchText', {
      textQuery: text || 'distributore metano',
      includedType: 'gas_station',
      strictTypeFiltering: true,
      languageCode: 'it',
      regionCode: 'IT',
      maxResultCount: 1,
      locationRestriction: {
        rectangle: {
          low: { latitude: station.lat - SEARCH_BOX_DEG, longitude: station.lon - SEARCH_BOX_DEG },
          high: { latitude: station.lat + SEARCH_BOX_DEG, longitude: station.lon + SEARCH_BOX_DEG },
        },
      },
    }, 'places.id');
    return body?.places?.[0]?.id ?? null;
  }

  /** Dettagli con gli orari (non da salvare in modo permanente). */
  async details(placeId) {
    const fields = 'id,displayName,location,businessStatus,regularOpeningHours,currentOpeningHours,googleMapsUri';
    return this.#call(`${BASE}/places/${encodeURIComponent(placeId)}?languageCode=it`, {
      headers: { 'X-Goog-Api-Key': this.key, 'X-Goog-FieldMask': fields },
    });
  }
}

// ---------------------------------------------------------------- orari

const WEEK = 7 * 1440;

/** Parti dell'ora italiana di un istante: data, giorno della settimana, minuti dalla mezzanotte. */
export function romeParts(date) {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
  });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  const y = Number(p.year), m = Number(p.month), d = Number(p.day);
  return {
    y, m, d,
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday),
    minutes: Number(p.hour) * 60 + Number(p.minute),
    dayNum: Date.UTC(y, m - 1, d) / 86_400_000, // giorno di calendario come numero
  };
}

const isAlwaysOpen = (hours) =>
  hours?.periods?.length === 1 && !hours.periods[0].close && (hours.periods[0].open?.hour ?? 0) === 0;

/** Orario settimanale: aperto al giorno/minuto indicato? */
function weeklyOpen(hours, weekday, minutes) {
  if (isAlwaysOpen(hours)) return true;
  const t = weekday * 1440 + minutes;
  for (const p of hours.periods ?? []) {
    if (!p.open) continue;
    const o = p.open.day * 1440 + (p.open.hour ?? 0) * 60 + (p.open.minute ?? 0);
    if (!p.close) return true;
    let c = p.close.day * 1440 + (p.close.hour ?? 0) * 60 + (p.close.minute ?? 0);
    if (c <= o) c += WEEK;
    if ((t >= o && t < c) || (t + WEEK >= o && t + WEEK < c)) return true;
  }
  return false;
}

/** Orario "corrente" (prossimi 7 giorni, con date ed eccezioni): aperto all'istante? */
function currentOpen(hours, target) {
  if (isAlwaysOpen(hours)) return true;
  const t = target.dayNum * 1440 + target.minutes;
  for (const p of hours.periods ?? []) {
    if (!p.open?.date) return null; // formato inatteso: non decidere
    const dn = (d) => Date.UTC(d.year, d.month - 1, d.day) / 86_400_000;
    const o = dn(p.open.date) * 1440 + (p.open.hour ?? 0) * 60 + (p.open.minute ?? 0);
    const c = p.close?.date ? dn(p.close.date) * 1440 + (p.close.hour ?? 0) * 60 + (p.close.minute ?? 0) : Infinity;
    if (t >= o && t < c) return true;
  }
  return false;
}

/**
 * Trasforma i dettagli Google in un oggetto per evaluateStation:
 * { isOpenAt(date) -> true | false | null, fetchedAt, note }
 * null = Google non permette di decidere (si passa a OSM/euristica).
 * @param {object} place     risposta di Place Details
 * @param {Date} fetchedAt
 * @param {(date: Date) => boolean} isHoliday  festività nazionale nel giorno dell'istante
 * @param {{lat, lon}} [station]  per scartare un luogo troppo lontano
 */
export function hoursFromPlace(place, fetchedAt, isHoliday, station) {
  const name = place?.displayName?.text ?? 'luogo Google';
  const fetchedDay = romeParts(fetchedAt).dayNum;
  const note = `Google: "${name}"`;
  const unknown = { isOpenAt: () => null, fetchedAt: fetchedAt.toISOString().slice(0, 10), note };
  if (station && place?.location) {
    const dLat = (place.location.latitude - station.lat) * 111_000;
    const dLon = (place.location.longitude - station.lon) * 111_000 * Math.cos((station.lat * Math.PI) / 180);
    if (Math.hypot(dLat, dLon) > MAX_MATCH_M) return { ...unknown, note: `${note} troppo lontano: ignorato` };
  }
  if (place?.businessStatus === 'CLOSED_PERMANENTLY' || place?.businessStatus === 'CLOSED_TEMPORARILY') {
    return {
      isOpenAt: () => false,
      fetchedAt: unknown.fetchedAt,
      note: `${note}: ${place.businessStatus === 'CLOSED_PERMANENTLY' ? 'chiuso definitivamente' : 'chiuso temporaneamente'}`,
    };
  }
  const cur = place?.currentOpeningHours;
  const reg = place?.regularOpeningHours;
  if (!cur?.periods && !reg?.periods) return unknown;
  return {
    fetchedAt: unknown.fetchedAt,
    note,
    isOpenAt(date) {
      const t = romeParts(date);
      // entro 7 giorni dalla richiesta: orario corrente, che include i giorni speciali
      if (cur?.periods && t.dayNum >= fetchedDay && t.dayNum < fetchedDay + 7) {
        const r = currentOpen(cur, t);
        if (r !== null) return r;
      }
      if (!reg?.periods) return null;
      // oltre i 7 giorni Google non dice nulla sui festivi: in un festivo non decidiamo
      if (isHoliday(date) && !isAlwaysOpen(reg)) return null;
      return weeklyOpen(reg, t.weekday, t.minutes);
    },
  };
}
