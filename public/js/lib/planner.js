// Algoritmo delle soste: sceglie dove rifornirsi di metano lungo il percorso.
//
// Regole:
//  - si fa sempre il pieno; nessuna tratta supera l'autonomia utile:
//      dopo un pieno:  autonomia × margine (default 350 × 0,75 ≈ 262 km)
//      alla partenza:  km residui − riserva (riserva = autonomia × (1 − margine)),
//                      ma almeno metà dei km residui se il serbatoio è basso
//    così si arriva a ogni sosta (e a destinazione) con almeno la riserva di sicurezza;
//  - ogni distributore è valutato all'orario di arrivo previsto; i chiusi sono esclusi;
//  - preferenze (ordine lessicografico): stato peggiore del piano, somma degli stati,
//    minuti persi (soste + deviazioni), prezzo;
//  - per ogni sosta si cerca un distributore di riserva;
//  - se non c'è un piano valido, si indica il punto critico.
//
// Modulo puro: lo stato di apertura arriva dalla funzione `evaluate` (vedi opening.js).

import { STATUS, STATUS_RANK } from './opening.js';

export const DEFAULTS = Object.freeze({
  rangeKm: 350,
  safety: 0.75,
  stopMinutes: 10,
  // Benzina di emergenza: usata solo se non esiste un piano a solo metano.
  allowPetrol: true,
  petrolKm: 100,         // autonomia a benzina disponibile
  petrolMarginKm: 10,    // benzina da non pianificare mai
  consumptionKgPer100: 4.0,
  maxLabelsPerNode: 4,
});

const NO_PRICE = 99;
/** In emergenza, km di benzina/margine entro cui si preferisce un distributore con stato migliore. */
const OVER_KM_BUCKET = 10;

/** Prezzo di riferimento (€/kg): self se disponibile, altrimenti servito. */
export function stationPrice(station) {
  const p = station?.prices;
  for (const kind of ['metano', 'lgnc']) {
    const v = p?.[kind]?.self?.p ?? p?.[kind]?.servito?.p;
    if (v) return v;
  }
  return null;
}

/** Limite della prima tratta in funzione dei km residui. */
export function firstLegLimit(startKm, rangeKm, safety) {
  const reserve = rangeKm * (1 - safety);
  return Math.max(startKm - reserve, startKm / 2);
}

