#!/usr/bin/env node
// Copia in public/vendor/ le librerie usate dal browser (niente CDN: l'app funziona offline
// e non dipende da servizi esterni). Da rilanciare dopo un aggiornamento delle dipendenze:
//   npm install && npm run vendor

import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NM = join(ROOT, 'node_modules');
const OUT = join(ROOT, 'public', 'vendor');

const files = [
  ['leaflet/dist/leaflet.js', 'leaflet/leaflet.js'],
  ['leaflet/dist/leaflet.css', 'leaflet/leaflet.css'],
  ['leaflet/dist/images', 'leaflet/images'],
  ['leaflet/LICENSE', 'leaflet/LICENSE'],
  // .js invece di .mjs: alcuni hosting servono .mjs con un tipo MIME sbagliato
  ['opening_hours/build/opening_hours.esm.mjs', 'opening_hours/opening_hours.js'],
  ['opening_hours/LICENSES/LGPL-3.0-only.txt', 'opening_hours/LICENSE.txt'],
  ['suncalc/index.js', 'suncalc/suncalc.js'],
  ['suncalc/LICENSE', 'suncalc/LICENSE'],
];

await rm(OUT, { recursive: true, force: true });
for (const [from, to] of files) {
  const dest = join(OUT, to);
  await mkdir(dirname(dest), { recursive: true });
  await cp(join(NM, from), dest, { recursive: true });
  console.log(`${from} -> public/vendor/${to}`);
}
