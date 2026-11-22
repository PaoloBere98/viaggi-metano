// Disegno del riepilogo e della lista delle soste a partire dal view model.
import { googleMapsLegs, wazeUrl } from '../lib/navlinks.js';
import { esc, fmtKm, fmtTime, fmtDay, fmtDayTime, fmtDuration, fmtEuro, fmtPrice, fmtDate, STATUS_INFO } from './format.js';

const REPORT_LABEL = { chiuso: 'Trovato chiuso', 'sicuro-festivi': 'Sicuro nei festivi' };

function badge(status) {
  const s = STATUS_INFO[status];
  return `<span class="badge ${status}">${s.icon} ${s.label}</span>`;
}

function pricesHtml(st) {
  const parts = [];
  for (const [kind, label] of [['metano', 'Metano'], ['lgnc', 'L-GNC']]) {
    const p = st.prices?.[kind];
    if (!p) continue;
    if (p.self) parts.push(`${label} self ${fmtPrice(p.self.p)}`);
    if (p.servito) parts.push(`${label} servito ${fmtPrice(p.servito.p)}`);
  }
  if (!parts.length) return '<span>Prezzo non disponibile</span>';
  return parts.map((x) => `<span>${esc(x)}</span>`).join('');
}

function serviceLabel(st) {
  const p = st.prices;
  const self = p?.metano?.self || p?.lgnc?.self;
  const serv = p?.metano?.servito || p?.lgnc?.servito;
  if (self && serv) return 'Self e servito';
  if (self) return 'Self service';
  if (serv) return 'Servito';
  return null;
}

function addressLine(st) {
  return [st.address, [st.city, st.prov && `(${st.prov})`].filter(Boolean).join(' ')].filter(Boolean).join(', ');
}

function sourceHtml(ev) {
  const upd = ev.updated ? ` · aggiornato al ${esc(fmtDate(ev.updated))}` : '';
  const rule = ev.rule ? `<li>Orario OSM: <code>${esc(ev.rule)}</code></li>` : '';
  const notes = ev.notes.map((n) => `<li>${esc(n)}</li>`).join('');
  return `<div class="source">Fonte: ${esc(ev.sourceLabel)}${upd}${rule || notes ? `<ul>${rule}${notes}</ul>` : ''}</div>`;
}

function reportButtons(st, reports) {
  const r = reports[st.id];
  return ['sicuro-festivi', 'chiuso']
    .map((type) => `<button type="button" class="secondary" data-report="${type}" data-id="${esc(st.id)}" data-name="${esc(st.name)}" aria-pressed="${r?.type === type}">${type === 'chiuso' ? '🚫' : '👍'} ${REPORT_LABEL[type]}</button>`)
    .join('');
}

const short = (label) => String(label ?? '').split(',')[0];

function wazeButton(p) {
  return `<a class="secondary" href="${esc(wazeUrl(p))}" target="_blank" rel="noopener">🚗 Vai con Waze</a>`;
}

/** Pulsanti Google Maps: uno per tratto (al massimo 3 tappe per link). */
function googleButtons(vm) {
  const from = { ...vm.from, current: vm.from.label === 'Posizione attuale' };
  const stops = vm.stops.map((s) => ({ lat: s.station.lat, lon: s.station.lon, label: `${s.n}. ${s.station.name}` }));
  const legs = googleMapsLegs(from, vm.to, stops);
  const many = legs.length > 1;
  return `
    <div class="nav-legs">
      ${legs.map((l) => `<a class="secondary" href="${esc(l.url)}" target="_blank" rel="noopener">🗺️ Google Maps${many ? ` – Tratto ${l.index}` : ''}<span class="hint">${esc(short(l.from))} → ${esc(short(l.to))}${l.stops ? ` · ${l.stops} ${l.stops === 1 ? 'sosta' : 'soste'}` : ''}</span></a>`).join('')}
    </div>
    ${many ? '<p class="hint">Sul telefono Google Maps accetta poche tappe per volta: apri il tratto successivo quando arrivi alla fine del precedente.</p>' : ''}
    <p class="hint">Con Waze usa il pulsante di ogni sosta. Nelle aree di servizio controlla che il navigatore ti porti sulla carreggiata giusta.</p>`;
}

