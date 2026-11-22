import { test } from 'node:test';
import assert from 'node:assert/strict';

import { googleMapsUrl, wazeUrl, googleMapsLegs } from '../public/js/lib/navlinks.js';

const P = (label, lat, lon) => ({ label, lat, lon });
const params = (url) => Object.fromEntries(new URL(url).searchParams);

test('Google Maps: parametri del link', () => {
  const url = googleMapsUrl(P('A', 45.6, 13.76), P('B', 45.6, 9.05), [P('S1', 45.8, 13.1), P('S2', 45.42, 11.83)]);
  assert.ok(url.startsWith('https://www.google.com/maps/dir/?'));
  assert.deepEqual(params(url), {
    api: '1',
    origin: '45.600000,13.760000',
    destination: '45.600000,9.050000',
    waypoints: '45.800000,13.100000|45.420000,11.830000',
    travelmode: 'driving',
  });
  // senza partenza = posizione attuale; senza tappe = niente parametro waypoints
  const p2 = params(googleMapsUrl(null, P('B', 45.6, 9.05)));
  assert.equal(p2.origin, undefined);
  assert.equal(p2.waypoints, undefined);
});

test('Waze: una destinazione per link', () => {
  assert.equal(wazeUrl(P('S', 45.8123456, 13.1)), 'https://waze.com/ul?ll=45.812346,13.100000&navigate=yes');
});

test('Google Maps: al massimo 3 tappe per link, viaggio diviso in tratti concatenati', () => {
  const from = P('Partenza', 45, 7);
  const to = P('Arrivo', 40, 18);
  const stops = (n) => Array.from({ length: n }, (_, i) => P(`S${i + 1}`, 44 - i * 0.5, 8 + i));

  for (const n of [0, 1, 3]) {
    const legs = googleMapsLegs(from, to, stops(n));
    assert.equal(legs.length, 1, `${n} soste`);
    assert.equal(legs[0].stops, n);
    assert.equal(legs[0].to, 'Arrivo');
  }

  // 5 soste: Partenza -> S1,S2,S3 -> S4 ; S4 -> S5 -> Arrivo
  const legs = googleMapsLegs(from, to, stops(5));
  assert.equal(legs.length, 2);
  assert.deepEqual(legs.map((l) => [l.index, l.from, l.to, l.stops]), [[1, 'Partenza', 'S4', 3], [2, 'S4', 'Arrivo', 1]]);
  const p1 = params(legs[0].url);
  assert.equal(p1.waypoints.split('|').length, 3);
  assert.equal(p1.destination, params(legs[1].url).origin); // il tratto 2 parte dove finisce il tratto 1

  // 8 soste: 3 tratti, mai più di 3 tappe
  const l8 = googleMapsLegs(from, to, stops(8));
  assert.deepEqual(l8.map((l) => l.stops), [3, 3, 0]);
  for (const l of l8) assert.ok((params(l.url).waypoints?.split('|').length ?? 0) <= 3);
  assert.equal(l8.at(-1).to, 'Arrivo');
});

test('Google Maps: partenza dalla posizione attuale solo nel primo tratto', () => {
  const from = { ...P('Posizione attuale', 45, 7), current: true };
  const legs = googleMapsLegs(from, P('Arrivo', 40, 18), Array.from({ length: 4 }, (_, i) => P(`S${i}`, 44, 8 + i)));
  assert.equal(params(legs[0].url).origin, undefined);
  assert.equal(params(legs[1].url).origin, '44.000000,11.000000');
});
