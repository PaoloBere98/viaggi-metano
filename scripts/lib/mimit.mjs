// Parser dei file open data MIMIT (anagrafica_impianti_attivi.csv, prezzo_alle_8.csv).
//
// Formato verificato il 22/11/2026 (metadati MIMIT del 28/01/2026, in vigore dal 10/02/2026):
//  - riga 1: "Estrazione del AAAA-MM-GG"
//  - riga 2: intestazione
//  - separatore di campo "|", decimali con il punto, UTF-8
// Anomalie reali trovate nei file:
//  - ~115 righe di anagrafica contengono "|" dentro i campi (es. " | gestori.prezzibenzina.it")
//  - tabulazioni e spazi multipli nei nomi/indirizzi
//  - coordinate mancanti o fuori dall'Italia (sono inserite dai gestori e non verificate)
//  - prezzi del metano palesemente errati (0,100 €/kg, 4,999 €/kg)

import { inItaly } from '../../public/js/lib/geo.js';

export const ANAGRAFICA_HEADER = [
  'idImpianto', 'Gestore', 'Bandiera', 'Tipo Impianto', 'Nome Impianto',
  'Indirizzo', 'Comune', 'Provincia', 'Latitudine', 'Longitudine',
];
export const PREZZI_HEADER = ['idImpianto', 'descCarburante', 'prezzo', 'isSelf', 'dtComu'];

/** Intervallo plausibile del prezzo del metano in €/kg: fuori da qui il dato viene scartato. */
export const METANO_PRICE_RANGE = { min: 0.8, max: 3.5 };

const SEP = '|';
const JUNK = /(?:\s*\|)+\s*gestori\.prezzibenzina\.it/gi;

/** Decodifica i byte del file: UTF-8, con ripiego su Windows-1252 se il testo risulta corrotto. */
export function decodeMimit(buffer) {
  const utf8 = new TextDecoder('utf-8').decode(buffer);
  const bad = (utf8.match(/�/g) || []).length;
  if (bad > 20) return new TextDecoder('windows-1252').decode(buffer);
  return utf8;
}

