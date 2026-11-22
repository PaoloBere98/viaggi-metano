// Gli orari si valutano in ora italiana, anche su GitHub Actions (UTC).
process.env.TZ = 'Europe/Rome';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { easterSunday, nationalHolidays, holidayOn, isSundayOrHoliday } from '../public/js/lib/festivi.js';
import { evaluateStation, STATUS, REPORT } from '../public/js/lib/opening.js';
import { planStops, firstLegLimit, stationPrice } from '../public/js/lib/planner.js';
import { planTrip, WRONG_SIDE_KM } from '../public/js/lib/trip.js';
import { prepareRoute } from '../public/js/lib/corridor.js';

// ---------- aiuti ----------

/** Distributore sintetico. */
function st(id, { oh, highway = false, self = false, price = 2.0, src = 'mimit+osm', posDubbia } = {}) {
  return {
    id, name: id, src, highway, ...(posDubbia ? { posDubbia } : {}),
    prices: { metano: self ? { self: { p: price, d: '2026-11-20T08:00:00' } } : { servito: { p: price, d: '2026-11-20T08:00:00' } } },
    osm: oh ? { id: `node/${id}`, oh, ohScope: 'cng' } : null,
  };
}
/** Candidato sul percorso al km indicato, 100 km/h, deviazione minima. */
function cand(station, km, { detourKm = 0.2, detourMin = 0.5 } = {}) {
  return { station, km, distKm: detourKm / 2.8, detourKm, detourMin, driveSec: (km / 100) * 3600, sideUnknown: false };
}
function plan(opts) {
  return planStops({
    rangeKm: 350, safety: 0.75, startKm: 350, stopMinutes: 10,
    evaluate: (s, when) => evaluateStation(s, when, opts.ctx ?? {}),
    routeSec: (opts.routeKm / 100) * 3600,
    ...opts,
  });
}
const ids = (r) => r.stops.map((s) => s.station.id);
const H24 = '24/7';

// ---------- festivi ----------

test('festivi: Pasqua calcolata, Pasquetta, 4 ottobre dal 2026', () => {
  assert.deepEqual(easterSunday(2024), { month: 3, day: 31 });
  assert.deepEqual(easterSunday(2025), { month: 4, day: 20 });
  assert.deepEqual(easterSunday(2026), { month: 4, day: 5 });
  assert.deepEqual(easterSunday(2027), { month: 3, day: 28 });
  assert.deepEqual(easterSunday(2038), { month: 4, day: 25 });
  const y27 = nationalHolidays(2027);
  assert.equal(y27.length, 13);
  assert.ok(y27.some((h) => h.date === '2027-03-29' && /Pasquetta/.test(h.name)));
  assert.equal(holidayOn(new Date('2026-10-04T10:00:00'))?.name, "San Francesco d'Assisi");
  assert.equal(holidayOn(new Date('2025-10-04T10:00:00')), null);
  assert.equal(holidayOn(new Date('2026-06-02T23:30:00'))?.name, 'Festa della Repubblica');
  assert.equal(holidayOn(new Date('2026-06-03T00:30:00')), null);
  assert.ok(isSundayOrHoliday(new Date('2026-11-22T10:00:00')));  // domenica
  assert.ok(!isSundayOrHoliday(new Date('2026-11-23T10:00:00'))); // lunedì
});

// ---------- valutazione orari ----------

test('stato: aperto, chiuso, festivo senza PH, nessun orario, self, autostradale', () => {
  const nat = new Date('2026-12-25T10:00:00');
  const lun = new Date('2026-12-28T10:00:00');
  assert.equal(evaluateStation(st('a', { oh: 'Mo-Sa 07:00-20:00; PH off' }), nat).status, STATUS.CLOSED);
  assert.equal(evaluateStation(st('a', { oh: 'Mo-Sa 07:00-20:00; PH off' }), lun).status, STATUS.OPEN);
  const noPh = evaluateStation(st('b', { oh: 'Mo-Su 07:00-20:00' }), nat);
  assert.equal(noPh.status, STATUS.PROBABLE);
  assert.match(noPh.notes.join(' '), /festivi/);
  assert.equal(evaluateStation(st('c', { oh: 'Mo-Su,PH 06:00-22:00' }), nat).status, STATUS.OPEN);
  assert.equal(evaluateStation(st('d'), lun).status, STATUS.UNKNOWN);
  assert.equal(evaluateStation(st('e', { self: true }), lun).status, STATUS.PROBABLE);
  assert.equal(evaluateStation(st('f', { highway: true }), lun).status, STATUS.PROBABLE);
  const r = evaluateStation(st('g', { oh: 'Mo-Sa 07:00-20:00' }), lun);
  assert.equal(r.source, 'osm');
  assert.equal(r.sourceLabel, 'OpenStreetMap');
});

