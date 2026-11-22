// Funzioni geografiche condivise tra app (browser) e script dati (Node).

const R = 6371008.8; // raggio medio terrestre in metri
const RAD = Math.PI / 180;

/** Distanza in metri tra due punti {lat, lon} (formula dell'emisenoverso). */
export function haversine(a, b) {
  const dLat = (b.lat - a.lat) * RAD;
  const dLon = (b.lon - a.lon) * RAD;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Riquadro approssimativo dell'Italia (incluse isole, Lampedusa, Alto Adige). */
export const ITALY_BBOX = { minLat: 35.2, maxLat: 47.2, minLon: 6.5, maxLon: 18.6 };

export function inItaly(lat, lon) {
  return (
    Number.isFinite(lat) && Number.isFinite(lon) &&
    lat >= ITALY_BBOX.minLat && lat <= ITALY_BBOX.maxLat &&
    lon >= ITALY_BBOX.minLon && lon <= ITALY_BBOX.maxLon
  );
}
