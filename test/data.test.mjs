import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseAnagrafica, parsePrezzi, collectMetanoPrices, metanoKind, parseDtComu, decodeMimit,
} from '../scripts/lib/mimit.mjs';
import { parseOverpass } from '../scripts/lib/osm.mjs';
import { matchStations, sameBrand } from '../scripts/lib/match.mjs';
import { buildStations } from '../scripts/build-data.mjs';
import { parseComuni, buildComuniIndex, checkComune, normName } from '../scripts/lib/comuni.mjs';

const ANAG_HEAD =
  'Estrazione del 2026-11-21\n' +
  'idImpianto|Gestore|Bandiera|Tipo Impianto|Nome Impianto|Indirizzo|Comune|Provincia|Latitudine|Longitudine\n';

test('anagrafica: riga normale, tabulazioni, BOM e CRLF', () => {
  const txt = '﻿' + ANAG_HEAD.replace(/\n/g, '\r\n') +
    '63381|ENIMOOV S.P.A.|Agip Eni|Stradale|19834\tMONTALLEGRO|SS.115 KM.158+302  S.N.  |AGRIGENTO|AG|37.38895|13.351206\r\n';
  const { extractionDate, rows, warnings } = parseAnagrafica(txt);
  assert.equal(extractionDate, '2026-11-21');
  assert.equal(warnings.length, 0);
  assert.deepEqual(rows[0], {
    id: '63381', gestore: 'ENIMOOV S.P.A.', bandiera: 'Agip Eni', autostradale: false,
    nome: '19834 MONTALLEGRO', indirizzo: 'SS.115 KM.158+302 S.N.', comune: 'AGRIGENTO',
    provincia: 'AG', lat: 37.38895, lon: 13.351206,
  });
});

test('anagrafica: "|" spurie dentro i campi (casi reali)', () => {
  const txt = ANAG_HEAD +
    '40820|STOIL SIMPLE | gestori.prezzibenzina.it|Pompe Bianche|Stradale|STOIL SIMPLE | gestori.prezzibenzina.it|STR. PROV.LE 82 SPINETTA SALE  15122|ALESSANDRIA|AL|44.91646597782148|8.701209425926208\n' +
    '23317|SANTORO PETROLI S.R.L.|Pompe Bianche|Autostradale|SANTORO PETROLI - LIONI | gestori.prezzibenzina.it| SS. 400 KM 33+053  SNC 83047|LIONI|AV|40.89819441170126|15.162087678909302\n' +
    '32772|STAROIL - ANZIO|Pompe Bianche|Stradale|STAROIL - ANZIO || gestori.prezzibenzina.it|VIA NETTUNENSE KM. 34,750  00042|ANZIO|RM|41.47366181263028|12.625812292098999\n' +
    '99999|ACME|Pompe Bianche|Stradale|NOME | CON PIPE|VIA ROMA 1|ROMA|RM|41.9|12.5\n';
  const { rows, warnings } = parseAnagrafica(txt);
  assert.equal(rows.length, 4);
  const anzio = rows.splice(2, 1)[0];
  assert.equal(anzio.nome, 'STAROIL - ANZIO');
  assert.equal(anzio.indirizzo, 'VIA NETTUNENSE KM. 34,750 00042');
  assert.equal(rows[0].gestore, 'STOIL SIMPLE');
  assert.equal(rows[0].nome, 'STOIL SIMPLE');
  assert.equal(rows[0].comune, 'ALESSANDRIA');
  assert.equal(rows[1].nome, 'SANTORO PETROLI - LIONI');
  assert.equal(rows[1].indirizzo, 'SS. 400 KM 33+053 SNC 83047');
  assert.equal(rows[1].autostradale, true);
  // pipe generica: ricostruzione con 4 campi fissi a sinistra e 4 a destra
  assert.equal(rows[2].nome, 'NOME CON PIPE');
  assert.equal(rows[2].indirizzo, 'VIA ROMA 1');
  assert.equal(rows[2].comune, 'ROMA');
  assert.equal(rows[2].lat, 41.9);
  assert.equal(warnings.length, 1);
});