function legFact(legKm, petrolKm, methaneLeft, petrolLeft, vm) {
  if (petrolKm > 0.05) {
    return `<span class="petrol-note">⛽ tratta ${fmtKm(legKm)}: ${fmtKm(legKm - petrolKm)} a metano + ${fmtKm(petrolKm)} a benzina; arrivi con il metano finito${petrolLeft != null ? ` e ~${fmtKm(petrolLeft)} di benzina` : ''}</span>`;
  }
  const reserve = vm.settings.rangeKm * (1 - vm.settings.safetyPct / 100);
  const low = methaneLeft < reserve - 0.5;
  return `<span${low ? ' class="petrol-note"' : ''}>↔️ tratta ${fmtKm(legKm)}, arrivi con ~${fmtKm(methaneLeft)}${low ? ' (sotto il margine)' : ''}</span>`;
}

function detourText(x) {
  if (x.detourKm < 0.3 && x.detourMin < 2) return 'sul percorso';
  return `deviazione ${fmtKm(x.detourKm)} / ${Math.round(x.detourMin)} min${x.measured ? ' (misurata)' : ' (stima)'}`;
}

function stationBlock(x, reports, extraFacts = []) {
  const st = x.station;
  const svc = serviceLabel(st);
  const rep = reports[st.id];
  const facts = [
    `<span>📍 km ${Math.round(x.km)} · ${esc(detourText(x))}</span>`,
    ...extraFacts,
    svc ? `<span>⛽ ${esc(svc)}</span>` : '',
    st.highway ? '<span>🛣️ Autostradale</span>' : '',
  ].filter(Boolean);
  const warnings = [
    st.src === 'osm' ? 'Solo su OpenStreetMap: non confermato dagli open data MIMIT.' : '',
    st.posDubbia ? 'Posizione MIMIT dubbia: verifica l\'indirizzo.' : '',
  ].filter(Boolean);
  return `
    <div class="name">${esc(st.name)}${rep ? ` <span class="badge report">${rep.type === 'chiuso' ? '🚫' : '👍'} ${REPORT_LABEL[rep.type]}</span>` : ''}</div>
    <div class="addr">${esc(addressLine(st))}</div>
    <div class="facts">${facts.join('')}</div>
    <div class="facts">${pricesHtml(st)}</div>
    ${sourceHtml(x.evaluation)}
    ${warnings.map((w) => `<div class="source">⚠️ ${esc(w)}</div>`).join('')}
    <div class="buttons" data-nav="${esc(st.id)}">
      ${wazeButton(st)}
      ${st.phone ? `<a class="secondary" href="tel:${esc(st.phone.replace(/[^\d+]/g, ''))}">📞 Chiama</a>` : ''}
      ${reportButtons(st, reports)}
    </div>`;
}

