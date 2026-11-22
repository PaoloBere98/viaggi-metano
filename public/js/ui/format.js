// Formattazione in italiano (ora di Roma).

const TZ = 'Europe/Rome';
const timeFmt = new Intl.DateTimeFormat('it-IT', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('it-IT', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' });
const dateFmt = new Intl.DateTimeFormat('it-IT', { timeZone: TZ, day: 'numeric', month: 'long', year: 'numeric' });
const num1 = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 1 });
const num0 = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 0 });
const eur = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' });
const eur3 = new Intl.NumberFormat('it-IT', { minimumFractionDigits: 3, maximumFractionDigits: 3 });

export const fmtTime = (d) => timeFmt.format(new Date(d));
export const fmtDay = (d) => dayFmt.format(new Date(d));
export const fmtDayTime = (d) => `${fmtDay(d)}, ${fmtTime(d)}`;
export const fmtKm = (km) => `${km < 10 ? num1.format(km) : num0.format(km)} km`;
export const fmtEuro = (v) => (v == null ? '—' : eur.format(v));
export const fmtPrice = (v) => (v == null ? '—' : `${eur3.format(v)} €/kg`);

/** "2026-11-21" o ISO completo -> "21 novembre 2026" */
export function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s.length === 10 ? `${s}T12:00:00` : s);
  return Number.isNaN(d.getTime()) ? s : dateFmt.format(d);
}

export function fmtDuration(sec) {
  const m = Math.round(sec / 60);
  const h = Math.floor(m / 60);
  return h ? `${h} h ${String(m % 60).padStart(2, '0')} min` : `${m} min`;
}

export const STATUS_INFO = {
  aperto: { icon: '✅', label: 'Aperto confermato' },
  probabile: { icon: '🟡', label: 'Probabilmente aperto' },
  sconosciuto: { icon: '⚪', label: 'Orario sconosciuto' },
  chiuso: { icon: '❌', label: 'Chiuso' },
};

/** Escape per inserire testo in HTML. */
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Valore per <input type="datetime-local"> in ora locale del dispositivo. */
export function toLocalInputValue(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
