// Controller dell'app: form, calcolo, rendering, segnalazioni, impostazioni.
import { OrsClient } from './lib/ors.js';
import { planTrip } from './lib/trip.js';
import { evaluateStation, REPORT } from './lib/opening.js';
import { holidayOn, italianWeekday, italianDateKey } from './lib/festivi.js';
import { attachAutocomplete } from './ui/autocomplete.js';
import { buildViewModel } from './ui/viewmodel.js';
import { renderSummary, renderStops, renderReportsList } from './ui/render.js';
import { MapView } from './ui/mapview.js';
import { fmtDate, fmtDayTime, fmtKm, toLocalInputValue } from './ui/format.js';
import * as store from './ui/store.js';

const $ = (id) => document.getElementById(id);
const DATA_MAX_AGE_DAYS = 3;

const state = {
  data: null,
  settings: store.loadSettings(),
  reports: store.loadReports(),
  places: { from: null, to: null },
  live: null, // {route, from, to, departure, startKm, settings, detourCache}
  vm: null,
  map: null,
  geo: null, // ultima posizione nota, per dare priorità ai suggerimenti vicini
};

// ---------------------------------------------------------------- messaggi

function showMessage(text, kind = 'info') {
  const el = $('message');
  el.textContent = text;
  el.className = `message ${kind}`;
  el.hidden = !text;
}
const clearMessage = () => showMessage('');

// ---------------------------------------------------------------- dati

async function loadData() {
  try {
    const res = await fetch('data/metano.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.data = await res.json();
    const prices = state.data.stations
      .map((s) => s.prices?.metano?.self?.p ?? s.prices?.metano?.servito?.p)
      .filter(Boolean);
    state.data.avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
    renderDataInfo();
  } catch (e) {
    $('data-info').textContent = `Dati dei distributori non disponibili (${e.message}). Serve una connessione al primo avvio.`;
  }
}

function dataInfoText() {
  const d = state.data;
  if (!d) return 'Dati non caricati.';
  const m = d.sources.mimit.prezzi;
  const o = d.sources.osm.timestamp?.slice(0, 10);
  return `${d.stations.length} distributori a metano · prezzi MIMIT del ${fmtDate(m)} · OpenStreetMap del ${fmtDate(o)}`;
}

function renderDataInfo() {
  const d = state.data;
  let text = dataInfoText();
  const ageDays = (Date.now() - Date.parse(`${d.sources.mimit.prezzi}T08:00:00`)) / 86_400_000;
  if (ageDays > DATA_MAX_AGE_DAYS) text += ` — ⚠️ dati vecchi di ${Math.floor(ageDays)} giorni`;
  $('data-info').textContent = text;
}

// ---------------------------------------------------------------- form

function ors() {
  return new OrsClient(state.settings.orsKey.trim());
}

function readOptions() {
  const num = (id, def) => {
    const v = Number.parseFloat($(id).value.replace(',', '.'));
    return Number.isFinite(v) ? v : def;
  };
  const s = state.settings;
  s.rangeKm = Math.min(1500, Math.max(50, num('range', s.rangeKm)));
  s.safetyPct = Math.min(95, Math.max(40, num('safety', s.safetyPct)));
  s.maxDistKm = Math.min(20, Math.max(0.5, num('maxdist', s.maxDistKm)));
  s.consumptionKgPer100 = Math.min(10, Math.max(2, num('consumption', s.consumptionKgPer100)));
  s.petrolKm = Math.min(1000, Math.max(0, num('petrol', s.petrolKm)));
  s.allowPetrol = $('allow-petrol').checked;
  return s;
}

function startKmFromForm() {
  const v = Number.parseFloat($('tank').value.replace(',', '.'));
  if (!Number.isFinite(v) || v < 0) return null;
  const range = state.settings.rangeKm;
  return $('tank-unit').value === 'pct' ? (Math.min(v, 100) / 100) * range : Math.min(v, range);
}

function updateHints() {
  readOptions();
  const s = state.settings;
  const startKm = startKmFromForm();
  $('tank-hint').textContent = startKm == null ? '' : `≈ ${fmtKm(startKm)} di autonomia a metano`;
  const maxLeg = (s.rangeKm * s.safetyPct) / 100;
  $('options-hint').textContent = `Tratta massima dopo un pieno: ${fmtKm(maxLeg)}; arriverai a ogni sosta con almeno ${fmtKm(s.rangeKm - maxLeg)}.`;
  const when = new Date($('when').value);
  if (Number.isNaN(when.getTime())) {
    $('when-hint').textContent = '';
  } else {
    const h = holidayOn(when);
    $('when-hint').textContent = h ? `🎉 Festivo: ${h.name}` : italianWeekday(when) === 0 ? 'Domenica' : '';
  }
}

function fillForm() {
  const s = state.settings;
  $('range').value = s.rangeKm;
  $('safety').value = s.safetyPct;
  $('maxdist').value = s.maxDistKm;
  $('consumption').value = s.consumptionKgPer100;
  $('petrol').value = s.petrolKm;
  $('allow-petrol').checked = s.allowPetrol;
  const f = store.load('form', null);
  if (f) {
    if (f.from) { $('from').value = f.from.label; state.places.from = f.from; }
    if (f.to) { $('to').value = f.to.label; state.places.to = f.to; }
    $('tank').value = f.tank ?? 100;
    $('tank-unit').value = f.tankUnit ?? 'pct';
  } else {
    $('tank').value = 100;
  }
  const now = new Date();
  now.setSeconds(0, 0);
  now.setMinutes(Math.ceil(now.getMinutes() / 5) * 5);
  $('when').value = toLocalInputValue(now);
  updateHints();
}

function setupAutocomplete() {
  const make = (key) =>
    attachAutocomplete($(key), $(`${key}-list`), {
      search: (text, signal) => ors().autocomplete(text, { signal, focus: state.geo ?? undefined }),
      onSelect: (place) => { state.places[key] = place; },
      onError: (e) => showMessage(e.message, 'error'),
    });
  return { from: make('from'), to: make('to') };
}

function useCurrentPosition() {
  if (!navigator.geolocation) {
    showMessage('Questo dispositivo non fornisce la posizione.', 'error');
    return;
  }
  showMessage('Cerco la tua posizione…', 'busy');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const p = { label: 'Posizione attuale', lat: pos.coords.latitude, lon: pos.coords.longitude };
      state.geo = { lat: p.lat, lon: p.lon };
      state.places.from = p;
      $('from').value = p.label;
      clearMessage();
    },
    (err) => showMessage(err.code === 1 ? 'Permesso di posizione negato.' : 'Posizione non disponibile.', 'error'),
    { enableHighAccuracy: false, timeout: 15000, maximumAge: 300000 },
  );
}