test('stato: mai "aperto" senza dati; solo OSM e posizione dubbia limitano lo stato', () => {
  const lun = new Date('2026-12-28T10:00:00');
  for (const s of [st('x'), st('y', { self: true }), st('z', { highway: true })]) {
    assert.notEqual(evaluateStation(s, lun).status, STATUS.OPEN);
  }
  assert.equal(evaluateStation(st('o', { oh: H24, src: 'osm' }), lun).status, STATUS.PROBABLE);
  assert.equal(evaluateStation(st('p', { oh: H24, posDubbia: true }), lun).status, STATUS.UNKNOWN);
  // un chiuso resta chiuso anche se la posizione è dubbia
  assert.equal(evaluateStation(st('q', { oh: 'Mo-Fr 08:00-12:00', posDubbia: true }), lun).status, STATUS.UNKNOWN);
  assert.equal(evaluateStation(st('q', { oh: 'Mo-Fr 08:00-09:00', posDubbia: true }), lun).status, STATUS.CLOSED);
});

test('stato: segnalazioni personali', () => {
  const dom = new Date('2026-11-29T10:00:00');  // domenica
  const mer = new Date('2026-12-02T10:00:00');  // mercoledì
  const s = st('r', { oh: H24 });
  // "Trovato chiuso" vale sempre, qualunque sia il giorno della segnalazione
  const closed = { reports: { r: { type: REPORT.CLOSED, date: '2026-11-22' } } };
  assert.equal(evaluateStation(s, dom, closed).status, STATUS.CLOSED);
  assert.equal(evaluateStation(s, mer, closed).status, STATUS.CLOSED);
  assert.equal(evaluateStation(s, mer, closed).source, 'segnalazione');
  assert.equal(evaluateStation(s, mer, closed).updated, '2026-11-22');
  const safe = { reports: { u: { type: REPORT.SAFE_HOLIDAYS, date: '2026-11-01' } } };
  assert.equal(evaluateStation(st('u'), dom, safe).status, STATUS.OPEN);
  assert.equal(evaluateStation(st('u'), mer, safe).status, STATUS.UNKNOWN);
});

test('stato: Google ha la precedenza su OSM', () => {
  const lun = new Date('2026-12-28T10:00:00');
  const google = new Map([['a', { isOpenAt: () => false, fetchedAt: '2026-12-27' }]]);
  const r = evaluateStation(st('a', { oh: H24 }), lun, { google });
  assert.equal(r.status, STATUS.CLOSED);
  assert.equal(r.source, 'google');
  const unknownG = new Map([['a', { isOpenAt: () => null, fetchedAt: '2026-12-27' }]]);
  assert.equal(evaluateStation(st('a', { oh: H24 }), lun, { google: unknownG }).source, 'osm');
});

// ---------- algoritmo soste: i quattro casi richiesti ----------

