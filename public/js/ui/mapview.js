// Mappa Leaflet con tile OpenStreetMap: percorso, soste, riserve, altri distributori.
import { esc, fmtTime, STATUS_INFO } from './format.js';

const STATUS_COLOR = { aperto: '#1a7f3c', probabile: '#c98a00', sconosciuto: '#6b7570', chiuso: '#b3261e' };

export class MapView {
  constructor(el) {
    this.el = el;
    this.map = null;
    this.layer = null;
  }

  #ensure() {
    if (this.map) return;
    const L = window.L;
    this.map = L.map(this.el, { zoomControl: true, attributionControl: true });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(this.map);
    this.layer = L.layerGroup().addTo(this.map);
  }

  #pin(lat, lon, html, cls, title, popup, size = 30) {
    const L = window.L;
    const m = L.marker([lat, lon], {
      icon: L.divIcon({ className: '', html: `<div class="pin ${cls}">${html}</div>`, iconSize: [size, size], iconAnchor: [size / 2, size / 2] }),
      title,
      keyboard: true,
    });
    if (popup) m.bindPopup(popup);
    return m.addTo(this.layer);
  }

  show(vm, { onStopClick } = {}) {
    if (!window.L) return; // Leaflet non caricato (offline al primo avvio)
    this.#ensure();
    const L = window.L;
    this.layer.clearLayers();

    const line = L.polyline(vm.route.coords, { color: '#1f6feb', weight: 5, opacity: 0.8 }).addTo(this.layer);
    for (const seg of vm.petrolSegments ?? []) {
      L.polyline(seg.pts, { color: '#f08c00', weight: 7, opacity: 0.95 })
        .bindPopup(`<strong>⛽ Tratto a benzina</strong><br>km ${Math.round(seg.fromKm)}–${Math.round(seg.toKm)}`)
        .addTo(this.layer);
    }

    for (const o of vm.others ?? []) {
      L.circleMarker([o.lat, o.lon], {
        radius: 5, color: '#fff', weight: 1, fillColor: STATUS_COLOR[o.status], fillOpacity: 0.85,
      })
        .bindPopup(`<strong>${esc(o.name)}</strong><br>${esc(o.city ?? '')} · km ${Math.round(o.km)}<br>${STATUS_INFO[o.status].icon} ${esc(STATUS_INFO[o.status].label)} al passaggio (stima)<br><small>${esc(o.sourceLabel)}</small>`)
        .addTo(this.layer);
    }

    const [a, b] = [vm.route.coords[0], vm.route.coords[vm.route.coords.length - 1]];
    this.#pin(a[0], a[1], 'A', 'end', 'Partenza', `<strong>Partenza</strong><br>${esc(vm.from.label)}`);
    this.#pin(b[0], b[1], 'B', 'end', 'Arrivo', `<strong>Arrivo</strong><br>${esc(vm.to.label)}`);

    if (vm.ok) {
      for (const s of vm.stops) {
        if (s.backup) {
          const bs = s.backup.station;
          this.#pin(bs.lat, bs.lon, `R${s.n}`, `backup ${s.backup.evaluation.status}`, `Riserva ${s.n}`,
            `<strong>Riserva della sosta ${s.n}</strong><br>${esc(bs.name)}<br>${STATUS_INFO[s.backup.evaluation.status].icon} ${esc(STATUS_INFO[s.backup.evaluation.status].label)}`, 22);
        }
      }
      for (const s of vm.stops) {
        const st = s.station;
        const m = this.#pin(st.lat, st.lon, String(s.n), s.evaluation.status, `Sosta ${s.n}`,
          `<strong>${s.n}. ${esc(st.name)}</strong><br>${fmtTime(s.eta)} · km ${Math.round(s.km)}<br>${STATUS_INFO[s.evaluation.status].icon} ${esc(STATUS_INFO[s.evaluation.status].label)}`);
        if (onStopClick) m.on('click', () => onStopClick(s.n));
      }
    } else {
      const c = vm.critical;
      if (c.reachPoint) {
        this.#pin(c.reachPoint.lat, c.reachPoint.lon, '!', 'critical', 'Limite di autonomia',
          `<strong>Limite di autonomia</strong><br>Oltre questo punto (km ${Math.round(c.reachKm)}) non ci sono distributori utilizzabili raggiungibili.`);
      }
      for (const x of c.closedInRange) {
        this.#pin(x.station.lat, x.station.lon, '×', 'chiuso', x.station.name,
          `<strong>${esc(x.station.name)}</strong><br>Chiuso alle ${fmtTime(x.eta)}`, 24);
      }
    }

    // la mappa può essere stata nascosta: ricalcola le dimensioni prima di inquadrare
    setTimeout(() => {
      this.map.invalidateSize();
      this.map.fitBounds(line.getBounds(), { padding: [24, 24] });
    }, 0);
  }

  focus(lat, lon) {
    if (!this.map) return;
    this.map.setView([lat, lon], Math.max(this.map.getZoom(), 13));
  }
}