// ---------------------------------------------------------------- calcolo

function evaluator() {
  const ctx = { reports: state.reports, osmTimestamp: state.data?.sources.osm.timestamp };
  return (station, when) => evaluateStation(station, when, ctx);
}

/** Client ORS con memoria delle deviazioni già misurate (per ripianificare senza rifare richieste). */
function measuringClient(cache) {
  const client = ors();
  return {
    async measureDetour(route, c) {
      const hit = cache.get(c.station.id);
      if (hit) return hit;
      const d = await client.measureDetour(route, c);
      cache.set(c.station.id, d);
      return d;
    },
  };
}

async function runPlan() {
  const L = state.live;
  const evaluate = evaluator();
  const result = await planTrip({
    route: L.route,
    stations: state.data.stations,
    departure: L.departure,
    startKm: L.startKm,
    settings: {
      rangeKm: L.settings.rangeKm,
      safety: L.settings.safetyPct / 100,
      maxDistKm: L.settings.maxDistKm,
      consumptionKgPer100: L.settings.consumptionKgPer100,
      allowPetrol: L.settings.allowPetrol,
      petrolKm: L.settings.petrolKm,
    },
    evaluate,
    ors: measuringClient(L.detourCache),
    fallbackPrice: state.data.avgPrice,
    onProgress: (m) => showMessage(m, 'busy'),
  });
  const vm = buildViewModel({
    from: L.from, to: L.to, departure: L.departure, startKm: L.startKm,
    settings: { ...L.settings, orsKey: undefined }, route: L.route, result, evaluate,
  });
  showResult(vm);
  store.save('lastPlan', vm);
}