test('anagrafica: coordinate mancanti, invertite, fuori Italia', () => {
  const txt = ANAG_HEAD +
    '1|G|Shell|Stradale|N|VIA A|PONTEDERA|PI||\n' +
    '2|G|Shell|Stradale|N|VIA B|ROMA|RM|12.5|41.9\n' +
    '3|G|Shell|Stradale|N|VIA C|ROMA|RM|0|0\n' +
    '4|G|Shell|Stradale|N|VIA D|ROMA|RM|51.5|-0.12\n';
  const { rows } = parseAnagrafica(txt);
  assert.equal(rows[0].lat, null);
  assert.deepEqual([rows[1].lat, rows[1].lon], [41.9, 12.5]);
  assert.equal(rows[2].lat, null);
  assert.equal(rows[3].lat, null);
});

test('anagrafica: intestazione cambiata -> errore esplicito', () => {
  const txt = 'Estrazione del 2026-11-21\nidImpianto;Gestore;Bandiera\n1;a;b\n';
  assert.throws(() => parseAnagrafica(txt), /intestazione cambiata/);
  assert.throws(() => parseAnagrafica('idImpianto|Gestore\n'), /prima riga inattesa/);
});

test('prezzi: metano e L-GNC sì, GNL no, prezzi implausibili scartati', () => {
  const txt = 'Estrazione del 2026-11-21\nidImpianto|descCarburante|prezzo|isSelf|dtComu\n' +
    '3464|Benzina|1.939|1|20/11/2026 20:00:05\n' +
    '3464|Metano|1.944|0|20/11/2026 20:00:08\n' +
    '3464|Metano|1.899|1|19/11/2026 07:00:00\n' +
    '5000|L-GNC|1.750|1|18/11/2026 10:00:00\n' +
    '6000|GNL|1.500|1|18/11/2026 10:00:00\n' +
    '57122|Metano|0.100|0|19/11/2026 10:20:30\n';
  const { rows } = parsePrezzi(txt);
  assert.equal(rows.length, 6);
  const { byId, discarded } = collectMetanoPrices(rows);
  assert.deepEqual(byId.get('3464'), {
    metano: { servito: { p: 1.944, d: '2026-11-20T20:00:08' }, self: { p: 1.899, d: '2026-11-19T07:00:00' } },
  });
  assert.deepEqual(byId.get('5000'), { lgnc: { self: { p: 1.75, d: '2026-11-18T10:00:00' } } });
  assert.equal(byId.has('6000'), false);
  // impianto con prezzo errato: vende metano, ma senza prezzo
  assert.deepEqual(byId.get('57122'), {});
  assert.equal(discarded.length, 1);
});

test('metanoKind e parseDtComu', () => {
  assert.equal(metanoKind('Metano'), 'metano');
  assert.equal(metanoKind('L-GNC'), 'lgnc');
  assert.equal(metanoKind('GNL'), null);
  assert.equal(metanoKind('GPL'), null);
  assert.equal(parseDtComu('05/02/2026 07:03:09'), '2026-02-05T07:03:09');
  assert.equal(parseDtComu('boh'), null);
});

test('decodeMimit: UTF-8 e ripiego Windows-1252', () => {
  const utf8 = new TextEncoder().encode('CITTÀ SANT\'ANGELO');
  assert.equal(decodeMimit(utf8), 'CITTÀ SANT\'ANGELO');
  const latin = new Uint8Array(Array(30).fill(0xC0)); // "À" in Windows-1252, UTF-8 non valido
  assert.equal(decodeMimit(latin), 'À'.repeat(30));
});