test('autonomia insufficiente: nessun piano e punto critico', () => {
  const departure = new Date('2026-12-01T08:00:00');
  const r = plan({
    routeKm: 650, departure, allowPetrol: false,
    candidates: [cand(st('A', { oh: H24 }), 100), cand(st('B', { oh: H24 }), 500)],
  });
  assert.equal(r.ok, false);
  const c = r.critical;
  assert.equal(c.from.id, 'A');
  assert.equal(c.next.id, 'B');
  assert.ok(Math.abs(c.gapKm - 400.2) < 0.01);
  assert.equal(c.maxLegKm, 262.5);
  assert.equal(c.reachableWithMethaneReserve, false); // 400 > 350
  assert.equal(c.reachableWithPetrol, true);          // 400 ≤ 350 + 100 − 10 di margine
  // buco ancora più grande: nemmeno con la benzina (e quindi nessun piano di emergenza)
  const r2 = plan({ routeKm: 700, departure, candidates: [cand(st('A', { oh: H24 }), 100), cand(st('B', { oh: H24 }), 600)] });
  assert.equal(r2.ok, false);
  assert.equal(r2.critical.reachableWithPetrol, false);
  assert.equal(r2.critical.petrolTried, true);
  // nessun distributore utile dalla partenza: il punto critico è la partenza
  const r3 = plan({ routeKm: 600, departure, allowPetrol: false, candidates: [cand(st('C', { oh: H24 }), 300)] });
  assert.equal(r3.ok, false);
  assert.equal(r3.critical.from, null);
  assert.equal(r3.critical.next.id, 'C');
});

test('distributore chiuso: mai scelto come sosta', () => {
  const departure = new Date('2026-12-01T08:00:00'); // martedì; km 200 alle 10:00
  const closed = st('CHIUSO', { oh: 'Mo-Fr 14:00-19:00', price: 1.5 }); // più economico ma chiuso
  const open = st('APERTO', { oh: 'Mo-Fr 07:00-19:00', price: 2.2 });
  const r = plan({ routeKm: 450, departure, candidates: [cand(closed, 200), cand(open, 230)] });
  assert.equal(r.ok, true);
  assert.deepEqual(ids(r), ['APERTO']);
  assert.equal(r.stops[0].evaluation.status, STATUS.OPEN);
  // se chiude anche l'altro, nessun piano e i chiusi sono indicati nel punto critico
  const r2 = plan({ routeKm: 450, departure, candidates: [cand(closed, 200), cand(st('X', { oh: 'Mo-Fr 15:00-19:00' }), 230)] });
  assert.equal(r2.ok, false);
  assert.deepEqual(r2.critical.closedInRange.map((c) => c.station.id), ['CHIUSO', 'X']);
  assert.equal(r2.critical.nextIsDestination, true);
});

test('viaggio in un giorno festivo (Natale)', () => {
  const A = st('FERIALE_PH_OFF', { oh: 'Mo-Sa 07:00-20:00; PH off', price: 1.8 });
  const B = st('SENZA_PH', { oh: 'Mo-Su 07:00-20:00', price: 1.9 });
  const C = st('APERTO_PH', { oh: 'Mo-Su,PH 06:00-22:00', price: 2.1 });
  const candidates = () => [cand(A, 200), cand(B, 220), cand(C, 240)];
  const natale = plan({ routeKm: 450, departure: new Date('2026-12-25T08:00:00'), candidates: candidates() });
  assert.equal(natale.ok, true);
  assert.deepEqual(ids(natale), ['APERTO_PH']);
  assert.equal(natale.stops[0].evaluation.status, STATUS.OPEN);
  assert.equal(natale.stops[0].backup.station.id, 'SENZA_PH');
  assert.equal(natale.stops[0].backup.evaluation.status, STATUS.PROBABLE);
  // lo stesso viaggio di lunedì: tutti aperti, vince il più economico
  const lunedi = plan({ routeKm: 450, departure: new Date('2026-12-28T08:00:00'), candidates: candidates() });
  assert.deepEqual(ids(lunedi), ['FERIALE_PH_OFF']);
});

test('nessun orario disponibile: preferisce self/autostradale, poi sconosciuto', () => {
  const departure = new Date('2026-12-01T08:00:00');
  const X = st('SCONOSCIUTO', { price: 1.7 });
  const Y = st('AUTOSTRADALE', { highway: true, price: 2.3 });
  const Z = st('SELF', { self: true, price: 2.0 });
  const r = plan({ routeKm: 450, departure, candidates: [cand(X, 150), cand(Y, 180), cand(Z, 200)] });
  assert.equal(r.ok, true);
  assert.deepEqual(ids(r), ['SELF']); // probabile come l'autostradale, ma costa meno
  assert.equal(r.summary.worstStatus, STATUS.PROBABLE);
  // solo distributori senza alcun dato: il piano c'è ma è "sconosciuto"
  const r2 = plan({ routeKm: 450, departure, candidates: [cand(st('S1'), 150), cand(st('S2'), 200)] });
  assert.equal(r2.ok, true);
  assert.equal(r2.summary.worstStatus, STATUS.UNKNOWN);
  assert.equal(r2.stops[0].evaluation.sourceLabel, 'Orario sconosciuto');
});