function clean(s) {
  return (s ?? '').replace(/[\t ]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function splitLines(text) {
  return text.replace(/^﻿/, '').split(/\r?\n/);
}

/**
 * Legge le prime due righe, verifica l'intestazione e restituisce la data di estrazione
 * e le righe dati (non ancora divise).
 * Lancia un errore se il formato non è quello atteso: meglio fallire che produrre dati sbagliati.
 */
function readHeader(text, expected, fileName) {
  const lines = splitLines(text);
  const m = /^Estrazione del (\d{4}-\d{2}-\d{2})/.exec(lines[0] ?? '');
  if (!m) throw new Error(`${fileName}: prima riga inattesa: "${(lines[0] ?? '').slice(0, 60)}"`);
  const header = (lines[1] ?? '').split(SEP).map(clean);
  const norm = (a) => a.map((h) => h.toLowerCase());
  if (norm(header).join(SEP) !== norm(expected).join(SEP)) {
    throw new Error(
      `${fileName}: intestazione cambiata.\n  attesa:  ${expected.join(SEP)}\n  trovata: ${header.join(SEP)}`,
    );
  }
  return { extractionDate: m[1], lines: lines.slice(2).filter((l) => l.trim() !== '') };
}

function parseCoord(s) {
  const v = Number.parseFloat(clean(s).replace(',', '.'));
  return Number.isFinite(v) && v !== 0 ? v : null;
}

/**
 * Parser di anagrafica_impianti_attivi.csv.
 * @returns {{extractionDate: string, rows: object[], warnings: string[]}}
 */
export function parseAnagrafica(text) {
  const { extractionDate, lines } = readHeader(text, ANAGRAFICA_HEADER, 'anagrafica');
  const rows = [];
  const warnings = [];
  for (const raw of lines) {
    let f = raw.replace(JUNK, '').split(SEP);
    if (f.length < ANAGRAFICA_HEADER.length) {
      warnings.push(`riga con ${f.length} campi ignorata: ${raw.slice(0, 80)}`);
      continue;
    }
    if (f.length > ANAGRAFICA_HEADER.length) {
      // Campi fissi: 4 da sinistra (id, gestore, bandiera, tipo) e 4 da destra
      // (comune, provincia, lat, lon). In mezzo: nome e indirizzo, con "|" spurie.
      const left = f.slice(0, 4);
      const right = f.slice(-4);
      const mid = f.slice(4, -4);
      const nome = mid.slice(0, -1).join(' ');
      const indirizzo = mid[mid.length - 1];
      warnings.push(`id ${f[0]}: ${f.length} campi, ricostruito nome/indirizzo`);
      f = [...left, nome, indirizzo, ...right];
    }
    const [id, gestore, bandiera, tipo, nome, indirizzo, comune, provincia, latS, lonS] = f.map(clean);
    if (!/^\d+$/.test(id)) {
      warnings.push(`id non numerico ignorato: ${raw.slice(0, 80)}`);
      continue;
    }
    let lat = parseCoord(latS);
    let lon = parseCoord(lonS);
    if (lat !== null && lon !== null && !inItaly(lat, lon) && inItaly(lon, lat)) {
      [lat, lon] = [lon, lat]; // coordinate invertite dal gestore
    }
    if (lat === null || lon === null || !inItaly(lat, lon)) {
      lat = null;
      lon = null;
    }
    rows.push({
      id,
      gestore,
      bandiera,
      autostradale: /^autostrad/i.test(tipo),
      nome,
      indirizzo,
      comune,
      provincia,
      lat,
      lon,
    });
  }
  return { extractionDate, rows, warnings };
}

/** "20/11/2026 20:00:07" -> "2026-11-20T20:00:07" (ora locale italiana). */
export function parseDtComu(s) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}):(\d{2}))?/.exec(clean(s));
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}T${m[4] ?? '00'}:${m[5] ?? '00'}:${m[6] ?? '00'}`;
}

/**
 * Parser di prezzo_alle_8.csv.
 * @returns {{extractionDate: string, rows: object[], warnings: string[]}}
 */
export function parsePrezzi(text) {
  const { extractionDate, lines } = readHeader(text, PREZZI_HEADER, 'prezzi');
  const rows = [];
  const warnings = [];
  for (const raw of lines) {
    const f = raw.split(SEP).map(clean);
    if (f.length !== PREZZI_HEADER.length) {
      warnings.push(`riga prezzi con ${f.length} campi ignorata: ${raw.slice(0, 80)}`);
      continue;
    }
    const [id, carburante, prezzoS, selfS, dt] = f;
    const prezzo = Number.parseFloat(prezzoS);
    if (!/^\d+$/.test(id) || !Number.isFinite(prezzo)) {
      warnings.push(`riga prezzi non valida: ${raw.slice(0, 80)}`);
      continue;
    }
    rows.push({ id, carburante, prezzo, self: selfS === '1', dtComu: parseDtComu(dt) });
  }
  return { extractionDate, rows, warnings };
}

/**
 * Tipo di metano per autotrazione: "Metano" (GNC) oppure "L-GNC" (metano liquefatto
 * erogato compresso, utilizzabile dalle auto a metano). Il GNL (liquido, per camion) è escluso.
 * @returns {'metano'|'lgnc'|null}
 */
export function metanoKind(carburante) {
  const c = clean(carburante).toLowerCase();
  if (/^l-?gnc\b/.test(c)) return 'lgnc';
  if (/^(metano|gnc|cng)\b/.test(c)) return 'metano';
  return null;
}

/**
 * Raggruppa per impianto i prezzi del metano, scartando i valori implausibili.
 * @returns {{byId: Map<string, object>, discarded: object[]}}
 *   byId: id -> { metano?: {self?: {p, d}, servito?: {p, d}}, lgnc?: {...} }
 */
export function collectMetanoPrices(prezziRows) {
  const byId = new Map();
  const discarded = [];
  for (const r of prezziRows) {
    const kind = metanoKind(r.carburante);
    if (!kind) continue;
    if (r.prezzo < METANO_PRICE_RANGE.min || r.prezzo > METANO_PRICE_RANGE.max) {
      discarded.push(r);
      // L'impianto vende comunque metano: lo registriamo senza prezzo.
      if (!byId.has(r.id)) byId.set(r.id, {});
      continue;
    }
    const entry = byId.get(r.id) ?? {};
    entry[kind] ??= {};
    const mode = r.self ? 'self' : 'servito';
    const prev = entry[kind][mode];
    if (!prev || (r.dtComu ?? '') > (prev.d ?? '')) {
      entry[kind][mode] = { p: r.prezzo, d: r.dtComu };
    }
    byId.set(r.id, entry);
  }
  return { byId, discarded };
}
