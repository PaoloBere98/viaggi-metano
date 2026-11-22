// Accesso a localStorage sempre protetto: in navigazione privata o con i dati del sito
// bloccati può non funzionare, e l'app deve restare utilizzabile.

const PREFIX = 'vm.';

export function load(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function save(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function remove(key) {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch { /* ignorato */ }
}

export const DEFAULT_SETTINGS = Object.freeze({
  orsKey: '',
  googleKey: '',
  rangeKm: 350,
  safetyPct: 75,
  maxDistKm: 5,
  consumptionKgPer100: 4.0,
  petrolKm: 100,
  allowPetrol: true,
});

export function loadSettings() {
  return { ...DEFAULT_SETTINGS, ...load('settings', {}) };
}

export function saveSettings(s) {
  return save('settings', s);
}

/** Segnalazioni personali: { [stationId]: {type, date, name} } */
export function loadReports() {
  return load('reports', {});
}

export function saveReports(r) {
  return save('reports', r);
}
