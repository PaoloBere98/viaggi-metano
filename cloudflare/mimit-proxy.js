// Cloudflare Worker: scarica i file open data del MIMIT al posto di GitHub Actions,
// i cui server vengono rifiutati dal sito del ministero.
//
// Uso (da GitHub Actions):
//   curl -H "X-Proxy-Token: <segreto>" https://<worker>.workers.dev/prezzo_alle_8.csv
//
// Configurazione nel pannello Cloudflare: segreto PROXY_TOKEN (Settings -> Variables and Secrets).
// Il worker serve solo i due file MIMIT e solo a chi conosce il segreto: non è un proxy aperto.

const MIMIT_BASE = 'https://www.mimit.gov.it/images/exportCSV/';
const FILES = new Set(['anagrafica_impianti_attivi.csv', 'prezzo_alle_8.csv']);

/** Confronto a tempo costante, per non rivelare il segreto con i tempi di risposta. */
function sameSecret(a, b) {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export default {
  async fetch(request, env) {
    if (request.method !== 'GET') return new Response('Metodo non consentito', { status: 405 });
    const name = new URL(request.url).pathname.replace(/^\/+/, '');
    if (!FILES.has(name)) return new Response('Non trovato', { status: 404 });
    if (!env.PROXY_TOKEN || !sameSecret(request.headers.get('x-proxy-token') ?? '', env.PROXY_TOKEN)) {
      return new Response('Non autorizzato', { status: 401 });
    }
    let upstream;
    try {
      upstream = await fetch(MIMIT_BASE + name, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; viaggi-metano-proxy/1.0)' },
      });
    } catch (e) {
      return new Response(`MIMIT non raggiungibile: ${e.message}`, { status: 502 });
    }
    if (!upstream.ok) return new Response(`MIMIT ha risposto ${upstream.status}`, { status: 502 });
    return new Response(upstream.body, {
      status: 200,
      headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  },
};