// ---------- benzina di emergenza ----------

test('benzina: con poco metano si consuma tutto il metano e poi la benzina fino al primo distributore', () => {
  // Caso reale Muggia (TS) -> Caronno Pertusella (VA): 50 km di metano, 100 km di benzina,
  // primo distributore a metano utile al km 77 (Porpetto).
  const departure = new Date('2026-11-22T18:40:00');
  const r = plan({
    routeKm: 420, departure, startKm: 50, petrolKm: 100,
    candidates: [cand(st('PORPETTO', { oh: H24 }), 77, { detourKm: 1, detourMin: 2 }), cand(st('VERONA', { oh: H24 }), 260)],
  });
  assert.equal(r.ok, true);
  assert.equal(r.emergency, true);
  assert.equal(r.usesPetrol, true);
  assert.deepEqual(ids(r), ['PORPETTO', 'VERONA']);
  const [p, v] = r.stops;
  assert.ok(Math.abs(p.legKm - 77.5) < 1e-9);
  assert.ok(Math.abs(p.legPetrolKm - 27.5) < 1e-9);   // 77,5 km − 50 di metano
  assert.equal(p.fuelAtArrivalKm, 0);                  // metano esaurito
  assert.ok(Math.abs(p.petrolLeftKm - 72.5) < 1e-9);
  assert.equal(v.legPetrolKm, 0);                      // dopo il pieno, di nuovo solo metano
  assert.ok(Math.abs(r.summary.petrolKm - 27.5) < 1e-9);
  // perché non basta il metano: dalla partenza (25 km consentiti) al primo distributore
  assert.equal(r.methaneCritical.from, null);
  assert.equal(r.methaneCritical.next.id, 'PORPETTO');
  // il costo stimato del metano esclude i km fatti a benzina
  assert.ok(Math.abs(r.summary.fuelKg - ((420 + 1.2 - 27.5) * 4) / 100) < 1e-9);
});

test('benzina: mai se esiste un piano solo a metano; preferisce un distributore aperto', () => {
  const departure = new Date('2026-12-01T08:00:00');
  // con il pieno il piano a metano esiste: niente benzina
  const full = plan({ routeKm: 420, departure, candidates: [cand(st('A', { oh: H24 }), 200)] });
  assert.equal(full.emergency, false);
  assert.equal(full.summary.petrolKm, 0);
  // emergenza: meno benzina prima di tutto. Il primo ha orario sconosciuto, quello aperto
  // costa 30 km di benzina in più: si sceglie il primo (la riserva copre il caso chiuso).
  const r = plan({
    routeKm: 300, departure, startKm: 40, petrolKm: 100,
    candidates: [cand(st('IGNOTO'), 60), cand(st('APERTO', { oh: H24 }), 90)],
  });
  assert.equal(r.emergency, true);
  assert.deepEqual(ids(r), ['IGNOTO']);
  assert.equal(r.stops[0].backup.station.id, 'APERTO');
  // ma se l'aperto è solo pochi km dopo (stesso scaglione di 10 km), vince l'aperto
  const r2 = plan({
    routeKm: 300, departure, startKm: 40, petrolKm: 100,
    candidates: [cand(st('IGNOTO'), 61), cand(st('APERTO', { oh: H24 }), 65)],
  });
  assert.deepEqual(ids(r2), ['APERTO']);
  assert.ok(Math.abs(r2.stops[0].legPetrolKm - 25.1) < 1e-9);
  // margine benzina: 100 km di benzina, 10 di margine -> al massimo 90 km a benzina
  const far = plan({ routeKm: 400, departure, startKm: 40, petrolKm: 100, candidates: [cand(st('X', { oh: H24 }), 135)] });
  assert.equal(far.ok, false);
  // senza permesso di usare la benzina
  const no = plan({ routeKm: 300, departure, startKm: 40, allowPetrol: false, candidates: [cand(st('APERTO', { oh: H24 }), 90)] });
  assert.equal(no.ok, false);
});

