import { test } from 'node:test';
import assert from 'node:assert/strict';

import { prepareRoute, findCorridorStations, pointAtKm, DETOUR_ROAD_FACTOR } from '../public/js/lib/corridor.js';
import { OrsClient, OrsError, routeFromGeoJson } from '../public/js/lib/ors.js';

// Percorso sintetico: lungo il meridiano 9°E da 44°N a 46°N (≈ 222,4 km), un punto ogni 0,01°.
const LINE = Array.from({ length: 201 }, (_, i) => [9, 44 + i * 0.01]);
const kmPerDegLon = (lat) => 111.32 * Math.cos(lat * Math.PI / 180);

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} atteso ${b}, ottenuto ${a}`);

test('prepareRoute: distanza cumulativa e riscalatura alla distanza ufficiale', () => {
  const r = prepareRoute(LINE);
  near(r.distance / 1000, 222.4, 0.3);
  const r2 = prepareRoute(LINE, { distance: 250_000, duration: 9000 });
  near(r2.distance, 250_000, 1e-6);
  near(r2.duration, 9000, 1e-6);
  near(r2.cumTime[100], 4500, 1); // a metà strada, metà del tempo
});

test('prepareRoute: tempi distribuiti per tratto (autostrada veloce, poi strada lenta)', () => {
  // prima metà in 1 ora, seconda metà in 2 ore
  const r = prepareRoute(LINE, { steps: [{ from: 0, to: 100, duration: 3600 }, { from: 100, to: 200, duration: 7200 }] });
  near(r.cumTime[50], 1800, 1);
  near(r.cumTime[100], 3600, 1e-6);
  near(r.cumTime[150], 7200, 1);
  near(r.duration, 10800, 1e-6);
});

test('findCorridorStations: corridoio, km progressivi, deviazione, ordine', () => {
  const r = prepareRoute(LINE, { duration: 8000 });
  const stations = [
    { id: 'sul-percorso', lat: 45.0, lon: 9.0 },
    { id: 'a-3km', lat: 44.5, lon: 9 + 3 / kmPerDegLon(44.5) },
    { id: 'a-6km', lat: 45.5, lon: 9 + 6 / kmPerDegLon(45.5) },
    { id: 'oltre-arrivo', lat: 46.1, lon: 9.0 },          // 11 km oltre l'arrivo
    { id: 'vicino-partenza', lat: 43.98, lon: 9.0 },      // 2,2 km prima della partenza
    { id: 'lontanissimo', lat: 38.1, lon: 13.3 },
  ];
  const res = findCorridorStations(r, stations, { maxDistKm: 5 });
  assert.deepEqual(res.map((c) => c.station.id), ['vicino-partenza', 'a-3km', 'sul-percorso']);
  const [p, a3, s] = res;
  near(p.km, 0, 1e-9);
  near(p.distKm, 2.22, 0.02);
  near(a3.km, 55.6, 0.3, 'km a-3km');
  near(a3.distKm, 3, 0.02);
  near(a3.detourKm, 2 * 3 * DETOUR_ROAD_FACTOR, 0.05);
  near(s.km, 111.2, 0.3);
  near(s.distKm, 0, 0.001);
  near(s.driveSec, 4000, 10);
  // con corridoio più largo entra anche quello a 6 km
  assert.equal(findCorridorStations(r, stations, { maxDistKm: 7 }).length, 4);
});

test('findCorridorStations: percorso che ripassa vicino allo stesso punto -> passaggio più vicino', () => {
  // andata lungo 9,00°E, ritorno lungo 9,02°E (≈1,6 km più a est)
  const out = Array.from({ length: 51 }, (_, i) => [9, 44 + i * 0.01]);
  const back = Array.from({ length: 51 }, (_, i) => [9.02, 44.5 - i * 0.01]);
  const r = prepareRoute([...out, ...back]);
  const [c] = findCorridorStations(r, [{ id: 'x', lat: 44.2, lon: 9.019 }], { maxDistKm: 5 });
  assert.ok(c.km > 60, `deve essere sul ritorno, km=${c.km}`);
  assert.ok(c.distKm < 0.1);
});

test('findCorridorStations: autostrada a pedaggio e carreggiata da verificare', () => {
  // prima metà a pedaggio (segmenti 0..99), seconda metà strada normale
  const toll = new Uint8Array(200);
  toll.fill(1, 0, 100);
  const r = prepareRoute(LINE, { toll });
  const res = findCorridorStations(r, [
    { id: 'area-servizio', lat: 44.3, lon: 9.0005, highway: true },     // ~40 m, autostradale
    { id: 'fuori-casello', lat: 44.6, lon: 9 + 2 / kmPerDegLon(44.6) }, // 2 km, stradale
    { id: 'statale', lat: 45.5, lon: 9 + 2 / kmPerDegLon(45.5) },       // 2 km, fuori autostrada
  ]);
  const by = Object.fromEntries(res.map((c) => [c.station.id, c]));
  assert.equal(by['area-servizio'].sideUnknown, true);
  assert.equal(by['area-servizio'].onTollway, true);
  near(by['area-servizio'].detourMin, 0.17, 0.05);
  assert.equal(by['fuori-casello'].sideUnknown, false);
  near(by['fuori-casello'].detourMin - by['statale'].detourMin, 10, 0.1);
  assert.equal(by['statale'].onTollway, false);
  // senza informazioni sui pedaggi
  assert.equal(findCorridorStations(prepareRoute(LINE), [{ id: 'x', lat: 45, lon: 9 }])[0].onTollway, null);
});

test('pointAtKm: estremi e interpolazione', () => {
  const r = prepareRoute(LINE, { distance: 200_000 });
  assert.deepEqual(pointAtKm(r, -5), { lat: 44, lon: 9 });
  assert.deepEqual(pointAtKm(r, 999), { lat: 46, lon: 9 });
  near(pointAtKm(r, 100).lat, 45, 1e-9);
});

function fakeOrsGeo(coords, distance, duration) {
  return {
    type: 'FeatureCollection',
    features: [{
      geometry: { type: 'LineString', coordinates: coords },
      properties: {
        summary: { distance, duration },
        segments: [{ steps: [
          { distance: distance / 2, duration: duration / 4, way_points: [0, 100] },
          { distance: distance / 2, duration: (3 * duration) / 4, way_points: [100, 200] },
          { distance: 0, duration: 0, way_points: [200, 200] },
        ] }],
        extras: { tollways: { values: [[0, 50, 1], [50, 200, 0]] } },
      },
    }],
  };
}

test('routeFromGeoJson: usa summary e passi di ORS', () => {
  const r = routeFromGeoJson(fakeOrsGeo(LINE, 230_000, 8000));
  near(r.distance, 230_000, 1e-6);
  near(r.cumTime[100], 2000, 1e-6);
  near(r.duration, 8000, 1e-6);
  assert.equal(r.geojson.type, 'LineString');
  assert.equal(r.toll[49], 1);
  assert.equal(r.toll[50], 0);
  assert.throws(() => routeFromGeoJson({ features: [] }), OrsError);
});

function mockFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const { status = 200, body } = handler(String(url), init);
    return { ok: status < 400, status, json: async () => body };
  };
  fn.calls = calls;
  return fn;
}

test('OrsClient.autocomplete: parametri e risultato', async () => {
  const f = mockFetch(() => ({ body: { features: [{ properties: { label: 'Milano, MI, Italia' }, geometry: { coordinates: [9.19, 45.46] } }] } }));
  const ors = new OrsClient('KEY', f);
  const res = await ors.autocomplete('Mila');
  assert.deepEqual(res, [{ label: 'Milano, MI, Italia', lat: 45.46, lon: 9.19 }]);
  const u = new URL(f.calls[0].url);
  assert.equal(u.pathname, '/geocode/autocomplete');
  assert.equal(u.searchParams.get('boundary.country'), 'IT');
  assert.equal(u.searchParams.get('text'), 'Mila');
  assert.doesNotMatch(u.searchParams.get('layers'), /region|county/);
});

test('OrsClient.directions: POST con chiave in intestazione e coordinate lon,lat', async () => {
  const f = mockFetch(() => ({ body: fakeOrsGeo(LINE, 222_000, 8000) }));
  const ors = new OrsClient('KEY', f);
  const r = await ors.route({ lat: 44, lon: 9 }, { lat: 46, lon: 9 });
  near(r.distance, 222_000, 1e-6);
  const { url, init } = f.calls[0];
  assert.ok(url.endsWith('/v2/directions/driving-car/geojson'));
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, 'KEY');
  assert.deepEqual(JSON.parse(init.body).coordinates, [[9, 44], [9, 46]]);
  assert.deepEqual(JSON.parse(init.body).extra_info, ['tollways']);
});

test('OrsClient: errori tradotti in italiano', async () => {
  for (const [status, re] of [[401, /non valida/], [429, /Quota/], [404, /non trovato/], [503, /non risponde/]]) {
    const ors = new OrsClient('KEY', mockFetch(() => ({ status, body: { error: 'x' } })));
    await assert.rejects(ors.autocomplete('Roma'), (e) => e instanceof OrsError && re.test(e.message) && e.status === status);
  }
  const offline = new OrsClient('KEY', async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(offline.autocomplete('Roma'), /Sei online/);
  assert.throws(() => new OrsClient(''), /Manca la chiave/);
});

test('OrsClient.measureDetour: deviazione reale e carreggiata opposta', async () => {
  const route = prepareRoute(LINE, { distance: 222_400, duration: 8000 });
  const cand = { km: 111.2, station: { lat: 45, lon: 9.001 } };
  // finestra 10 km: diretto ≈ 10 km / 360 s; passando dal distributore 10,4 km / 420 s
  const ok = new OrsClient('KEY', mockFetch(() => ({ body: { features: [{ properties: { summary: { distance: 10_400, duration: 420 } } }] } })));
  const d = await ok.measureDetour(route, cand);
  near(d.detourKm, 0.4, 0.01);
  near(d.detourMin, 1, 0.05);
  // carreggiata opposta: bisogna uscire e rientrare, +24 km
  const far = new OrsClient('KEY', mockFetch(() => ({ body: { features: [{ properties: { summary: { distance: 34_000, duration: 1500 } } }] } })));
  near((await far.measureDetour(route, cand)).detourKm, 24, 0.01);
});