export function renderSummary(vm, el) {
  if (!vm.ok) {
    const c = vm.critical;
    const fromTxt = c.from ? `dopo <strong>${esc(c.from.name)}</strong> (${esc(c.from.city ?? '')}, km ${Math.round(c.fromKm)})` : 'dalla partenza';
    const nextTxt = c.nextIsDestination
      ? 'la destinazione'
      : `<strong>${esc(c.next.name)}</strong> (${esc(c.next.city ?? '')}, km ${Math.round(c.nextKm)})`;
    const fuel = c.reachableWithMethaneReserve
      ? 'Ci arriveresti solo consumando il margine di sicurezza del metano.'
      : c.reachableWithPetrol
        ? 'Ci arriveresti solo usando la riserva a benzina.'
        : 'Non ci arriveresti nemmeno con la riserva a benzina.';
    el.className = 'card summary critical';
    el.innerHTML = `
      <h2>❌ Nessun piano valido${c.petrolTried ? ', nemmeno usando la benzina' : ' senza benzina'}</h2>
      <p>Punto critico: ${fromTxt} il prossimo rifornimento utilizzabile è ${nextTxt}, a <strong>${fmtKm(c.gapKm)}</strong>.
      La tratta massima consentita è ${fmtKm(c.maxLegKm)}.</p>
      <p>${fuel}</p>
      ${c.closedInRange.length ? `<p>Distributori nel raggio ma chiusi al passaggio:</p><ul class="notes">${c.closedInRange
        .map((x) => `<li>${esc(x.station.name)} (${esc(x.station.city ?? '')}), km ${Math.round(x.km)}, alle ${fmtTime(x.eta)}: ${esc(x.evaluation.notes.join(' '))}</li>`)
        .join('')}</ul>` : ''}
      <p class="hint">Prova a cambiare orario di partenza, ad aumentare la distanza massima dal percorso o a partire con il pieno.</p>
      ${notesHtml(vm)}`;
    return;
  }
  const s = vm.summary;
  const worst = s.worstStatus;
  const verdict = !s.stops
    ? '✅ Nessun rifornimento necessario'
    : worst === 'aperto'
      ? '✅ Tutte le soste hanno un orario che le conferma aperte'
      : worst === 'probabile'
        ? '🟡 Alcune soste sono solo probabilmente aperte'
        : '⚪ Alcune soste hanno orario sconosciuto: verifica prima di partire';
  el.className = `card summary${vm.emergency ? ' emergency' : ''}`;
  el.innerHTML = `
    ${vm.emergency ? emergencyHtml(vm) : ''}
    <div class="verdict">${verdict}</div>
    <dl class="stats">
      <div><dt>Distanza</dt><dd>${fmtKm(s.totalKm)}</dd></div>
      <div><dt>Durata</dt><dd>${fmtDuration(s.totalSec)}</dd></div>
      <div><dt>Arrivo</dt><dd>${fmtTime(vm.arrival.eta)}</dd></div>
      <div><dt>Soste</dt><dd>${s.stops}</dd></div>
      <div><dt>Metano stimato</dt><dd>${fmtEuro(s.costEuro)}</dd></div>
      <div><dt>All'arrivo</dt><dd>~${fmtKm(vm.arrival.fuelKm)}</dd></div>
    </dl>
    ${notesHtml(vm)}
    <h3>Apri nel navigatore</h3>
    ${googleButtons(vm)}`;
}

/** Spiegazione del piano di emergenza: perché il solo metano non basta e quanta benzina serve. */
function emergencyHtml(vm) {
  const c = vm.methaneCritical;
  const where = c
    ? `${c.from ? `dopo <strong>${esc(c.from.name)}</strong> (km ${Math.round(c.fromKm)})` : 'dalla partenza'} il primo distributore a metano utilizzabile è
       ${c.nextIsDestination ? 'oltre la destinazione' : `<strong>${esc(c.next.name)}</strong> (${esc(c.next.city ?? '')}, km ${Math.round(c.nextKm)})`},
       a ${fmtKm(c.gapKm)}, ma con il margine di sicurezza puoi fare solo ${fmtKm(c.maxLegKm)}.`
    : '';
  const how = vm.usesPetrol
    ? `Piano di emergenza: consumi tutto il metano e poi circa <strong>${fmtKm(vm.summary.petrolKm)} a benzina</strong>, fino al primo rifornimento di metano.`
    : 'Piano di emergenza: senza benzina, ma consumando il margine di sicurezza del metano.';
  return `<h2>⛽ Il solo metano non basta</h2><p>${where}</p><p>${how}</p>
    <p class="hint">Il tratto a benzina è arancione sulla mappa. Se puoi, fai benzina alla prima sosta.</p>`;
}

