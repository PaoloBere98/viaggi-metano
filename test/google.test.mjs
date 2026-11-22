process.env.TZ = 'Europe/Rome';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GooglePlacesClient, GoogleError, hoursFromPlace, romeParts } from '../public/js/lib/google.js';
import { holidayOn } from '../public/js/lib/festivi.js';
import { evaluateStation, STATUS } from '../public/js/lib/opening.js';

const isHoliday = (d) => holidayOn(d) !== null;
const station = { id: 'm1', name: 'Eni', brand: 'Agip Eni', address: 'Via Roma 1', city: 'MILANO', lat: 45.46, lon: 9.19 };
const at = (s) => new Date(s);
const per = (od, oh, cd, ch) => ({ open: { day: od, hour: oh, minute: 0 }, close: { day: cd, hour: ch, minute: 0 } });

// Lun-Sab 07-20 (giorni Google: 0 = domenica)
const MO_SA_7_20 = { periods: [1, 2, 3, 4, 5, 6].map((d) => per(d, 7, d, 20)) };

test('romeParts: ora italiana', () => {
  const p = romeParts(at('2026-12-25T10:30:00'));
  assert.deepEqual([p.y, p.m, p.d, p.weekday, p.minutes], [2026, 12, 25, 5, 630]);
});

test('orario settimanale: aperto, chiuso, a cavallo della mezzanotte, 24 ore', () => {
  const fetched = at('2026-11-01T09:00:00'); // le date sotto sono oltre i 7 giorni: vale l'orario regolare
  const g = hoursFromPlace({ regularOpeningHours: MO_SA_7_20 }, fetched, isHoliday);
  assert.equal(g.isOpenAt(at('2026-12-07T10:00:00')), true);   // lunedì
  assert.equal(g.isOpenAt(at('2026-12-07T21:00:00')), false);
  assert.equal(g.isOpenAt(at('2026-12-06T10:00:00')), false);  // domenica
  // venerdì 22 -> sabato 02, e sabato 22 -> domenica 02 (passa dalla fine della settimana)
  const night = hoursFromPlace({ regularOpeningHours: { periods: [per(5, 22, 6, 2), per(6, 22, 0, 2)] } }, fetched, isHoliday);
  assert.equal(night.isOpenAt(at('2026-12-12T01:00:00')), true);  // sabato 01:00
  assert.equal(night.isOpenAt(at('2026-12-13T01:30:00')), true);  // domenica 01:30
  assert.equal(night.isOpenAt(at('2026-12-13T03:00:00')), false);
  const h24 = hoursFromPlace({ regularOpeningHours: { periods: [{ open: { day: 0, hour: 0, minute: 0 } }] } }, fetched, isHoliday);
  assert.equal(h24.isOpenAt(at('2026-12-25T03:00:00')), true);
});

test('orari speciali: entro 7 giorni vale currentOpeningHours (Natale chiuso)', () => {
  const fetched = at('2026-12-22T09:00:00'); // martedì
  // prossimi 7 giorni: aperto 22, 23, 24, 26, 28 dalle 7 alle 20; chiuso il 25 (Natale) e domenica 27
  const days = [22, 23, 24, 26, 28];
  const current = {
    periods: days.map((d) => ({
      open: { day: 0, hour: 7, minute: 0, date: { year: 2026, month: 12, day: d } },
      close: { day: 0, hour: 20, minute: 0, date: { year: 2026, month: 12, day: d } },
    })),
  };
  const g = hoursFromPlace({ regularOpeningHours: MO_SA_7_20, currentOpeningHours: current }, fetched, isHoliday);
  assert.equal(g.isOpenAt(at('2026-12-24T10:00:00')), true);
  assert.equal(g.isOpenAt(at('2026-12-25T10:00:00')), false); // venerdì, ma Natale
  assert.equal(g.isOpenAt(at('2026-12-28T19:30:00')), true);
  // oltre i 7 giorni, in un festivo (Capodanno), Google non decide
  assert.equal(g.isOpenAt(at('2027-01-01T10:00:00')), null);
  // oltre i 7 giorni, giorno normale: orario regolare
  assert.equal(g.isOpenAt(at('2027-01-04T10:00:00')), true);
});