test('OSM: solo fuel:cng=yes, centro per i way, orario metano prioritario', () => {
  const osm = parseOverpass({
    elements: [
      { type: 'node', id: 1, lat: 45, lon: 9, tags: { amenity: 'fuel', 'fuel:cng': 'yes', opening_hours: '24/7', self_service: 'yes' } },
      { type: 'way', id: 2, center: { lat: 44, lon: 10 }, tags: { amenity: 'fuel', 'fuel:cng': 'yes', opening_hours: '24/7', 'fuel:cng:opening_hours': 'Mo-Sa 07:00-20:00' } },
      { type: 'node', id: 3, lat: 43, lon: 11, tags: { amenity: 'fuel', 'fuel:cng': 'no' } },
    ],
  });
  assert.equal(osm.length, 2);
  assert.equal(osm[0].osmId, 'node/1');
  assert.equal(osm[0].selfService, true);
  assert.equal(osm[0].ohScope, 'impianto');
  assert.equal(osm[1].lat, 44);
  assert.equal(osm[1].oh, 'Mo-Sa 07:00-20:00');
  assert.equal(osm[1].ohScope, 'cng');
});

test('abbinamento: vicino sì, lontano no, marchio estende il raggio, 1:1', () => {
  // 0.001° di latitudine ≈ 111 m
  const mimit = [
    { id: 'a', lat: 45.0, lon: 9.0, bandiera: 'Agip Eni' },
    { id: 'b', lat: 45.0005, lon: 9.0, bandiera: 'Q8' },    // a ~56 m dallo stesso OSM di "a"
    { id: 'c', lat: 44.0, lon: 10.0, bandiera: 'Agip Eni' },
    { id: 'd', lat: 43.0, lon: 11.0, bandiera: 'Pompe Bianche' },
  ];
  const osm = [
    { osmId: 'node/1', lat: 45.0001, lon: 9.0, brand: 'Eni' },
    { osmId: 'node/2', lat: 44.002, lon: 10.0, brand: 'Eni' },   // ~222 m, stesso marchio
    { osmId: 'node/3', lat: 43.002, lon: 11.0, brand: 'Tamoil' }, // ~222 m, marchio diverso
  ];
  const r = matchStations(mimit, osm);
  assert.equal(r.get('a').osm.osmId, 'node/1');
  assert.equal(r.has('b'), false); // node/1 già preso dal più vicino
  assert.equal(r.get('c').osm.osmId, 'node/2');
  assert.equal(r.has('d'), false);
  assert.ok(sameBrand('Agip Eni', 'Eni'));
  assert.ok(!sameBrand('Pompe Bianche', 'Tamoil'));
});

test('buildStations: unione MIMIT + OSM e distributori solo OSM', () => {
  const anagrafica = [
    { id: '1', gestore: 'G', bandiera: 'Eni', autostradale: true, nome: 'N1', indirizzo: 'A1', comune: 'C', provincia: 'MI', lat: 45, lon: 9 },
    { id: '2', gestore: 'G', bandiera: 'Eni', autostradale: false, nome: 'N2', indirizzo: 'A2', comune: 'C', provincia: 'MI', lat: null, lon: null },
    { id: '3', gestore: 'G', bandiera: 'Eni', autostradale: false, nome: 'Solo benzina', indirizzo: 'A3', comune: 'C', provincia: 'MI', lat: 44, lon: 9 },
  ];
  const prices = new Map([['1', { metano: { self: { p: 1.9, d: 'x' } } }], ['2', {}]]);
  const osm = [
    { osmId: 'node/10', lat: 45.0002, lon: 9.0, name: 'Eni Milano', brand: 'Eni', oh: '24/7', ohScope: 'impianto', selfService: null, automated: null, phone: '+39 02 1', website: null, address: null, city: null, checkDate: null },
    { osmId: 'way/20', lat: 41, lon: 12, name: null, brand: 'IP', oh: null, ohScope: null, selfService: true, automated: null, phone: null, website: null, address: null, city: 'Roma', checkDate: null },
  ];
  const { stations, stats } = buildStations({ anagrafica, prices, osm });
  assert.equal(stations.length, 2);
  const [m, o] = stations;
  assert.equal(m.id, 'm1');
  assert.equal(m.src, 'mimit+osm');
  assert.equal(m.name, 'Eni Milano');
  assert.equal(m.highway, true);
  assert.equal(m.lat, 45.0002);
  assert.deepEqual(m.osm, { id: 'node/10', dist: 22, oh: '24/7', ohScope: 'impianto', phone: '+39 02 1' });
  assert.equal(o.id, 'oway:20');
  assert.equal(o.src, 'osm');
  assert.equal(o.prices, null);
  assert.deepEqual(stats, { mimitMetano: 2, mimitSenzaCoordinate: 1, osmCng: 2, abbinati: 1, soloOsm: 1, conOrari: 1, posizioneDubbia: 0 });
});