function notesHtml(vm) {
  const s = vm.summary;
  const lines = [
    ...vm.warnings,
    ...vm.notes,
    s?.costEuro != null ? `Costo calcolato su ${vm.settings.consumptionKgPer100} kg/100 km a ${fmtPrice(s.avgPrice)} di media.` : '',
    `${vm.corridorCount} ${vm.corridorCount === 1 ? 'distributore' : 'distributori'} a metano entro ${vm.settings.maxDistKm} km dal percorso${vm.measuredCount ? `, ${vm.measuredCount} ${vm.measuredCount === 1 ? 'deviazione misurata' : 'deviazioni misurate'}` : ''}.`,
  ].filter(Boolean);
  return `<ul class="notes">${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`;
}

export function renderStops(vm, el, reports) {
  const items = [];
  items.push(`
    <li class="card stop endpoint">
      <div class="head"><div><div class="name">🅰️ ${esc(vm.from.label)}</div>
      <div class="addr">Partenza con ~${fmtKm(vm.startKm)} di metano</div></div>
      <div class="when"><strong>${fmtTime(vm.departure)}</strong><br><span class="hint">${fmtDay(vm.departure)}</span></div></div>
    </li>`);
  if (vm.ok) {
    for (const s of vm.stops) {
      const b = s.backup;
      items.push(`
        <li class="card stop" id="stop-${s.n}">
          <div class="head">
            <div style="display:flex;gap:10px;align-items:center"><span class="num">${s.n}</span>${badge(s.evaluation.status)}</div>
            <div class="when"><strong>${fmtTime(s.eta)}</strong><br><span class="hint">${fmtDay(s.eta)}</span></div>
          </div>
          ${stationBlock(s, reports, [legFact(s.legKm, s.legPetrolKm, s.fuelAtArrivalKm, s.petrolLeftKm, vm)])}
          ${b ? `
          <details class="backup-box">
            <summary>Riserva: ${esc(b.station.name)} ${STATUS_INFO[b.evaluation.status].icon}</summary>
            <p class="hint">${b.mode === 'pieno'
              ? `Se trovi chiuso, a ${fmtKm(b.distFromMainKm)} dalla sosta ${s.n}${b.usesPetrol ? ', usando la benzina' : b.usesReserve ? ', intaccando il margine di sicurezza' : ''}. Arrivo stimato ${fmtTime(b.eta)}.`
              : `Alternativa alla sosta ${s.n} (da scegliere prima): da lì ricalcola il piano. Arrivo stimato ${fmtTime(b.eta)}.`}</p>
            ${badge(b.evaluation.status)}
            ${stationBlock(b, reports)}
          </details>` : '<p class="hint">Nessuna riserva raggiungibile per questa sosta.</p>'}
        </li>`);
    }
    items.push(`
      <li class="card stop endpoint">
        <div class="head"><div><div class="name">🅱️ ${esc(vm.to.label)}</div>
        <div class="addr">Arrivo con ~${fmtKm(vm.arrival.fuelKm)} di metano${vm.arrival.legPetrolKm > 0.05 ? `<br><span class="petrol-note">⛽ ultimi ${fmtKm(vm.arrival.legPetrolKm)} a benzina</span>` : ''}</div></div>
        <div class="when"><strong>${fmtTime(vm.arrival.eta)}</strong><br><span class="hint">${fmtDay(vm.arrival.eta)}</span></div></div>
        <div class="buttons">${wazeButton(vm.to)}</div>
      </li>`);
  }
  el.innerHTML = items.join('');
}

export function renderReportsList(reports, el) {
  const entries = Object.entries(reports);
  if (!entries.length) {
    el.innerHTML = '<li class="hint">Nessuna segnalazione. Puoi aggiungerle dalle schede delle soste.</li>';
    return;
  }
  el.innerHTML = entries
    .sort((a, b) => (b[1].date ?? '').localeCompare(a[1].date ?? ''))
    .map(([id, r]) => `<li><span>${r.type === 'chiuso' ? '🚫' : '👍'} <strong>${esc(r.name ?? id)}</strong><br><span class="hint">${REPORT_LABEL[r.type]} · ${esc(fmtDate(r.date))}</span></span>
      <button type="button" class="secondary" data-remove-report="${esc(id)}">Elimina</button></li>`)
    .join('');
}

export { fmtDayTime };