test('benzina: piano di emergenza anche solo bruciando il margine di metano', () => {
  // 280 km con il pieno: oltre i 262,5 km utili, ma entro i 350 reali; nessun distributore
  const r = plan({ routeKm: 280, departure: new Date('2026-12-01T08:00:00'), candidates: [] });
  assert.equal(r.ok, true);
  assert.equal(r.emergency, true);
  assert.equal(r.usesPetrol, false);
  assert.equal(r.arrival.fuelKm, 70);
});

// ---------- altri comportamenti ----------

test('preferenza: lo stato conta più del numero di soste e della deviazione', () => {
  const departure = new Date('2026-12-01T08:00:00');
  // un'unica sosta "sconosciuta" a km 250, oppure due soste "aperte" a 150 e 380
  const r = plan({
    routeKm: 600, departure,
    candidates: [cand(st('A1', { oh: H24 }), 150), cand(st('U'), 250), cand(st('A2', { oh: H24 }), 380)],
  });
  assert.deepEqual(ids(r), ['A1', 'A2']);
  // a parità di stato vince la deviazione minore
  const r2 = plan({
    routeKm: 450, departure,
    candidates: [cand(st('LONTANO', { oh: H24, price: 1.5 }), 200, { detourKm: 8, detourMin: 12 }), cand(st('VICINO', { oh: H24, price: 2.5 }), 210)],
  });
  assert.deepEqual(ids(r2), ['VICINO']);
});

test('ETA: somma guida, deviazioni e 10 minuti per ogni rifornimento', () => {
  const departure = new Date('2026-12-01T08:00:00');
  const r = plan({
    routeKm: 700, departure,
    candidates: [cand(st('P1', { oh: H24 }), 250, { detourKm: 2, detourMin: 6 }), cand(st('P2', { oh: H24 }), 500, { detourKm: 2, detourMin: 6 })],
  });
  assert.deepEqual(ids(r), ['P1', 'P2']);
  const min = (d) => (d.getTime() - departure.getTime()) / 60000;
  assert.equal(min(r.stops[0].eta), 150 + 3);           // 250 km a 100 km/h + metà deviazione
  assert.equal(min(r.stops[1].eta), 300 + 3 + 10 + 3 + 3); // + sosta 10 min + uscita da P1 + entrata in P2
  assert.equal(min(r.arrival.eta), 420 + 6 + 6 + 20);
  assert.equal(r.summary.stops, 2);
  assert.equal(r.summary.totalKm, 704);
  assert.ok(Math.abs(r.summary.costEuro - (704 * 4 / 100) * 2.0) < 1e-9);
});

test('serbatoio parziale e viaggio senza soste', () => {
  const departure = new Date('2026-12-01T08:00:00');
  assert.equal(firstLegLimit(350, 350, 0.75), 262.5);
  assert.equal(firstLegLimit(200, 350, 0.75), 112.5);
  assert.equal(firstLegLimit(100, 350, 0.75), 50);
  const low = plan({ routeKm: 300, departure, startKm: 100, candidates: [cand(st('Q', { oh: H24 }), 40), cand(st('R', { oh: H24 }), 70)] });
  assert.deepEqual(ids(low), ['Q']);
  assert.match(low.warnings[0], /Serbatoio basso/);
  const none = plan({ routeKm: 200, departure, candidates: [cand(st('Q', { oh: H24 }), 100)] });
  assert.equal(none.ok, true);
  assert.equal(none.stops.length, 0);
  assert.equal(none.arrival.fuelKm, 150);
  // 270 km con il pieno: oltre i 262,5 km utili serve una sosta
  const one = plan({ routeKm: 270, departure, candidates: [cand(st('Q', { oh: H24 }), 100)] });
  assert.equal(one.stops.length, 1);
});