test('comuni: nomi normalizzati, bilingui, alias, omonimi', () => {
  const comuni = parseComuni({ elements: [
    { bounds: { minlat: 45.39, minlon: 9.04, maxlat: 45.54, maxlon: 9.28 }, tags: { name: 'Milano' } },
    { bounds: { minlat: 46.45, minlon: 11.28, maxlat: 46.53, maxlon: 11.41 }, tags: { name: 'Bolzano - Bozen', 'name:it': 'Bolzano' } },
    { bounds: { minlat: 44.62, minlon: 10.5, maxlat: 44.78, maxlon: 10.72 }, tags: { name: 'Reggio Emilia' } },
    { bounds: { minlat: 42.47, minlon: 14.1, maxlat: 42.55, maxlon: 14.2 }, tags: { name: "Città Sant'Angelo" } },
    { bounds: { minlat: 44.9, minlon: 8.0, maxlat: 45.0, maxlon: 8.1 }, tags: { name: 'Calliano' } },  // AT
    { bounds: { minlat: 45.9, minlon: 11.0, maxlat: 46.0, maxlon: 11.1 }, tags: { name: 'Calliano' } }, // TN
  ] });
  const idx = buildComuniIndex(comuni);
  assert.equal(normName("CITTÀ SANT'ANGELO"), 'CITTA SANT ANGELO');
  assert.equal(checkComune(idx, 'MILANO', 45.46, 9.19), 'ok');
  assert.equal(checkComune(idx, 'MILANO', 45.555, 9.19), 'ok');       // 1,7 km oltre il bordo: entro il margine
  assert.equal(checkComune(idx, 'MILANO', 45.565, 9.19), 'lontano');  // 2,8 km oltre il bordo
  assert.equal(checkComune(idx, 'BUSTO GAROLFO', 45.47, 9.20), 'sconosciuto');
  assert.equal(checkComune(idx, 'BOLZANO', 46.5, 11.35), 'ok');
  assert.equal(checkComune(idx, 'BOZEN', 46.5, 11.35), 'ok');
  assert.equal(checkComune(idx, "REGGIO NELL'EMILIA", 44.7, 10.6), 'ok');
  assert.equal(checkComune(idx, "CITTÀ SANT'ANGELO", 42.5, 14.15), 'ok');
  assert.equal(checkComune(idx, 'CALLIANO', 45.95, 11.05), 'ok');
  assert.equal(checkComune(idx, 'MILANO', 41.9, 12.5), 'lontano');
});

test('buildStations: coordinate lontane dal comune -> posizione dubbia, niente abbinamento OSM', () => {
  const idx = buildComuniIndex([{ names: ['BUSTO GAROLFO'], bbox: [45.47, 8.83, 45.52, 8.92] }]);
  const anagrafica = [
    { id: '61149', gestore: 'G', bandiera: 'Q8', autostradale: false, nome: 'BUSTO GAROLFO SP 109', indirizzo: 'SP 109', comune: 'BUSTO GAROLFO', provincia: 'MI', lat: 45.4689, lon: 9.2013 },
  ];
  const osm = [{ osmId: 'node/1', lat: 45.469, lon: 9.2014, name: 'Q8 Milano', brand: 'Q8', oh: '24/7', ohScope: 'impianto', selfService: null, automated: null, phone: null, website: null, address: null, city: null, checkDate: null }];
  const { stations, stats } = buildStations({ anagrafica, prices: new Map([['61149', {}]]), osm, comuniIdx: idx });
  assert.equal(stations[0].posDubbia, true);
  assert.equal(stations[0].src, 'mimit');
  assert.equal(stations[1].src, 'osm');
  assert.equal(stats.posizioneDubbia, 1);
});
