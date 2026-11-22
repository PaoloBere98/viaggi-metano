# Viaggi a metano

PWA per pianificare viaggi in Italia con un'auto a metano, scegliendo distributori
**aperti** lungo il percorso (festivi inclusi).

> Stato: dati, percorso, algoritmo soste, interfaccia e link al navigatore completati.
> Segue l'integrazione Google opzionale.

## Uso

1. Apri l'app sul telefono e, dal menu del browser, scegli *Aggiungi a schermata Home*.
2. In ⚙️ Impostazioni incolla la tua chiave gratuita di
   [openrouteservice.org](https://openrouteservice.org/dev/#/signup) (resta sul dispositivo).
3. Inserisci partenza, arrivo, data/ora e metano nel serbatoio, poi *Calcola le soste*.
4. Dalle schede delle soste puoi segnare un distributore come *Sicuro nei festivi* o
   *Trovato chiuso*: il piano si ricalcola subito e le segnalazioni restano sul telefono.

L'ultimo piano calcolato resta consultabile anche offline.

**Navigatore**: *Google Maps* apre l'intero viaggio con le soste come tappe; sul telefono
si usano al massimo 3 tappe per link, quindi i viaggi lunghi sono divisi in "Tratto 1",
"Tratto 2"... (ogni tratto parte dove finisce il precedente). *Waze* accetta una sola
destinazione: c'è un pulsante "Vai con Waze" per ogni sosta, riserva e per l'arrivo.

## Struttura

```
public/                 sito statico pubblicato su GitHub Pages
  data/metano.json      distributori a metano (generato ogni giorno)
  js/lib/geo.js         funzioni geografiche condivise app/script
  js/lib/corridor.js    distributori nel corridoio: km progressivi, distanza, tempi
  js/lib/ors.js         client OpenRouteService (percorso, indirizzi, deviazione reale)
  js/lib/festivi.js     festività nazionali (Pasqua calcolata, 4 ottobre dal 2026)
  js/lib/opening.js     stato di apertura all'ETA: ✅ aperto / 🟡 probabile / ⚪ sconosciuto / ❌ chiuso
  js/lib/planner.js     algoritmo delle soste, riserve, punto critico
  js/lib/trip.js        orchestratore: piano + verifica deviazioni reali + nuovo piano
scripts/
  build-data.mjs        scarica MIMIT + OSM, abbina, scrive metano.json
  lib/mimit.mjs         parser dei CSV MIMIT
  lib/osm.mjs           query Overpass e parser
  lib/match.mjs         abbinamento MIMIT ↔ OSM
data-cache/osm-cng.json ultima risposta Overpass (ripiego se Overpass non risponde)
test/                   test (node --test)
.github/workflows/      aggiornamento dati + pubblicazione
```

## Dati

| Fonte | Cosa forniamo | Note |
|---|---|---|
| MIMIT open data (`anagrafica_impianti_attivi.csv`, `prezzo_alle_8.csv`) | impianti che vendono Metano o L-GNC, prezzo self/servito con data, tipo stradale/autostradale | separatore `\|` dal 10/02/2026; alcune righe contengono `\|` nei campi; coordinate non verificate; prezzi fuori 0,80–3,50 €/kg scartati |
| OpenStreetMap (Overpass) | `fuel:cng=yes`: orari (`fuel:cng:opening_hours` o `opening_hours`), self service, telefono | abbinati al MIMIT entro 150 m (300 m se il marchio coincide) |

I distributori presenti **solo su OSM** sono inclusi con `src: "osm"`: non sono confermati
dal MIMIT, quindi il pianificatore li tratterà con cautela.

Se il formato MIMIT cambia (intestazione diversa, prima riga diversa) o gli impianti a
metano scendono sotto 1.000, lo script si ferma con errore e resta pubblicata la versione
precedente.

### Comandi

```powershell
npm install                # dipendenze di sviluppo (opening_hours, leaflet)
npm test
npm run build-data         # aggiorna public/data/metano.json
npm run serve              # app in locale su http://localhost:8080
npm run vendor             # ricopia le librerie in public/vendor dopo un aggiornamento
node scripts/icons.mjs     # rigenera le icone PNG
```

Dopo ogni modifica a HTML/CSS/JS da pubblicare, aumentare `VERSION` in `public/sw.js`
così i telefoni con l'app installata scaricano la nuova versione.

## Pubblicazione (GitHub Pages)

1. Crea un repository su GitHub e carica il progetto sul branch `main`.
2. In **Settings → Pages** scegli *Source: GitHub Actions*.
3. Il workflow `Dati metano e pubblicazione` gira alle 07:15 e 15:15 UTC, aggiorna
   `public/data/metano.json`, lo salva nel repository e pubblica il sito. Si può avviare
   a mano da **Actions → Run workflow**.

### Proxy Cloudflare per i file MIMIT

Il sito del MIMIT rifiuta le connessioni dai server di GitHub Actions (verificato il
22/11/2026: timeout di connessione), mentre accetta quelle da Cloudflare. Il workflow
scarica quindi i due CSV attraverso un piccolo Cloudflare Worker
([cloudflare/mimit-proxy.js](cloudflare/mimit-proxy.js)), che serve solo quei due file
e solo a chi presenta il segreto condiviso.

1. Cloudflare → Workers & Pages → crea un worker (es. `mimit-proxy`) e incolla il codice.
2. Nel worker, Settings → Variables and Secrets: segreto `PROXY_TOKEN` (stringa casuale lunga).
3. Su GitHub, Settings → Secrets and variables → Actions:
   `MIMIT_PROXY_URL` (indirizzo `https://….workers.dev`) e `MIMIT_PROXY_TOKEN` (stesso segreto).

Senza questi segreti il workflow prova il sito MIMIT diretto; se fallisce pubblica il sito
con i dati precedenti e segnala l'errore come annotazione dell'esecuzione.

Nota: GitHub disattiva i workflow pianificati dopo 60 giorni senza attività nel
repository; i commit automatici dei dati di solito bastano a tenerlo attivo, ma se
l'aggiornamento si ferma basta riattivarlo dalla scheda Actions.

## Algoritmo delle soste

- **Autonomia utile**: dopo un pieno `autonomia × margine` (350 × 0,75 ≈ 262 km); alla
  partenza `km residui − riserva`, ma almeno metà dei km residui se il serbatoio è basso.
  Si arriva così a ogni sosta e a destinazione con la riserva di sicurezza.
- **Stato all'orario di arrivo** (fonti in ordine): segnalazioni personali → Google →
  OSM `opening_hours` → euristica (self service o autostradale = 🟡) → ⚪ sconosciuto.
  Mai ✅ senza un orario o una segnalazione. Un orario OSM senza `PH` in un giorno festivo
  vale solo 🟡. I distributori presenti solo su OSM arrivano al massimo a 🟡; quelli
  con coordinate MIMIT lontane dal comune dichiarato al massimo a ⚪.
- **Scelta**: stato peggiore del piano → somma degli stati → minuti persi (10 min a sosta
  + deviazione) → prezzo. I distributori ❌ non sono mai soste.
- **Deviazioni**: stimate (2 × distanza × 1,4, +10 min se si esce dall'autostrada), poi
  misurate con OpenRouteService per soste e riserve; le aree di servizio con deviazione
  reale > 5 km sono sulla carreggiata opposta e vengono escluse.
- **Riserva**: raggiungibile dalla sosta principale con il metano rimasto e da cui si
  arriva alla tappa successiva; altrimenti una raggiungibile dalla tappa precedente
  ("ricalcola il piano").
- **Benzina di emergenza** (opzione attiva di default): solo se non esiste un piano a
  solo metano, si cerca un piano che consuma tutto il metano e poi la benzina (tenendone
  10 km di margine) fino al primo distributore di metano. Qui conta prima di tutto usare
  meno benzina; lo stato decide tra soluzioni entro 10 km di benzina l'una dall'altra.
  L'app lo dichiara in evidenza e colora di arancione i tratti a benzina.
- **Nessun piano**: si indica l'ultimo punto raggiungibile, il buco in km, i distributori
  chiusi al passaggio e se il buco si copre bruciando la riserva o solo con la benzina.

## Licenze

- opening_hours.js: LGPL-3.0 (libreria non modificata)

## Licenze dei dati

- MIMIT: Italian Open Data License 2.0
- OpenStreetMap: © OpenStreetMap contributors, ODbL