test('riserva: raggiungibile dalla sosta principale e permette di proseguire', () => {
  const departure = new Date('2026-12-01T08:00:00');
  const r = plan({
    routeKm: 500, departure,
    candidates: [
      cand(st('TROPPO_PRESTO', { oh: H24 }), 60),   // da qui non si arriva alla fine (440 km)
      cand(st('MAIN', { oh: H24, price: 1.8 }), 250),
      cand(st('VICINA', { oh: H24, price: 2.4 }), 265),
    ],
  });
  assert.deepEqual(ids(r), ['MAIN']);
  const b = r.stops[0].backup;
  assert.equal(b.station.id, 'VICINA');
  assert.equal(b.mode, 'pieno');
  assert.ok(Math.abs(b.distFromMainKm - 15.2) < 0.01);
});

test('aree di servizio sulla carreggiata opposta: escluse', () => {
  const departure = new Date('2026-12-01T08:00:00');
  const wrong = { ...cand(st('OPPOSTA', { oh: H24, highway: true, price: 1.5 }), 200), wrongSide: true };
  const r = plan({ routeKm: 450, departure, candidates: [wrong, cand(st('GIUSTA', { oh: H24, highway: true, price: 2.2 }), 210)] });
  assert.deepEqual(ids(r), ['GIUSTA']);
  assert.equal(r.stops[0].backup, null);
});

test('stationPrice: self, poi servito, poi L-GNC', () => {
  assert.equal(stationPrice({ prices: { metano: { self: { p: 1.9 }, servito: { p: 2.0 } } } }), 1.9);
  assert.equal(stationPrice({ prices: { metano: { servito: { p: 2.0 } } } }), 2.0);
  assert.equal(stationPrice({ prices: { lgnc: { self: { p: 1.7 } } } }), 1.7);
  assert.equal(stationPrice({ prices: null }), null);
});

test('planTrip: verifica le deviazioni reali e ripianifica scartando la carreggiata opposta', async () => {
  // percorso nord-sud di ~222 km, 2 ore
  const route = prepareRoute(Array.from({ length: 201 }, (_, i) => [9, 44 + i * 0.01]), { duration: 7200 });
  const stations = [
    { ...st('OPPOSTA', { oh: H24, highway: true, price: 1.5 }), lat: 44.9, lon: 9.0004 },
    { ...st('GIUSTA', { oh: H24, highway: true, price: 2.0 }), lat: 44.95, lon: 9.0004 },
  ];
  const measured = [];
  const ors = {
    async measureDetour(_route, c) {
      measured.push(c.station.id);
      return c.station.id === 'OPPOSTA' ? { detourKm: 30, detourMin: 22 } : { detourKm: 0.1, detourMin: 1 };
    },
  };
  const res = await planTrip({
    route, stations, ors, departure: new Date('2026-12-01T08:00:00'), startKm: 200, // prima tratta ≤ 112,5 km
    settings: { rangeKm: 350, safety: 0.75, maxDistKm: 5 },
    evaluate: (s, w) => evaluateStation(s, w),
  });
  assert.equal(res.plan.ok, true);
  assert.deepEqual(res.plan.stops.map((s) => s.station.id), ['GIUSTA']);
  assert.ok(measured.includes('OPPOSTA'));
  assert.equal(res.candidates.find((c) => c.station.id === 'OPPOSTA').wrongSide, true);
  assert.ok(WRONG_SIDE_KM < 30);
});

test('planTrip: errore di quota -> stime mantenute e nota', async () => {
  const route = prepareRoute(Array.from({ length: 201 }, (_, i) => [9, 44 + i * 0.01]), { duration: 7200 });
  const stations = [{ ...st('S', { oh: H24, highway: true }), lat: 44.9, lon: 9.0004 }];
  const err = Object.assign(new Error('Quota esaurita'), { status: 429 });
  const res = await planTrip({
    route, stations, departure: new Date('2026-12-01T08:00:00'), startKm: 200,
    settings: {}, evaluate: (s, w) => evaluateStation(s, w),
    ors: { measureDetour: async () => { throw err; } },
  });
  assert.equal(res.plan.ok, true);
  assert.match(res.notes[0], /non verificata/);
});
