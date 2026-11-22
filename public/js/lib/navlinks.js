// Link per aprire il viaggio nel navigatore.
//
// Google Maps (URL "Maps URLs", api=1): partenza, destinazione e tappe intermedie.
// Sul telefono l'app di Google Maps accetta poche tappe per link: usiamo al massimo 3
// tappe intermedie e, se le soste sono di più, dividiamo il viaggio in tratti
// ("Tratto 1", "Tratto 2"...), dove ogni tratto parte dal punto in cui finisce il precedente.
//
// Waze: un link supporta una sola destinazione, quindi un pulsante per ogni sosta.

export const MAX_WAYPOINTS = 3;

const coord = (p) => `${Number(p.lat).toFixed(6)},${Number(p.lon).toFixed(6)}`;

/**
 * @param {{lat, lon}|null} origin  null = posizione attuale del telefono
 * @param {{lat, lon}} destination
 * @param {Array<{lat, lon}>} waypoints
 */
export function googleMapsUrl(origin, destination, waypoints = []) {
  const q = new URLSearchParams({ api: '1' });
  if (origin) q.set('origin', coord(origin));
  q.set('destination', coord(destination));
  if (waypoints.length) q.set('waypoints', waypoints.map(coord).join('|'));
  q.set('travelmode', 'driving');
  return `https://www.google.com/maps/dir/?${q}`;
}

export function wazeUrl(p) {
  return `https://waze.com/ul?ll=${coord(p)}&navigate=yes`;
}

/**
 * Divide [partenza, soste..., arrivo] in tratti con al massimo MAX_WAYPOINTS tappe intermedie.
 * @param {{lat, lon, label, current?: boolean}} from  current=true: parte dalla posizione del telefono
 * @param {{lat, lon, label}} to
 * @param {Array<{lat, lon, label}>} stops
 * @returns {Array<{index: number, from: string, to: string, url: string, stops: number}>}
 */
export function googleMapsLegs(from, to, stops, maxWaypoints = MAX_WAYPOINTS) {
  const points = [from, ...stops, to];
  const legs = [];
  const span = maxWaypoints + 1; // punti percorsi da un tratto (oltre a quello di partenza)
  for (let i = 0; i < points.length - 1; i += span) {
    const end = Math.min(i + span, points.length - 1);
    const origin = points[i];
    legs.push({
      index: legs.length + 1,
      from: origin.label,
      to: points[end].label,
      stops: end - i - 1,
      url: googleMapsUrl(i === 0 && origin.current ? null : origin, points[end], points.slice(i + 1, end)),
    });
  }
  return legs;
}
