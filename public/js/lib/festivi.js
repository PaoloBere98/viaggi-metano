// Festività nazionali italiane (L. 260/1949 e successive modifiche).
// Il 4 ottobre (San Francesco d'Assisi) è di nuovo festa nazionale dal 2026.
// Le feste patronali locali (es. Sant'Ambrogio a Milano) NON sono incluse: non sono
// nazionali e nessuna fonte affidabile le collega agli orari dei distributori.

/** Domenica di Pasqua (calendario gregoriano, algoritmo anonimo di Meeus/Jones/Butcher). */
export function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

const pad = (n) => String(n).padStart(2, '0');
const key = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

/** Elenco delle festività nazionali dell'anno: [{date: 'AAAA-MM-GG', name}] in ordine. */
export function nationalHolidays(year) {
  const list = [
    [1, 1, 'Capodanno'],
    [1, 6, 'Epifania'],
    [4, 25, 'Festa della Liberazione'],
    [5, 1, 'Festa del Lavoro'],
    [6, 2, 'Festa della Repubblica'],
    [8, 15, 'Ferragosto'],
    [11, 1, 'Ognissanti'],
    [12, 8, 'Immacolata Concezione'],
    [12, 25, 'Natale'],
    [12, 26, 'Santo Stefano'],
  ];
  if (year >= 2026) list.push([10, 4, "San Francesco d'Assisi"]);
  const e = easterSunday(year);
  list.push([e.month, e.day, 'Pasqua']);
  // Lunedì dell'Angelo: giorno dopo Pasqua (calcolato in UTC per evitare l'ora legale)
  const mon = new Date(Date.UTC(year, e.month - 1, e.day + 1));
  list.push([mon.getUTCMonth() + 1, mon.getUTCDate(), "Lunedì dell'Angelo (Pasquetta)"]);
  return list
    .map(([m, d, name]) => ({ date: key(year, m, d), name }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

const cache = new Map();

/** Chiave AAAA-MM-GG del giorno di calendario in Italia per un istante. */
export function italianDateKey(date) {
  // en-CA formatta come AAAA-MM-GG
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

/**
 * Festività nazionale nel giorno (ora italiana) dell'istante dato, oppure null.
 * @param {Date} date
 * @returns {{date: string, name: string} | null}
 */
export function holidayOn(date) {
  const k = italianDateKey(date);
  const y = Number(k.slice(0, 4));
  if (!cache.has(y)) cache.set(y, new Map(nationalHolidays(y).map((h) => [h.date, h])));
  return cache.get(y).get(k) ?? null;
}

/** Giorno della settimana in Italia: 0 = domenica ... 6 = sabato. */
export function italianWeekday(date) {
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Rome', weekday: 'short' }).format(date);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd);
}

/** Domenica o festività nazionale: i giorni in cui molti distributori sono chiusi. */
export function isSundayOrHoliday(date) {
  return italianWeekday(date) === 0 || holidayOn(date) !== null;
}