async function onSubmit(ev, ac) {
  ev.preventDefault();
  if (!state.data) {
    showMessage('Dati dei distributori non disponibili: controlla la connessione e ricarica.', 'error');
    return;
  }
  if (!state.settings.orsKey.trim()) {
    openSettings('Per calcolare il percorso serve una chiave OpenRouteService (gratuita).');
    return;
  }
  const settings = { ...readOptions() };
  const startKm = startKmFromForm();
  const departure = new Date($('when').value);
  if (startKm == null) return showMessage('Indica quanto metano hai nel serbatoio.', 'error');
  if (Number.isNaN(departure.getTime())) return showMessage('Indica data e ora di partenza.', 'error');

  const btn = $('btn-plan');
  btn.disabled = true;
  try {
    showMessage('Cerco gli indirizzi…', 'busy');
    const from = state.places.from ?? (await ac.from.resolveFirst());
    const to = state.places.to ?? (await ac.to.resolveFirst());
    if (!from) throw new Error('Partenza non trovata: scegli un indirizzo dai suggerimenti.');
    if (!to) throw new Error('Arrivo non trovato: scegli un indirizzo dai suggerimenti.');
    state.places = { from, to };
    store.save('form', { from, to, tank: $('tank').value, tankUnit: $('tank-unit').value });
    store.saveSettings(state.settings);

    showMessage('Calcolo il percorso…', 'busy');
    const route = await ors().route(from, to);
    state.live = { route, from, to, departure, startKm, settings, detourCache: new Map() };
    showMessage('Cerco i distributori aperti lungo il percorso…', 'busy');
    await runPlan();
    clearMessage();
    $('result').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    showMessage(e.message || String(e), 'error');
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------- risultato

function showResult(vm) {
  state.vm = vm;
  $('result').hidden = false;
  renderSummary(vm, $('summary'));
  renderStops(vm, $('stops'), state.reports);
  state.map ??= new MapView($('map'));
  state.map.show(vm, {
    onStopClick: (n) => $(`stop-${n}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
  });
  document.dispatchEvent(new CustomEvent('plan-rendered', { detail: vm }));
}

async function onReportClick(btn) {
  const { id, name, report: type } = btn.dataset;
  const current = state.reports[id];
  if (current?.type === type) {
    delete state.reports[id];
  } else {
    state.reports[id] = { type, date: italianDateKey(new Date()), name };
  }
  store.saveReports(state.reports);
  if (state.live) {
    try {
      showMessage('Aggiorno il piano con la tua segnalazione…', 'busy');
      await runPlan();
      clearMessage();
    } catch (e) {
      showMessage(e.message, 'error');
    }
  } else if (state.vm) {
    renderStops(state.vm, $('stops'), state.reports);
    showMessage('Segnalazione salvata. Ricalcola il piano per tenerne conto.');
  }
}

// ---------------------------------------------------------------- impostazioni

function openSettings(reason) {
  $('ors-key').value = state.settings.orsKey;
  $('settings-reason').textContent = reason ?? '';
  $('settings-reason').hidden = !reason;
  renderReportsList(state.reports, $('reports-list'));
  $('settings-data').textContent = dataInfoText();
  $('settings').showModal();
}

function setupSettings() {
  $('btn-settings').addEventListener('click', () => openSettings());
  $('settings-form').addEventListener('submit', (e) => {
    if (e.submitter?.value !== 'save') return; // chiusura senza salvare
    state.settings.orsKey = $('ors-key').value.trim();
    store.saveSettings(state.settings);
  });
  $('settings').addEventListener('click', (e) => {
    const t = e.target.closest('[data-toggle-visibility]');
    if (t) {
      const input = $(t.dataset.toggleVisibility);
      input.type = input.type === 'password' ? 'text' : 'password';
    }
    const r = e.target.closest('[data-remove-report]');
    if (r) {
      delete state.reports[r.dataset.removeReport];
      store.saveReports(state.reports);
      renderReportsList(state.reports, $('reports-list'));
      if (state.vm) renderStops(state.vm, $('stops'), state.reports);
    }
  });
}

// ---------------------------------------------------------------- avvio

function restoreLastPlan() {
  const vm = store.load('lastPlan', null);
  if (vm?.version !== 1) return;
  showResult(vm);
  showMessage(`Ultimo piano calcolato ${fmtDayTime(vm.createdAt)} (partenza ${fmtDayTime(vm.departure)}). Ricalcola per aggiornarlo.`);
}

function init() {
  fillForm();
  const ac = setupAutocomplete();
  setupSettings();
  $('trip-form').addEventListener('submit', (e) => onSubmit(e, ac));
  $('trip-form').addEventListener('input', (e) => {
    if (['tank', 'tank-unit', 'range', 'safety', 'when', 'maxdist', 'consumption', 'petrol', 'allow-petrol'].includes(e.target.id)) updateHints();
  });
  $('btn-here').addEventListener('click', useCurrentPosition);
  $('btn-swap').addEventListener('click', () => {
    [state.places.from, state.places.to] = [state.places.to, state.places.from];
    [$('from').value, $('to').value] = [$('to').value, $('from').value];
  });
  $('stops').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-report]');
    if (btn) onReportClick(btn);
  });
  loadData().then(() => {
    // Leaflet è caricato con defer: aspetta che sia pronto prima di disegnare la mappa
    if (window.L) restoreLastPlan();
    else window.addEventListener('load', restoreLastPlan, { once: true });
  });
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => { /* PWA non disponibile */ });
  }
}

init();
export { REPORT };
