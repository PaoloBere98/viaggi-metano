// Converte il risultato del pianificatore in un oggetto semplice (solo JSON): serve sia
// per disegnare l'interfaccia sia per salvare l'ultimo piano e rivederlo offline.

import { pointAtKm } from '../lib/corridor.js';

const MAX_ROUTE_POINTS = 1500;

function stationVM(s) {
  return {
    id: s.id,
    name: s.name,
    brand: s.brand ?? null,
    address: s.address ?? null,
    city: s.city ?? null,
    prov: s.prov ?? null,
    lat: s.lat,
    lon: s.lon,
    highway: s.highway ?? null,
    src: s.src,
    posDubbia: !!s.posDubbia,
    phone: s.osm?.phone ?? null,
    prices: s.prices ?? null,
  };
}

function evalVM(e) {
  return {
    status: e.status,
    source: e.source,
    sourceLabel: e.sourceLabel,
    updated: e.updated ?? null,
    notes: e.notes ?? [],
    rule: e.rule ?? null,
  };
}

function candVM(c) {
  return {
    detourKm: c.detourKm,
    detourMin: c.detourMin,
    measured: !!c.measured,
    distKm: c.distKm,
  };
}

function criticalVM(c, route) {
  return {
    fromKm: c.fromKm,
    from: c.from ? stationVM(c.from) : null,
    maxLegKm: c.maxLegKm,
    reachKm: c.reachKm,
    reachPoint: pointAtKm(route, Math.min(c.reachKm, route.distance / 1000)),
    next: c.next ? stationVM(c.next) : null,
    nextKm: c.nextKm,
    nextIsDestination: c.nextIsDestination,
    gapKm: c.gapKm,
    reachableWithMethaneReserve: c.reachableWithMethaneReserve,
    reachableWithPetrol: c.reachableWithPetrol,
    petrolTried: !!c.petrolTried,
    petrolKm: c.petrolKm ?? null,
    closedInRange: c.closedInRange.map((x) => ({
      station: stationVM(x.station), km: x.km, eta: x.eta.toISOString(), evaluation: evalVM(x.evaluation),
    })),
  };
}

/**
 * Tratti del percorso percorsi a benzina, come coppie di punti [lat, lon] da disegnare.
 * In ogni tratta il metano finisce dopo `metano disponibile` km dalla tappa precedente.
 */
function petrolSegments(vm, route) {
  const segs = [];
  const legs = [...vm.stops.map((s) => ({ km: s.km, petrol: s.legPetrolKm })), { km: route.distance / 1000, petrol: vm.arrival.legPetrolKm }];
  for (let k = 0; k < legs.length; k++) {
    if (!(legs[k].petrol > 0.05)) continue;
    const toKm = legs[k].km;
    const fromKm = Math.max(0, toKm - legs[k].petrol);
    const pts = [];
    const steps = Math.max(2, Math.ceil((toKm - fromKm) / 0.5));
    for (let s = 0; s <= steps; s++) {
      const p = pointAtKm(route, fromKm + ((toKm - fromKm) * s) / steps);
      pts.push([p.lat, p.lon]);
    }
    segs.push({ fromKm, toKm, pts });
  }
  return segs;
}

function simplifyRoute(route) {
  const step = Math.max(1, Math.ceil(route.pts.length / MAX_ROUTE_POINTS));
  const out = [];
  for (let i = 0; i < route.pts.length; i += step) out.push([route.pts[i].lat, route.pts[i].lon]);
  const last = route.pts[route.pts.length - 1];
  out.push([last.lat, last.lon]);
  return out;
}

/**
 * @param {object} p
 * @param {{label, lat, lon}} p.from
 * @param {{label, lat, lon}} p.to
 * @param {Date} p.departure
 * @param {number} p.startKm
 * @param {object} p.settings
 * @param {object} p.route
 * @param {{plan, candidates, notes, measuredCount}} p.result
 * @param {(station, when: Date) => object} p.evaluate
 */
export function buildViewModel({ from, to, departure, startKm, settings, route, result, evaluate }) {
  const { plan, candidates } = result;
  const used = new Set();
  const vm = {
    version: 1,
    createdAt: new Date().toISOString(),
    from, to,
    departure: departure.toISOString(),
    startKm,
    settings,
    route: { coords: simplifyRoute(route), km: route.distance / 1000, sec: route.duration },
    ok: plan.ok,
    warnings: plan.warnings ?? [],
    notes: result.notes ?? [],
    measuredCount: result.measuredCount ?? 0,
    corridorCount: candidates.length,
  };

  if (plan.ok) {
    vm.emergency = !!plan.emergency;
    vm.usesPetrol = !!plan.usesPetrol;
    vm.methaneCritical = plan.methaneCritical ? criticalVM(plan.methaneCritical, route) : null;
    vm.stops = plan.stops.map((s, i) => {
      used.add(s.station.id);
      if (s.backup) used.add(s.backup.station.id);
      return {
        n: i + 1,
        station: stationVM(s.station),
        km: s.km,
        legKm: s.legKm,
        legPetrolKm: s.legPetrolKm ?? 0,
        petrolLeftKm: s.petrolLeftKm ?? null,
        eta: s.eta.toISOString(),
        fuelAtArrivalKm: s.fuelAtArrivalKm,
        price: s.price,
        ...candVM(s.candidate),
        evaluation: evalVM(s.evaluation),
        backup: s.backup && {
          station: stationVM(s.backup.station),
          km: s.backup.km,
          eta: s.backup.eta.toISOString(),
          price: s.backup.price,
          mode: s.backup.mode,
          distFromMainKm: s.backup.distFromMainKm,
          usesReserve: s.backup.usesReserve,
          usesPetrol: !!s.backup.usesPetrol,
          ...candVM(s.backup.candidate),
          evaluation: evalVM(s.backup.evaluation),
        },
      };
    });
    vm.arrival = {
      eta: plan.arrival.eta.toISOString(),
      fuelKm: plan.arrival.fuelKm,
      legPetrolKm: plan.arrival.legPetrolKm ?? 0,
      petrolLeftKm: plan.arrival.petrolLeftKm ?? null,
    };
    vm.summary = plan.summary;
    vm.petrolSegments = petrolSegments(vm, route);
  } else {
    vm.critical = criticalVM(plan.critical, route);
    for (const x of plan.critical.closedInRange) used.add(x.station.id);
  }

  // Altri distributori del corridoio, con lo stato stimato al passaggio (senza soste).
  vm.others = candidates
    .filter((c) => !used.has(c.station.id) && !c.wrongSide)
    .map((c) => {
      const when = new Date(departure.getTime() + c.driveSec * 1000);
      const e = evaluate(c.station, when);
      return {
        id: c.station.id, name: c.station.name, city: c.station.city ?? null,
        lat: c.station.lat, lon: c.station.lon, km: c.km, status: e.status, sourceLabel: e.sourceLabel,
      };
    });
  return vm;
}
