// Service worker: app disponibile offline.
//  - guscio dell'app (HTML, CSS, JS, librerie): prima la cache, aggiornata in background
//  - data/metano.json: prima la rete (dati del giorno), la cache se offline
//  - tile della mappa e API esterne: non gestite (cache HTTP del browser)

// Cambiare VERSION (e APP_VERSION in js/app.js) a ogni modifica di HTML/CSS/JS:
// i telefoni scaricano il nuovo guscio e cancellano la cache precedente.
const VERSION = 'v8';
const SHELL = `shell-${VERSION}`;
const DATA = 'data';

const SHELL_FILES = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'js/app.js',
  'js/lib/geo.js', 'js/lib/corridor.js', 'js/lib/ors.js', 'js/lib/festivi.js',
  'js/lib/opening.js', 'js/lib/planner.js', 'js/lib/trip.js', 'js/lib/navlinks.js', 'js/lib/google.js',
  'js/ui/autocomplete.js', 'js/ui/format.js', 'js/ui/mapview.js', 'js/ui/render.js',
  'js/ui/store.js', 'js/ui/viewmodel.js',
  'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css',
  'vendor/leaflet/images/marker-icon.png', 'vendor/leaflet/images/marker-shadow.png',
  'vendor/opening_hours/opening_hours.js', 'vendor/suncalc/suncalc.js',
  'icons/icon.svg', 'icons/icon-192.png',
];

self.addEventListener('install', (e) => {
  // cache: 'reload' scavalca la cache HTTP del browser (GitHub Pages la tiene 10 minuti):
  // senza, una nuova versione potrebbe mescolare file nuovi e vecchi.
  e.waitUntil(
    caches.open(SHELL)
      .then((c) => c.addAll(SHELL_FILES.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== DATA).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  if (url.pathname.endsWith('/data/metano.json')) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(DATA).then((c) => c.put('data/metano.json', copy));
          }
          return res;
        })
        .catch(() => caches.match('data/metano.json', { cacheName: DATA }).then((r) => r ?? Response.error())),
    );
    return;
  }

  // in locale (sviluppo) sempre la rete, per vedere subito le modifiche
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') return;

  // stale-while-revalidate per il guscio
  e.respondWith(
    caches.open(SHELL).then(async (cache) => {
      const cached = await cache.match(e.request, { ignoreSearch: true });
      const network = fetch(e.request, { cache: 'no-cache' }) // ricontrolla sempre col server
        .then((res) => {
          if (res.ok) cache.put(e.request, res.clone());
          return res;
        })
        .catch(() => cached ?? Response.error());
      return cached ?? network;
    }),
  );
});
