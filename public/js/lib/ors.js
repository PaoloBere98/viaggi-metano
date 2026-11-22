// Client OpenRouteService (chiave gratuita dell'utente, conservata solo sul dispositivo).
// Limiti del piano gratuito: 2.000 percorsi/giorno (40/min), 1.000 ricerche indirizzo/giorno (100/min).

import { prepareRoute, pointAtKm } from './corridor.js';

const BASE = 'https://api.openrouteservice.org';

export class OrsError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function explain(status, body) {
  const detail = body?.error?.message ?? body?.error ?? '';
  if (status === 401 || status === 403) return 'Chiave OpenRouteService non valida o non autorizzata. Controllala nelle impostazioni.';
  if (status === 429) return 'Quota OpenRouteService esaurita (limite al minuto o giornaliero). Riprova più tardi.';
  if (status === 404) return 'Percorso non trovato: verifica che partenza e arrivo siano raggiungibili in auto.';
  if (status >= 500) return 'OpenRouteService non risponde in questo momento. Riprova tra poco.';
  return `Errore OpenRouteService (${status})${detail ? ': ' + detail : ''}`;
}

/**
 * Ripulisce una chiave incollata: toglie spazi, a capo e caratteri invisibili
 * (es. spazi a larghezza zero copiati da chat o note), che renderebbero la chiave errata
 * o farebbero fallire la richiesta. Le chiavi ORS contengono solo caratteri ASCII stampabili.
 */
export function cleanKey(key) {
  return String(key ?? '').replace(/[^\x21-\x7E]/g, '');
}

export class OrsClient {
  /** @param {string} apiKey  @param {typeof fetch} [fetchImpl] */
  constructor(apiKey, fetchImpl = globalThis.fetch.bind(globalThis)) {
    const key = cleanKey(apiKey);
    if (!key) throw new OrsError('Manca la chiave OpenRouteService: inseriscila nelle impostazioni.', 0);
    this.key = key;
    this.fetch = fetchImpl;
  }

  async #request(url, init = {}) {
    let res;
    try {
      res = await this.fetch(url, init);
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      if (globalThis.navigator?.onLine === false) {
        throw new OrsError('Sei offline: serve una connessione per calcolare il percorso.', 0);
      }
      // Con una chiave errata OpenRouteService risponde 403 senza le intestazioni CORS:
      // il browser vede solo un errore di rete generico, indistinguibile da un problema di linea.
      throw new OrsError(
        'OpenRouteService non risponde o ha rifiutato la richiesta. Quasi sempre è la chiave: ' +
        'ricopiala intera nelle impostazioni e premi "Verifica chiave".', 0,
      );
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new OrsError(explain(res.status, body), res.status);
    return body;
  }

  /**
   * Suggerimenti di indirizzo (solo Italia).
   * @returns {Promise<Array<{label: string, lat: number, lon: number}>>}
   */
  async autocomplete(text, { signal, focus } = {}) {
    const q = new URLSearchParams({
      api_key: this.key,
      text,
      'boundary.country': 'IT',
      size: '6',
      lang: 'it',
      // niente province/regioni: come partenza o arrivo servono luoghi precisi
      layers: 'venue,address,street,neighbourhood,locality,localadmin',
    });
    if (focus) {
      q.set('focus.point.lat', String(focus.lat));
      q.set('focus.point.lon', String(focus.lon));
    }
    const body = await this.#request(`${BASE}/geocode/autocomplete?${q}`, { signal });
    return (body.features ?? []).map((f) => ({
      label: f.properties.label,
      lon: f.geometry.coordinates[0],
      lat: f.geometry.coordinates[1],
    }));
  }

  /** Percorso in auto tra più punti {lat, lon}. Restituisce la risposta GeoJSON grezza. */
  async directions(points, { signal, instructions = true } = {}) {
    return this.#request(`${BASE}/v2/directions/driving-car/geojson`, {
      method: 'POST',
      signal,
      headers: { Authorization: this.key, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        coordinates: points.map((p) => [p.lon, p.lat]),
        instructions,
        language: 'it',
        units: 'm',
        // tratti a pedaggio ≈ autostrade: servono a stimare il costo di uscire per rifornirsi
        ...(instructions ? { extra_info: ['tollways'] } : {}),
      }),
    });
  }

  /** Percorso pronto per il corridoio (vedi prepareRoute). */
  async route(from, to, opts) {
    return routeFromGeoJson(await this.directions([from, to], opts));
  }

  /**
   * Deviazione reale per raggiungere un distributore: confronta il tratto del percorso
   * da `windowKm` prima a `windowKm` dopo il distributore con lo stesso tratto passando
   * dal distributore. Serve anche a scoprire i distributori autostradali sulla
   * carreggiata opposta (la deviazione risulta enorme).
   * @returns {Promise<{detourKm: number, detourMin: number}>}
   */
  async measureDetour(route, cand, { windowKm = 5, signal } = {}) {
    const startKm = Math.max(0, cand.km - windowKm);
    const endKm = Math.min(route.distance / 1000, cand.km + windowKm);
    const a = pointAtKm(route, startKm);
    const b = pointAtKm(route, endKm);
    const body = await this.directions([a, { lat: cand.station.lat, lon: cand.station.lon }, b], {
      signal,
      instructions: false,
    });
    const sum = body.features[0].properties.summary;
    const directKm = endKm - startKm;
    const directSec = timeBetween(route, startKm, endKm);
    return {
      detourKm: Math.max(0, sum.distance / 1000 - directKm),
      detourMin: Math.max(0, (sum.duration - directSec) / 60),
    };
  }
}

function timeBetween(route, km0, km1) {
  const at = (km) => {
    const target = km * 1000;
    const { cumDist, cumTime } = route;
    let i = 0;
    while (i < cumDist.length - 1 && cumDist[i + 1] < target) i++;
    const span = cumDist[i + 1] - cumDist[i] || 1;
    return cumTime[i] + ((target - cumDist[i]) / span) * (cumTime[i + 1] - cumTime[i]);
  };
  return at(km1) - at(km0);
}

/** Converte la risposta GeoJSON di ORS nel formato del corridoio. Esportata per i test. */
export function routeFromGeoJson(geo) {
  const f = geo?.features?.[0];
  if (!f) throw new OrsError('Risposta di OpenRouteService senza percorso.', 0);
  const props = f.properties ?? {};
  const steps = [];
  for (const seg of props.segments ?? []) {
    for (const st of seg.steps ?? []) {
      const [from, to] = st.way_points;
      if (to > from) steps.push({ from, to, duration: st.duration });
    }
  }
  const coords = f.geometry.coordinates;
  // extras.tollways.values: [[indicePunto0, indicePunto1, 0|1], ...]
  let toll = null;
  const tollValues = props.extras?.tollways?.values;
  if (tollValues?.length) {
    toll = new Uint8Array(Math.max(0, coords.length - 1));
    for (const [from, to, v] of tollValues) {
      if (v === 1) toll.fill(1, from, to);
    }
  }
  const route = prepareRoute(coords, {
    distance: props.summary?.distance,
    duration: props.summary?.duration,
    steps,
    toll,
  });
  route.geojson = f.geometry;
  return route;
}
