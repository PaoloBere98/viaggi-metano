// Orchestratore: corridoio -> piano -> verifica delle deviazioni reali delle soste scelte
// (e delle riserve) con il servizio di routing -> nuovo piano, finché il piano non cambia.
// Così si scartano le aree di servizio sulla carreggiata opposta e si correggono le stime.

import { findCorridorStations } from './corridor.js';
import { planStops } from './planner.js';

/** Oltre questa deviazione reale un distributore autostradale "sul" percorso è sulla carreggiata opposta. */
export const WRONG_SIDE_KM = 5;

function needsMeasure(c) {
  return !c.measured && !c.measureFailed && (c.sideUnknown || c.distKm > 0.3);
}

/**
 * @param {object} p
 * @param {object} p.route        da OrsClient.route / prepareRoute
 * @param {Array}  p.stations     distributori (metano.json)
 * @param {Date}   p.departure
 * @param {number} p.startKm
 * @param {object} p.settings     {rangeKm, safety, maxDistKm, stopMinutes, consumptionKgPer100, allowPetrol, petrolKm}
 * @param {(station, when) => object} p.evaluate
 * @param {{measureDetour: Function}} [p.ors]  se assente, si usano solo le stime
 * @param {number} [p.fallbackPrice]
 * @param {(msg: string) => void} [p.onProgress]
 * @param {number} [p.maxRounds]
 */
export async function planTrip(p) {
  const { route, settings = {}, onProgress = () => {}, maxRounds = 4 } = p;
  const candidates = findCorridorStations(route, p.stations, { maxDistKm: settings.maxDistKm ?? 5 });
  const notes = [];
  let measuredCount = 0;
  let plan;

  for (let round = 0; round < maxRounds; round++) {
    plan = planStops({
      ...settings,
      candidates,
      routeKm: route.distance / 1000,
      routeSec: route.duration,
      departure: p.departure,
      startKm: p.startKm,
      evaluate: p.evaluate,
      fallbackPrice: p.fallbackPrice,
    });
    if (!plan.ok || !p.ors) break;

    const toMeasure = [];
    for (const s of plan.stops) {
      if (needsMeasure(s.candidate)) toMeasure.push(s.candidate);
      if (s.backup && needsMeasure(s.backup.candidate)) toMeasure.push(s.backup.candidate);
    }
    if (!toMeasure.length) break;

    onProgress(`Verifico la deviazione reale di ${toMeasure.length} distributori…`);
    for (const c of toMeasure) {
      try {
        const d = await p.ors.measureDetour(route, c);
        c.estimatedDetourKm = c.detourKm;
        c.detourKm = d.detourKm;
        c.detourMin = d.detourMin;
        c.measured = true;
        measuredCount++;
        if (c.station.highway && c.sideUnknown && d.detourKm > WRONG_SIDE_KM) c.wrongSide = true;
      } catch (e) {
        c.measureFailed = true;
        notes.push(`Deviazione di ${c.station.name} non verificata (${e.message}): uso la stima.`);
        if (e.status === 429 || e.status === 401 || e.status === 403) {
          // quota o chiave: inutile insistere con gli altri
          for (const x of toMeasure) if (!x.measured) x.measureFailed = true;
          break;
        }
      }
    }
  }

  return { plan, candidates, measuredCount, notes };
}