test('stato attività, luogo troppo lontano, nessun orario', () => {
  const f = at('2026-12-01T09:00:00');
  assert.equal(hoursFromPlace({ businessStatus: 'CLOSED_PERMANENTLY' }, f, isHoliday).isOpenAt(f), false);
  const far = hoursFromPlace({ location: { latitude: 45.47, longitude: 9.19 }, regularOpeningHours: MO_SA_7_20 }, f, isHoliday, station);
  assert.equal(far.isOpenAt(at('2026-12-07T10:00:00')), null); // ~1,1 km: non è lo stesso distributore
  assert.match(far.note, /lontano/);
  assert.equal(hoursFromPlace({ displayName: { text: 'X' } }, f, isHoliday).isOpenAt(f), null);
});

test('evaluateStation: Google chiuso batte OSM 24/7; Google indeciso lascia OSM', () => {
  const s = { ...station, src: 'mimit+osm', osm: { id: 'node/1', oh: '24/7', ohScope: 'impianto' } };
  const fetched = at('2026-12-22T09:00:00');
  const closedXmas = hoursFromPlace({
    displayName: { text: 'Eni Milano' },
    regularOpeningHours: MO_SA_7_20,
    currentOpeningHours: { periods: [] }, // chiuso per tutta la settimana di Natale
  }, fetched, isHoliday);
  const r = evaluateStation(s, at('2026-12-25T10:00:00'), { google: new Map([['m1', closedXmas]]) });
  assert.equal(r.status, STATUS.CLOSED);
  assert.equal(r.source, 'google');
  assert.equal(r.updated, '2026-12-22');
  assert.ok(r.notes.some((n) => n.includes('Eni Milano')));
  const undecided = hoursFromPlace({ regularOpeningHours: MO_SA_7_20 }, at('2026-11-01T09:00:00'), isHoliday);
  assert.equal(evaluateStation(s, at('2026-12-25T10:00:00'), { google: new Map([['m1', undecided]]) }).source, 'osm');
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

test('GooglePlacesClient: ricerca "solo ID" nella zona del distributore, poi dettagli', async () => {
  const f = mockFetch((url) => (url.includes('searchText')
    ? { body: { places: [{ id: 'ChIJ123' }] } }
    : { body: { id: 'ChIJ123', displayName: { text: 'Eni' } } }));
  const g = new GooglePlacesClient('GKEY', f);
  assert.equal(await g.findPlaceId(station), 'ChIJ123');
  const s = f.calls[0];
  assert.equal(s.init.headers['X-Goog-FieldMask'], 'places.id'); // SKU "IDs only"
  assert.equal(s.init.headers['X-Goog-Api-Key'], 'GKEY');
  const body = JSON.parse(s.init.body);
  assert.equal(body.textQuery, 'Agip Eni Via Roma 1 MILANO');
  assert.equal(body.includedType, 'gas_station');
  assert.ok(body.locationRestriction.rectangle.low.latitude < station.lat);
  assert.ok(body.locationRestriction.rectangle.high.longitude > station.lon);
  await g.details('ChIJ123');
  assert.ok(f.calls[1].url.endsWith('/places/ChIJ123?languageCode=it'));
  assert.match(f.calls[1].init.headers['X-Goog-FieldMask'], /currentOpeningHours/);
});

test('GooglePlacesClient: errori', async () => {
  const g = new GooglePlacesClient('GKEY', mockFetch(() => ({ status: 403, body: { error: { message: 'Requests from referer are blocked.' } } })));
  await assert.rejects(g.findPlaceId(station), (e) => e instanceof GoogleError && e.status === 403 && /referer/.test(e.message));
  const q = new GooglePlacesClient('GKEY', mockFetch(() => ({ status: 429, body: {} })));
  await assert.rejects(q.details('x'), /Quota Google/);
  assert.throws(() => new GooglePlacesClient(''), /Manca la chiave/);
});