function compareCost(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * @param {object} p
 * @param {Array} p.candidates  da findCorridorStations (ordinati per km); campi usati:
 *        station, km, detourKm, detourMin, driveSec, wrongSide?
 * @param {number} p.routeKm
 * @param {number} p.routeSec
 * @param {Date}   p.departure
 * @param {number} p.startKm    autonomia a metano residua alla partenza (km)
 * @param {(station, when: Date) => {status: string}} p.evaluate
 * @param {number} [p.rangeKm] @param {number} [p.safety] @param {number} [p.stopMinutes]
 * @param {boolean} [p.allowPetrol]  se il solo metano non basta, piano di emergenza con benzina
 * @param {number} [p.petrolKm]  autonomia a benzina @param {number} [p.petrolMarginKm]
 * @param {number} [p.consumptionKgPer100]
 * @param {number} [p.fallbackPrice]  €/kg medio, per il costo stimato se mancano prezzi
 */
export function planStops(p) {
  const o = { ...DEFAULTS, ...p };
  const fullLimit = o.rangeKm * o.safety;
  const reserve = o.rangeKm * (1 - o.safety);
  const startLimit = firstLegLimit(o.startKm, o.rangeKm, o.safety);
  const warnings = [];
  if (o.startKm - reserve < o.startKm / 2) {
    warnings.push(`Serbatoio basso: la prima tratta è limitata a ${Math.round(startLimit)} km (metà dell'autonomia residua).`);
  }

  // Nodi: partenza, distributori utilizzabili, arrivo.
  const cands = o.candidates.filter((c) => !c.wrongSide);
  const nodes = [
    { kind: 'start', km: 0, half: 0, halfMin: 0, driveSec: 0 },
    ...cands.map((c) => ({
      kind: 'station', cand: c, km: c.km, half: c.detourKm / 2, halfMin: c.detourMin / 2,
      driveSec: c.driveSec, price: stationPrice(c.station),
    })),
    { kind: 'end', km: o.routeKm, half: 0, halfMin: 0, driveSec: o.routeSec },
  ];
  const N = nodes.length;
  const legKm = (i, j) => nodes[j].km - nodes[i].km + nodes[i].half + nodes[j].half;
  const legSec = (i, j) => nodes[j].driveSec - nodes[i].driveSec + (nodes[i].halfMin + nodes[j].halfMin) * 60;
  const limitFrom = (i) => (i === 0 ? startLimit : fullLimit);
  const at = (sec) => new Date(o.departure.getTime() + sec * 1000);

  const evalCache = new Map();
  const evaluate = (node, sec) => {
    const key = `${node.cand.station.id}@${Math.round(sec / 60)}`;
    if (!evalCache.has(key)) evalCache.set(key, o.evaluate(node.cand.station, at(sec)));
    return evalCache.get(key);
  };

  const methaneAt = (i) => (i === 0 ? o.startKm : o.rangeKm); // metano alla partenza dal nodo i
  const petrolUsable = (left) => Math.max(0, left - o.petrolMarginKm);

  /**
   * Consumo di una tratta i -> j partendo con `petrolLeft` km di benzina.
   * Solo metano: la tratta deve stare entro il limite con margine.
   * Con benzina (emergenza): si consuma tutto il metano, poi la benzina, tenendone da
   * parte petrolMarginKm. `overKm` = km oltre il limite di sicurezza del metano.
   * @returns {{petrol: number, overKm: number} | null}
   */
  const legUse = (i, leg, petrolLeft, allowPetrol) => {
    const limit = limitFrom(i);
    if (leg <= limit) return { petrol: 0, overKm: 0 };
    if (!allowPetrol) return null;
    const petrol = Math.max(0, leg - methaneAt(i));
    if (petrol > petrolUsable(petrolLeft)) return null;
    return { petrol, overKm: leg - limit };
  };

  /**
   * Programmazione dinamica sui nodi in ordine di km.
   * Etichette per nodo: {cost, depSec, arrSec, prev, prevLabel, status, petrolLeft, legPetrol, overKm}
   * cost = [scaglione km fuori margine, stato peggiore, somma stati, km fuori margine, minuti persi, prezzo]
   * In emergenza conta prima di tutto usare meno benzina (e meno margine): lo stato decide
   * solo tra piani entro lo stesso scaglione di OVER_KM_BUCKET km. Solo metano: tutti zero.
   * Si tengono fino a maxLabelsPerNode etichette non dominate (costo e orario).
   */
  const solve = (allowPetrol) => {
    const labels = Array.from({ length: N }, () => []);
    labels[0].push({ cost: [0, 0, 0, 0, 0, 0], depSec: 0, arrSec: 0, prev: null, status: null, petrolLeft: o.petrolKm, legPetrol: 0, overKm: 0 });
    const closedSeen = new Map(); // nodo -> {arrSec, ev} per spiegare il punto critico
    const maxSpan = allowPetrol ? o.rangeKm + o.petrolKm : fullLimit;

    for (let j = 1; j < N; j++) {
      const nj = nodes[j];
      for (let i = j - 1; i >= 0; i--) {
        if (labels[i].length === 0) continue;
        if (nodes[j].km - nodes[i].km > maxSpan + 1) break; // i precedenti sono ancora più lontani
        const leg = legKm(i, j);
        for (const L of labels[i]) {
          const use = legUse(i, leg, L.petrolLeft, allowPetrol);
          if (!use) continue;
          const arrSec = L.depSec + legSec(i, j);
          let ev = null;
          const overKm = L.overKm + use.overKm;
          let cost = [Math.ceil(overKm / OVER_KM_BUCKET - 1e-9), L.cost[1], L.cost[2], overKm, L.cost[4], L.cost[5]];
          if (nj.kind === 'station') {
            ev = evaluate(nj, arrSec);
            if (ev.status === STATUS.CLOSED) {
              closedSeen.set(j, { arrSec, ev });
              continue;
            }
            const r = STATUS_RANK[ev.status];
            cost = [
              cost[0],
              Math.max(cost[1], r),
              cost[2] + r,
              cost[3],
              cost[4] + o.stopMinutes + nj.cand.detourMin,
              cost[5] + (nj.price ?? NO_PRICE),
            ];
          }
          insertLabel(labels[j], {
            cost, arrSec, prev: i, prevLabel: L, status: ev,
            depSec: arrSec + (nj.kind === 'station' ? o.stopMinutes * 60 : 0),
            petrolLeft: L.petrolLeft - use.petrol,
            legPetrol: use.petrol,
            overKm,
          }, o.maxLabelsPerNode);
        }
      }
    }
    return { labels, closedSeen };
  };

  // 1. Piano solo a metano (con margine). 2. Se impossibile, piano di emergenza con benzina.
  const methaneRun = solve(false);
  let run = methaneRun;
  let usesPetrol = false;
  const critical = () => findCritical({ nodes, labels: methaneRun.labels, closedSeen: methaneRun.closedSeen, legKm, limitFrom, at, o });
  if (!run.labels[N - 1].length && o.allowPetrol && o.petrolKm > o.petrolMarginKm) {
    const petrolRun = solve(true);
    if (petrolRun.labels[N - 1].length) {
      run = petrolRun;
      usesPetrol = true;
    }
  }
  const endLabels = run.labels[N - 1];
  if (endLabels.length === 0) {
    return { ok: false, warnings, critical: { ...critical(), petrolTried: !!o.allowPetrol, petrolKm: o.petrolKm } };
  }

  // Ricostruzione del piano migliore
  const best = endLabels.reduce((a, b) => (compareCost(b.cost, a.cost) < 0 ? b : a));
  const path = [];
  for (let L = best, j = N - 1; L; j = L.prev, L = L.prevLabel) path.push({ j, L });
  path.reverse(); // [start, ..., end]

  const usedSet = new Set(path.map((x) => x.j));
  const stops = [];
  for (let k = 1; k < path.length - 1; k++) {
    const { j, L } = path[k];
    const prevJ = path[k - 1].j;
    const nextJ = path[k + 1].j;
    const node = nodes[j];
    const leg = legKm(prevJ, j);
    const fuelAtArrival = Math.max(0, methaneAt(prevJ) - leg);
    const prevPetrol = path[k - 1].L.petrolLeft;
    stops.push({
      candidate: node.cand,
      station: node.cand.station,
      km: node.km,
      legKm: leg,
      legPetrolKm: L.legPetrol,
      eta: at(L.arrSec),
      departure: at(L.depSec),
      evaluation: L.status,
      price: node.price,
      fuelAtArrivalKm: fuelAtArrival,
      petrolLeftKm: L.petrolLeft,
      backup: findBackup({
        nodes, j, prevJ, nextJ, arrSec: L.arrSec, fuelAtArrival, fullLimit,
        reserve, usedSet, evaluate, legKm, legSec, o,
        petrolAtArrival: usesPetrol ? petrolUsable(L.petrolLeft) : 0,
        prevCapacity: usesPetrol ? Math.max(limitFrom(prevJ), methaneAt(prevJ) + petrolUsable(prevPetrol)) : limitFrom(prevJ),
      }),
    });
  }

  const last = path[path.length - 1].L;
  const lastStopJ = path[path.length - 2].j;
  const totalKm = o.routeKm + stops.reduce((s, x) => s + x.candidate.detourKm, 0);
  const petrolKm = o.petrolKm - last.petrolLeft;
  const methaneKm = totalKm - petrolKm;
  const prices = stops.map((s) => s.price).filter((x) => x);
  const avgPrice = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : o.fallbackPrice ?? null;
  const kg = (methaneKm * o.consumptionKgPer100) / 100;

  return {
    ok: true,
    // piano di emergenza: oltre il margine di sicurezza del metano, eventualmente con benzina
    emergency: usesPetrol,
    usesPetrol: petrolKm > 0.05,
    // perché il solo metano con margine non basta (punto critico del piano normale)
    methaneCritical: usesPetrol ? critical() : null,
    warnings,
    stops,
    arrival: {
      eta: at(last.arrSec),
      legPetrolKm: last.legPetrol,
      fuelKm: Math.max(0, methaneAt(lastStopJ) - legKm(lastStopJ, N - 1)),
      petrolLeftKm: last.petrolLeft,
    },
    summary: {
      totalKm,
      totalSec: last.arrSec,
      stops: stops.length,
      worstStatus: stops.length ? stops.map((s) => s.evaluation.status).sort((a, b) => STATUS_RANK[b] - STATUS_RANK[a])[0] : null,
      petrolKm,
      fuelKg: kg,
      avgPrice,
      costEuro: avgPrice ? kg * avgPrice : null,
    },
  };
}

function insertLabel(list, label, max) {
  // scarta se dominata (costo ≥ e partenza non prima)
  for (const x of list) {
    if (compareCost(x.cost, label.cost) <= 0 && x.depSec <= label.depSec) return;
  }
  for (let k = list.length - 1; k >= 0; k--) {
    if (compareCost(label.cost, list[k].cost) <= 0 && label.depSec <= list[k].depSec) list.splice(k, 1);
  }
  list.push(label);
  list.sort((a, b) => compareCost(a.cost, b.cost) || a.depSec - b.depSec);
  if (list.length > max) list.length = max;
}

/**
 * Distributore di riserva per la sosta j: deve essere raggiungibile dalla sosta principale
 * (se la si trova chiusa) con il metano rimasto, e da lì si deve poter raggiungere la
 * tappa successiva con un pieno. Se nessuno soddisfa entrambe le condizioni, si accetta
 * uno raggiungibile dalla tappa precedente, segnalando che dopo va ricalcolato il piano.
 */
function findBackup({ nodes, j, nextJ, arrSec, fuelAtArrival, fullLimit, reserve, prevJ, prevCapacity, petrolAtArrival = 0, usedSet, evaluate, legKm, legSec, o }) {
  const main = nodes[j];
  const options = [];
  for (let b = 1; b < nodes.length - 1; b++) {
    if (usedSet.has(b)) continue;
    const nb = nodes[b];
    const fromMain = Math.abs(nb.km - main.km) + main.half + nb.half;
    const toNext = b < nextJ ? legKm(b, nextJ) : Infinity;
    const fromPrev = b > prevJ ? legKm(prevJ, b) : Infinity;
    const reachableFromMain = fromMain <= fuelAtArrival + petrolAtArrival;
    const continues = toNext <= fullLimit;
    let mode;
    if (reachableFromMain && continues) mode = 'pieno';
    else if (fromPrev <= prevCapacity) mode = 'ricalcola';
    else continue;
    const sec = mode === 'pieno'
      ? arrSec + Math.abs(nb.driveSec - main.driveSec) + (main.halfMin + nb.halfMin) * 60
      : arrSec - legSec(prevJ, j) + legSec(prevJ, b);
    const ev = evaluate(nb, sec);
    if (ev.status === STATUS.CLOSED) continue;
    options.push({
      key: [mode === 'pieno' ? 0 : 1, STATUS_RANK[ev.status], fromMain, nb.price ?? NO_PRICE],
      backup: {
        candidate: nb.cand, station: nb.cand.station, km: nb.km, eta: new Date(o.departure.getTime() + sec * 1000),
        evaluation: ev, price: nb.price, distFromMainKm: fromMain, mode,
        usesReserve: mode === 'pieno' && fromMain > fuelAtArrival - reserve,
        usesPetrol: mode === 'pieno' && fromMain > fuelAtArrival,
      },
    });
  }
  if (!options.length) return null;
  options.sort((a, b) => compareCost(a.key, b.key));
  return options[0].backup;
}

/** Spiega perché non esiste un piano: il punto più lontano raggiungibile e cosa manca dopo. */
function findCritical({ nodes, labels, closedSeen, legKm, limitFrom, at, o }) {
  // nodo raggiungibile più avanti (partenza inclusa)
  let from = 0;
  for (let j = 0; j < nodes.length - 1; j++) if (labels[j].length && nodes[j].km >= nodes[from].km) from = j;
  const nf = nodes[from];
  const limit = limitFrom(from);
  const fuel = from === 0 ? o.startKm : o.rangeKm;
  const reachKm = nf.km + limit - nf.half;

  // distributori nel raggio ma chiusi al passaggio
  const closed = [];
  for (const [j, { arrSec, ev }] of closedSeen) {
    if (nodes[j].km > nf.km && legKm(from, j) <= limit) {
      closed.push({ station: nodes[j].cand.station, km: nodes[j].km, eta: at(arrSec), evaluation: ev });
    }
  }
  closed.sort((a, b) => a.km - b.km);

  // prossimo nodo utilizzabile oltre il raggio (distributore non già chiuso, o l'arrivo)
  let next = null;
  for (let j = from + 1; j < nodes.length; j++) {
    if (legKm(from, j) <= limit) continue;
    if (closedSeen.has(j)) continue;
    next = j;
    break;
  }
  const nn = next !== null ? nodes[next] : nodes[nodes.length - 1];
  const nextIdx = next ?? nodes.length - 1;
  const gapKm = legKm(from, nextIdx);
  return {
    fromKm: nf.km,
    from: nf.kind === 'start' ? null : nf.cand.station,
    maxLegKm: limit,
    reachKm,
    next: nn.kind === 'end' ? null : nn.cand.station,
    nextKm: nn.km,
    nextIsDestination: nn.kind === 'end',
    gapKm,
    closedInRange: closed,
    // con il metano fino all'ultimo km (senza margine) o anche con la benzina?
    reachableWithMethaneReserve: gapKm <= fuel,
    reachableWithPetrol: gapKm <= fuel + Math.max(0, o.petrolKm - o.petrolMarginKm),
  };
}
