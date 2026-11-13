'use strict';
/* =========================================================
   Hunt Map v2: map, wind, pins, property lines, trail cameras,
   activity charts, game plan, offline.
   ========================================================= */

/* ---------- helpers ---------- */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const rad = Math.PI / 180;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ls = {
  get(k, d) { try { const v = localStorage.getItem('hm.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('hm.' + k, JSON.stringify(v)); } catch (e) {} }
};
const fmtT = d => d ? new Date(d).toLocaleTimeString([], {hour:'numeric', minute:'2-digit'}) : '—';
const fmtH = d => new Date(d).toLocaleTimeString([], {hour:'numeric'}).replace(/\s/g,'').replace(':00','').toLowerCase();
const fmtHr = h => (h % 12 || 12) + (h < 12 ? 'a' : 'p');
const fmtDate = d => new Date(d).toLocaleDateString([], {weekday:'short', month:'short', day:'numeric'});
const fmtDur = ms => { const m = Math.round(Math.abs(ms) / 60000); return m >= 60 ? `${Math.floor(m/60)}h ${m%60}m` : `${m}m`; };
const DIRS = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
const DIR8 = ['N','NE','E','SE','S','SW','W','NW'];
const card = deg => DIRS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
const sector8 = deg => Math.round((((deg % 360) + 360) % 360) / 45) % 8;
const angDiff = (a, b) => Math.abs(((a - b) % 360 + 540) % 360 - 180);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
let toastT;
function toast(msg, ms = 2600) { const t = $('#toast'); t.textContent = msg; t.style.display = 'block'; clearTimeout(toastT); toastT = setTimeout(() => t.style.display = 'none', ms); }
function dest(lat, lon, brg, meters) {
  const R = 6371000, d = meters / R, b = brg * rad, p1 = lat * rad, l1 = lon * rad;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [p2 / rad, l2 / rad];
}
function distBrg(a, b) {
  const p1 = a[0]*rad, p2 = b[0]*rad, dp = p2 - p1, dl = (b[1]-a[1])*rad;
  const h = Math.sin(dp/2)**2 + Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
  const m = 2 * 6371000 * Math.asin(Math.sqrt(h));
  const y = Math.sin(dl)*Math.cos(p2), x = Math.cos(p1)*Math.sin(p2) - Math.sin(p1)*Math.cos(p2)*Math.cos(dl);
  return {m, brg: (Math.atan2(y, x) / rad + 360) % 360};
}
const distTxt = m => m < 1609 ? `${Math.round(m * 1.09361)} yd` : `${(m / 1609.34).toFixed(2)} mi`;
function arrowG(toDeg, color = '#f26b1d') {
  return `<g transform="rotate(${toDeg} 50 50)"><path d="M50 8 L72 52 L56 46 L56 92 L44 92 L44 46 L28 52 Z" fill="${color}" stroke="#000" stroke-opacity=".35" stroke-width="2"/></g>`;
}
const arrowSVG = (toDeg, color) => `<svg viewBox="0 0 100 100">${arrowG(toDeg, color)}</svg>`;
const PHASES = ['New moon','Waxing crescent','First quarter','Waxing gibbous','Full moon','Waning gibbous','Last quarter','Waning crescent'];
const PHASE_SHORT = ['New','Wax cres','1st qtr','Wax gib','Full','Wan gib','Last qtr','Wan cres'];
const phaseIdx = f => Math.round(f * 8) % 8;
const hereLatLon = () => S.me || [map.getCenter().lat, map.getCenter().lng];

/* ---------- IndexedDB (parcels, photos) ---------- */
let _db;
function db() {
  return _db ||= new Promise((res, rej) => {
    const r = indexedDB.open('huntmap', 2);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
      if (!d.objectStoreNames.contains('photos')) d.createObjectStore('photos', {keyPath: 'id'});
      if (!d.objectStoreNames.contains('blobs')) d.createObjectStore('blobs');
    };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
function idbReq(store, mode, fn) {
  return db().then(d => new Promise((res, rej) => {
    const t = d.transaction(store, mode); let out;
    const r = fn(t); if (r && 'onsuccess' in r) r.onsuccess = () => out = r.result;
    t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
  }));
}
const kvGet = k => idbReq('kv', 'readonly', t => t.objectStore('kv').get(k));
const kvSet = (k, v) => idbReq('kv', 'readwrite', t => { t.objectStore('kv').put(v, k); });
const photosAll = () => idbReq('photos', 'readonly', t => t.objectStore('photos').getAll());
const photoPutMeta = p => idbReq('photos', 'readwrite', t => { t.objectStore('photos').put(p); });
const blobGet = id => idbReq('blobs', 'readonly', t => t.objectStore('blobs').get(id));
function photoAdd(meta, blobs) {
  return idbReq(['photos', 'blobs'], 'readwrite', t => { t.objectStore('photos').put(meta); t.objectStore('blobs').put(blobs, meta.id); });
}
function photoDel(ids) {
  return idbReq(['photos', 'blobs'], 'readwrite', t => { ids.forEach(id => { t.objectStore('photos').delete(id); t.objectStore('blobs').delete(id); }); });
}

/* ---------- state ---------- */
const PIN_TYPES_KEYS = ['stand','blind','box','feeder','camera','plot','bed','scrape','rub','trail','water','crossing','gate','truck','sighting','blood','harvest','mineral','hazard','note'];
const S = {
  me: null, acc: null, follow: false,
  wx: ls.get('wx', null), selIdx: null, pinnedHour: false,
  pins: ls.get('pins', []),
  coneFrom: ls.get('coneFrom', 'me'), coneLen: ls.get('coneLen', 200),
  base: ls.get('base2', 'hd'),
  showParcels: ls.get('showParcels', true), showCone: ls.get('showCone', true), showLabels: ls.get('showLabels', true),
  parcelSets: [], photos: [],
};
// v1 pins used a few type names that no longer exist
S.pins.forEach(p => { if (!PIN_TYPES_KEYS.includes(p.type)) p.type = p.type === 'truck' ? 'truck' : 'note'; });

/* ---------- pin icon set ---------- */
const PIN_TYPES = {
  stand:   {n:'Stand',     c:'#f26b1d', g:'M8 3v18M16 3v18M8 7h8M8 11h8M8 15h8'},
  blind:   {n:'Blind',     c:'#a1773f', g:'M3 20L12 4l9 16zM10 20v-5h4v5'},
  box:     {n:'Box blind', c:'#a1773f', g:'M4 6h16v10H4zM7 9h10M6 16v5M18 16v5'},
  feeder:  {n:'Feeder',    c:'#d6a524', g:'M7 3h10v9H7zM9 12l-3 9M15 12l3 9M12 12v6'},
  camera:  {n:'Camera',    c:'#3b9cf5', g:'M4 7h16v12H4zM9 7l1.5-3h3L15 7M15.5 13a3.5 3.5 0 1 1-7 0a3.5 3.5 0 1 1 7 0'},
  plot:    {n:'Food plot', c:'#43a047', g:'M12 21V10M12 14c-4 0-6-3-6-6c4 0 6 3 6 6M12 12c0-4 2-7 6-7c0 4-2 7-6 7'},
  bed:     {n:'Bedding',   c:'#8e63c9', g:'M3 18c0-5 4-8 9-8s9 3 9 8zM8 10L6 5M16 10l2-5'},
  scrape:  {n:'Scrape',    c:'#b5651d', g:'M8 4c-2.5 3-2.5 9 1 13c1.5-4.5 1-10-1-13zM16 4c2.5 3 2.5 9-1 13c-1.5-4.5-1-10 1-13z'},
  rub:     {n:'Rub',       c:'#8d4a26', g:'M12 22V3M12 3c-3 3-5 6-5 9h10c0-3-2-6-5-9M10 14h4v4h-4z'},
  trail:   {n:'Trail',     c:'#c0a57a', g:'M6 21c0-5 12-5 12-10S10 7 10 3'},
  water:   {n:'Water',     c:'#2aa3c9', g:'M12 3c4 6 6 9 6 12a6 6 0 0 1-12 0c0-3 2-6 6-12z'},
  crossing:{n:'Crossing',  c:'#d9b929', g:'M5 5l14 14M19 5L5 19'},
  gate:    {n:'Gate',      c:'#8f9a94', g:'M3 5v15M21 5v15M3 9h18M3 15h18M3 15L21 9'},
  truck:   {n:'Parking',   c:'#5f7d8c', g:'M2 15V8h11v7M13 11h5l3 3v1h-8M5 17a2 2 0 1 0 4 0a2 2 0 1 0-4 0M15 17a2 2 0 1 0 4 0a2 2 0 1 0-4 0'},
  sighting:{n:'Sighting',  c:'#26a69a', g:'M2 12s4-7 10-7s10 7 10 7s-4 7-10 7S2 12 2 12zM15 12a3 3 0 1 1-6 0a3 3 0 1 1 6 0'},
  blood:   {n:'Blood',     c:'#d32f2f', g:'M12 3c4 6 6 9 6 12a6 6 0 0 1-12 0c0-3 2-6 6-12zM12 12v4'},
  harvest: {n:'Harvest',   c:'#e53935', g:'M12 2v6M12 16v6M2 12h6M16 12h6M17 12a5 5 0 1 1-10 0a5 5 0 1 1 10 0'},
  mineral: {n:'Mineral',   c:'#90a4ae', g:'M12 3l8 4v10l-8 4l-8-4V7zM4 7l8 4l8-4M12 11v10'},
  hazard:  {n:'Hazard',    c:'#f2b01e', g:'M12 3L2 21h20zM12 9v6M12 18v.5'},
  note:    {n:'Note',      c:'#6f8796', g:'M5 4h14v16H5zM8 9h8M8 13h8M8 17h5'},
};
const SWATCHES = ['#f26b1d','#e53935','#d6a524','#43a047','#26a69a','#3b9cf5','#8e63c9','#a1773f','#8f9a94','#ffffff'];
function pinSVG(type, color, size = 1) {
  const t = PIN_TYPES[type] || PIN_TYPES.note, c = color || t.c;
  const glyphColor = c.toLowerCase() === '#ffffff' ? '#222' : '#fff';
  return `<svg viewBox="0 0 34 44" style="width:${34*size}px;height:${44*size}px"><path d="M17 43C17 43 3 27.5 3 17a14 14 0 0 1 28 0C31 27.5 17 43 17 43z" fill="${c}" stroke="#fff" stroke-width="2"/>
    <g transform="translate(7 7) scale(.83)" fill="none" stroke="${glyphColor}" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="${t.g}"/></g></svg>`;
}

/* ---------- map + imagery ---------- */
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/';
const USGS = 'https://basemap.nationalmap.gov/arcgis/rest/services/';
const TILE = {
  esri:  ESRI + 'World_Imagery/MapServer/tile/{z}/{y}/{x}',
  roads: ESRI + 'Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}',
  labels:ESRI + 'Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
  usgsImg: USGS + 'USGSImageryOnly/MapServer/tile/{z}/{y}/{x}',
  usgsTopo: USGS + 'USGSTopo/MapServer/tile/{z}/{y}/{x}',
};
const BASES = {
  hd:      {name:'Satellite HD', layers:[['esri', 19]], note:'Sharpest. Detail keeps sharpening as you zoom, down to individual trees.'},
  hdroads: {name:'Sat + Roads',  layers:[['esri', 19], ['roads', 19], ['labels', 19]], note:'HD satellite with roads and place names.'},
  topo:    {name:'Topo',         layers:[['usgsTopo', 16]], note:'Contour lines for ridges, saddles, and draws. Saved offline.'},
  usgs:    {name:'USGS Aerial',  layers:[['usgsImg', 16]], note:'Lower detail, but this is the map that is saved for offline use.'},
};
const view = ls.get('view', {c: [32.606, -83.245], z: 15});
const map = L.map('map', {zoomControl: false, preferCanvas: true, maxZoom: 21, zoomSnap: 0.5, wheelPxPerZoomLevel: 90}).setView(view.c, view.z);
let baseGroup = L.layerGroup().addTo(map), offlineUnder = null;
function tl(key, nz, extra = {}) {
  return L.tileLayer(TILE[key], Object.assign({
    maxNativeZoom: nz, maxZoom: 21, keepBuffer: 4, updateWhenZooming: true, updateWhenIdle: false,
    attribution: key.startsWith('usgs') ? 'USGS' : 'Esri, Maxar, Earthstar Geographics',
  }, extra));
}
function setBase(k) {
  if (!BASES[k]) k = 'hd';
  S.base = k; ls.set('base2', k);
  baseGroup.clearLayers();
  BASES[k].layers.forEach(([key, nz], i) => tl(key, nz, {zIndex: i + 1}).addTo(baseGroup));
  $$('#baseSeg button').forEach(b => b.classList.toggle('on', b.dataset.base === k));
  $('#baseNote').textContent = BASES[k].note;
  syncOfflineUnderlay(); updateDlEstimate(); zoomHint();
}
// With no signal, slip the saved USGS aerial underneath so the map never goes blank.
function syncOfflineUnderlay() {
  const need = !navigator.onLine && (S.base === 'hd' || S.base === 'hdroads');
  if (need && !offlineUnder) { offlineUnder = tl('usgsImg', 16, {zIndex: 0}); offlineUnder.addTo(map); offlineUnder.bringToBack(); }
  if (!need && offlineUnder) { map.removeLayer(offlineUnder); offlineUnder = null; }
}
function zoomHint() { try { zoomHint_(); } catch (e) {} }
function zoomHint_() {
  const z = map.getZoom(), el = $('#zoomHint');
  const nz = Math.max(...BASES[S.base].layers.map(l => l[1]));
  const b = map.getBounds(), needZoom = S.showParcels && PARCEL_SOURCES.find(src => !LIVE[src.id]?.done && bboxHits(b, src.bbox) && z < src.minZoom);
  if (z > nz + 0.5) { el.textContent = `Max detail for ${BASES[S.base].name}. Try Satellite HD.`; el.style.display = 'block'; }
  else if (needZoom) { el.textContent = `Zoom in to load ${needZoom.name} property lines`; el.style.display = 'block'; }
  else if (S.showParcels && z >= 12 && (() => { const c = countyOf(map.getCenter().lat, map.getCenter().lng); return c && !srcForCounty(c) && (el.textContent = `No free property lines for ${c.n} County yet`); })()) el.style.display = 'block';
  else el.style.display = 'none';
}
map.on('moveend', () => zoomHint());
// Thousands of parcel outlines are unreadable and heavy when zoomed far out, so hide them below zoom 11.
const PARCEL_MIN_Z = 11;
function syncParcelVisibility() { try { syncParcelVisibility_(); } catch (e) {} }
function syncParcelVisibility_() {
  const want = S.showParcels && map.getZoom() >= PARCEL_MIN_Z;
  if (want && !map.hasLayer(parcelLayer)) parcelLayer.addTo(map);
  if (!want && map.hasLayer(parcelLayer)) map.removeLayer(parcelLayer);
}
map.on('zoomend', () => syncParcelVisibility());
map.on('zoomend', () => { zoomHint(); $('#map').classList.toggle('nolabels', !S.showLabels || map.getZoom() < 15); });
map.on('moveend', () => { const c = map.getCenter(); ls.set('view', {c: [c.lat, c.lng], z: map.getZoom()}); updateDlEstimate(); });
map.on('dragstart', () => { if (S.follow) { S.follow = false; $('#bLocate').classList.remove('on'); } });
map.on('click', () => { $('#layerMenu').style.display = 'none'; });

const coneLayer = L.layerGroup().addTo(map);
const pinLayer = L.layerGroup().addTo(map);
const parcelLayer = L.layerGroup();
let meMarker = null, accCircle = null;

/* ---------- GPS ---------- */
function startGPS() {
  if (!('geolocation' in navigator)) return;
  navigator.geolocation.watchPosition(pos => {
    const first = !S.me;
    S.me = [pos.coords.latitude, pos.coords.longitude]; S.acc = pos.coords.accuracy;
    if (!meMarker) {
      meMarker = L.marker(S.me, {icon: L.divIcon({className: '', html: '<div class="me"></div>', iconSize: [20, 20]}), interactive: false, zIndexOffset: 2000}).addTo(map);
      accCircle = L.circle(S.me, {radius: S.acc, color: '#3b9cf5', weight: 1, fillOpacity: .08, interactive: false}).addTo(map);
    } else { meMarker.setLatLng(S.me); accCircle.setLatLng(S.me).setRadius(S.acc); }
    if (S.follow) map.panTo(S.me);
    if (first && (!S.wx || distBrg(S.me, [S.wx.lat, S.wx.lon]).m > 8000)) refreshWx(false);
    drawCone(); updateParcelHere();
  }, err => { if (err.code === 1) toast('Location is off. The map still works without your GPS dot.'); },
  {enableHighAccuracy: true, maximumAge: 5000, timeout: 30000});
}
$('#bLocate').onclick = () => {
  if (!S.me) { toast('Waiting for GPS…'); S.follow = true; $('#bLocate').classList.add('on'); return; }
  S.follow = !S.follow; $('#bLocate').classList.toggle('on', S.follow);
  if (S.follow) map.setView(S.me, Math.max(map.getZoom(), 17));
};

/* ---------- weather (Open-Meteo) ---------- */
function parseLocal(t, off) { const [d, h] = t.split('T'); const [Y, M, D] = d.split('-').map(Number); const [hh, mm] = h.split(':').map(Number); return Date.UTC(Y, M-1, D, hh, mm) - off * 1000; }
async function refreshWx(manual) {
  const at = hereLatLon();
  if (!navigator.onLine) { if (manual) toast('No signal: showing the saved forecast'); renderWx(); return; }
  const u = `https://api.open-meteo.com/v1/forecast?latitude=${at[0].toFixed(4)}&longitude=${at[1].toFixed(4)}` +
    `&hourly=temperature_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,precipitation_probability,pressure_msl,cloud_cover` +
    `&wind_speed_unit=mph&temperature_unit=fahrenheit&timezone=auto&past_days=1&forecast_days=5`;
  try {
    const r = await fetch(u); if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json(), h = j.hourly, off = j.utc_offset_seconds || 0;
    S.wx = {lat: at[0], lon: at[1], fetchedAt: Date.now(), hours: h.time.map((t, i) => ({
      t: parseLocal(t, off), temp: h.temperature_2m[i], ws: h.wind_speed_10m[i], wd: h.wind_direction_10m[i], wg: h.wind_gusts_10m[i],
      pop: h.precipitation_probability[i], p: h.pressure_msl[i], cc: h.cloud_cover[i]}))};
    ls.set('wx', S.wx);
    if (manual) toast('Forecast updated');
  } catch (e) { if (manual) toast('Could not reach the weather service'); }
  renderWx();
}
function nowIdx() { if (!S.wx) return -1; const n = Date.now(); let k = -1; S.wx.hours.forEach((h, i) => { if (h.t <= n) k = i; }); return k; }
function selIdx() { return (S.pinnedHour && S.selIdx != null) ? S.selIdx : nowIdx(); }
function curHour() { const i = selIdx(); return S.wx && i >= 0 ? S.wx.hours[i] : null; }
function legalWindow(day, lat, lon) { const d = new Date(day); d.setHours(12, 0, 0, 0); const t = SunCalc.getTimes(d, lat, lon); return {start: +t.sunrise - 30*60000, end: +t.sunset + 30*60000, sunrise: +t.sunrise, sunset: +t.sunset}; }
function isLegal(ms, lat, lon) { const w = legalWindow(ms, lat, lon); return ms >= w.start && ms <= w.end; }
function vecMean(dirs) { let x = 0, y = 0; dirs.forEach(d => { x += Math.cos(d*rad); y += Math.sin(d*rad); }); return (Math.atan2(y, x) / rad + 360) % 360; }

function renderWx() {
  renderTop(); drawCone();
  const body = $('#wxBody'); if (!body) return;
  if (!S.wx) { body.innerHTML = `<div class="card muted">${navigator.onLine ? 'Loading forecast…' : 'No signal and no saved forecast yet. Open the app once with signal.'}</div>` + sunMoonHTML(); return; }
  const ni = nowIdx(), si = selIdx(), h = S.wx.hours[si] || S.wx.hours[0];
  const age = Date.now() - S.wx.fetchedAt, last = S.wx.hours[S.wx.hours.length - 1].t;
  // compass
  let html = `<div class="card"><div class="compass"><svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="46" fill="#0b0f0d" stroke="#2f3934" stroke-width="2"/>
    ${['N','E','S','W'].map((d, i) => `<text x="${50 + 38*Math.sin(i*90*rad)}" y="${50 - 38*Math.cos(i*90*rad) + 4}" text-anchor="middle" fill="#9aa69f" font-size="11" font-weight="700">${d}</text>`).join('')}
    <g transform="translate(20 20) scale(.6)">${arrowG((h.wd + 180) % 360)}</g></svg>
    <div><div class="small muted">${S.pinnedHour ? fmtDate(h.t) + ' ' + fmtH(h.t) : 'Right now'}</div>
    <div class="big">${card(h.wd)} ${Math.round(h.ws)} <span style="font-size:15px">mph</span></div>
    <div class="muted">Gusts ${Math.round(h.wg)} · ${Math.round(h.temp)}°F</div>
    <div class="small">Scent drifts <b>${card((h.wd + 180) % 360)}</b></div></div></div></div>`;
  // detail
  const nxt = S.wx.hours.slice(si, si + 5); let worst = null;
  nxt.forEach(x => { const df = angDiff(x.wd, h.wd); if (!worst || df > worst.df) worst = {df, x}; });
  const p3 = S.wx.hours[si - 3]; let pt = '—';
  if (p3) { const dp = h.p - p3.p; pt = `${(h.p / 33.8639).toFixed(2)} inHg, ${Math.abs(dp) < 0.7 ? 'steady' : dp > 0 ? 'rising ▲' : 'falling ▼'}`; }
  html += `<div class="card"><div class="kv"><div>Pressure</div><div>${pt}</div><div>Clouds / rain</div><div>${h.cc}% · ${h.pop ?? 0}% chance</div></div>
    <div style="margin-top:6px">${worst && worst.df >= 45 ? `<span class="warn">⚠ Wind swings ${card(h.wd)} → ${card(worst.x.wd)} by ${fmtH(worst.x.t)}</span>` : '<span class="good">Direction holds steady for the next 4 hours</span>'}</div>
    ${h.ws < 4 ? '<div class="warn small">Under 4 mph, wind swirls. The cone is drawn wider.</div>' : ''}</div>`;
  // hourly strip
  html += `<div class="row" style="justify-content:space-between;margin-bottom:6px"><b>Hourly</b><span class="small muted">Updated ${fmtDur(age)} ago${navigator.onLine ? '' : '<span class="badge">OFFLINE</span>'} · saved through ${fmtDate(last)}</span></div><div id="hourly">`;
  const start = Math.max(0, ni), end = Math.min(S.wx.hours.length, start + 60);
  for (let i = start; i < end; i++) {
    const x = S.wx.hours[i], dark = !isLegal(x.t, S.wx.lat, S.wx.lon);
    const day = (i === start || new Date(x.t).getHours() === 0) ? new Date(x.t).toLocaleDateString([], {weekday: 'short'}) : '&nbsp;';
    html += `<div class="hr${dark ? ' dark' : ''}${i === si ? ' sel' : ''}" data-i="${i}"><div class="small muted">${day}</div><div class="t">${i === ni ? 'Now' : fmtH(x.t)}</div>
      ${arrowSVG((x.wd + 180) % 360)}<div><b>${card(x.wd)}</b> ${Math.round(x.ws)}</div><div class="muted">g${Math.round(x.wg)}</div><div>${Math.round(x.temp)}°</div><div class="muted">${x.pop ? x.pop + '%' : '&nbsp;'}</div></div>`;
  }
  html += `</div><div class="small muted" style="margin:0 0 12px">Dark hours are outside legal light. Tap an hour to show its scent cone on the map.</div>`;
  // daily
  const days = {}; S.wx.hours.filter(x => x.t >= Date.now() - 3600000).forEach(x => { const k = new Date(x.t).toDateString(); (days[k] ||= []).push(x); });
  html += '<div class="days">' + Object.values(days).slice(0, 4).map(arr => {
    const am = arr.filter(x => { const hh = new Date(x.t).getHours(); return hh >= 6 && hh <= 9; });
    const pm = arr.filter(x => { const hh = new Date(x.t).getHours(); return hh >= 15 && hh <= 18; });
    return `<div><b>${new Date(arr[0].t).toLocaleDateString([], {weekday: 'short'})}</b><div>${Math.round(Math.max(...arr.map(x => x.temp)))}° / ${Math.round(Math.min(...arr.map(x => x.temp)))}°</div>
      <div class="muted">AM ${am.length ? card(vecMean(am.map(x => x.wd))) : '—'}</div><div class="muted">PM ${pm.length ? card(vecMean(pm.map(x => x.wd))) : '—'}</div><div class="muted">${Math.max(...arr.map(x => x.pop || 0))}% rain</div></div>`;
  }).join('') + '</div>';
  html += `<div class="card small muted" style="margin-top:12px">Thermals: early and late in the day, scent tends to sink downhill. Once the sun warms the slopes it tends to lift uphill.</div>`;
  html += sunMoonHTML();
  body.innerHTML = html;
  const box = $('#hourly');
  box.querySelectorAll('.hr').forEach(el => el.onclick = () => { S.selIdx = +el.dataset.i; S.pinnedHour = S.selIdx !== nowIdx(); renderWx(); });
  const selEl = box.querySelector('.sel'); if (selEl) box.scrollLeft = selEl.offsetLeft - box.offsetLeft - 70;
}
$('#bWxRefresh').onclick = () => refreshWx(true);

function moonDay(day, lat, lon) {
  const d0 = new Date(day); d0.setHours(0, 0, 0, 0);
  const mt = SunCalc.getMoonTimes(d0, lat, lon);
  let hi = null, lo = null;
  for (let m = 0; m <= 1440; m += 5) { const t = new Date(+d0 + m*60000); const a = SunCalc.getMoonPosition(t, lat, lon).altitude; if (!hi || a > hi.a) hi = {a, t}; if (!lo || a < lo.a) lo = {a, t}; }
  return {rise: mt.rise, set: mt.set, over: hi.t, under: lo.t, ill: SunCalc.getMoonIllumination(new Date(+d0 + 12*3600000))};
}
function sunMoonHTML() {
  const at = hereLatLon(); let html = '';
  [0, 1].forEach(k => {
    const d = new Date(); d.setDate(d.getDate() + k); d.setHours(12, 0, 0, 0);
    const w = legalWindow(d, at[0], at[1]), m = moonDay(d, at[0], at[1]);
    const span = (t, mins) => t ? `${fmtT(+t - mins*60000)}–${fmtT(+t + mins*60000)}` : null;
    html += `<div class="card" style="margin-top:12px"><h3>${k === 0 ? 'Today' : 'Tomorrow'} · ${fmtDate(d)}</h3><div class="kv">
      <div>Legal light</div><div><b>${fmtT(w.start)} – ${fmtT(w.end)}</b></div>
      <div>Sunrise / set</div><div>${fmtT(w.sunrise)} / ${fmtT(w.sunset)}</div>
      <div>Moon</div><div>${PHASES[phaseIdx(m.ill.phase)]}, ${Math.round(m.ill.fraction * 100)}% lit</div>
      <div>Moon over / under</div><div>${fmtT(m.over)} / ${fmtT(m.under)}</div>
      <div>Solunar majors</div><div>${[span(m.over, 60), span(m.under, 60)].filter(Boolean).join(', ') || '—'}</div>
      <div>Solunar minors</div><div>${[span(m.rise, 30), span(m.set, 30)].filter(Boolean).join(', ') || '—'}</div></div></div>`;
  });
  return html + `<div class="small muted">Legal light uses Georgia's deer rule: 30 minutes before sunrise to 30 minutes after sunset. Turkey and migratory birds end at sunset. Solunar evidence is mixed, so use it as a tiebreaker.</div>`;
}

/* ---------- scent cone + top card ---------- */
function coneOrigin() {
  if (S.coneFrom !== 'me') { const p = S.pins.find(p => p.id === S.coneFrom); if (p) return [p.lat, p.lon]; }
  return S.me;
}
function drawCone() {
  coneLayer.clearLayers();
  const h = curHour(), o = coneOrigin();
  if (!S.showCone || !h || !o) return;
  const to = (h.wd + 180) % 360, spread = h.ws < 4 ? 40 : h.ws < 10 ? 22 : 14, len = S.coneLen * 0.9144;
  const pts = [o]; for (let a = -spread; a <= spread; a += 4) pts.push(dest(o[0], o[1], to + a, len)); pts.push(dest(o[0], o[1], to + spread, len));
  L.polygon(pts, {color: '#f26b1d', weight: 1.5, fillColor: '#f26b1d', fillOpacity: .22, interactive: false}).addTo(coneLayer);
  L.polyline([o, dest(o[0], o[1], to, len)], {color: '#f26b1d', weight: 2, dashArray: '6 6', interactive: false}).addTo(coneLayer);
}
function renderTop() {
  const h = curHour();
  if (h) {
    $('#topArrow').innerHTML = `<circle cx="50" cy="50" r="47" fill="#0008" stroke="#2f3934"/><text x="50" y="17" text-anchor="middle" fill="#9aa69f" font-size="13" font-weight="700">N</text>` + arrowG((h.wd + 180) % 360);
    const stale = Date.now() - S.wx.fetchedAt > 3 * 3600000;
    $('#topWind').innerHTML = `${S.pinnedHour ? fmtH(h.t) + ': ' : ''}${card(h.wd)} ${Math.round(h.ws)} mph <span class="muted" style="font-weight:400">g${Math.round(h.wg)} · ${Math.round(h.temp)}°</span>${!navigator.onLine ? '<span class="badge">OFFLINE</span>' : stale ? '<span class="badge">OLD</span>' : ''}`;
  } else { $('#topArrow').innerHTML = ''; $('#topWind').textContent = navigator.onLine ? 'Wind: loading…' : 'Wind: no saved forecast'; }
  const at = hereLatLon(), now = Date.now(), w = legalWindow(now, at[0], at[1]);
  let txt;
  if (now < w.start) txt = `Legal light in ${fmtDur(w.start - now)} (${fmtT(w.start)})`;
  else if (now <= w.end) txt = `Legal light ends ${fmtT(w.end)} (${fmtDur(w.end - now)} left)`;
  else txt = `Tomorrow's legal light ${fmtT(legalWindow(now + 86400000, at[0], at[1]).start)}`;
  $('#topLegal').textContent = '⏱ ' + txt;
}
$('#top').onclick = () => showPage('weather');

/* ---------- pins ---------- */
function savePins() { ls.set('pins', S.pins); }
function pinIcon(p) {
  return L.divIcon({className: '', html: `<div class="mk${S.coneFrom === p.id ? ' sel' : ''}">${pinSVG(p.type, p.color)}${p.name ? `<div class="mk-label">${esc(p.name)}</div>` : ''}</div>`,
    iconSize: [34, 44], iconAnchor: [17, 43], popupAnchor: [0, -38]});
}
const pinMarkers = {};
function renderPins() {
  pinLayer.clearLayers();
  S.pins.forEach(p => {
    const m = L.marker([p.lat, p.lon], {icon: pinIcon(p), draggable: false}).addTo(pinLayer);
    m.bindPopup(() => pinPopup(p), {autoPanPaddingTopLeft: [10, 100]});
    pinMarkers[p.id] = m;
  });
  renderPinList();
}
function pinPopup(p) {
  const el = document.createElement('div'); el.className = 'pop';
  const db_ = S.me ? distBrg(S.me, [p.lat, p.lon]) : null;
  const camPhotos = p.type === 'camera' ? S.photos.filter(x => x.cam === p.id).length : 0;
  el.innerHTML = `<div class="row" style="gap:10px">${pinSVG(p.type, p.color, .8)}<div style="flex:1"><select class="ptype" style="width:100%">${Object.entries(PIN_TYPES).map(([k, t]) => `<option value="${k}"${k === p.type ? ' selected' : ''}>${t.n}</option>`).join('')}</select></div></div>
    <label>Name</label><input class="pname" value="${esc(p.name)}" placeholder="e.g. Creek bottom ladder">
    <label>Color</label><div class="swatches">${SWATCHES.map(c => `<div class="sw${(p.color || PIN_TYPES[p.type].c) === c ? ' on' : ''}" data-c="${c}" style="background:${c}"></div>`).join('')}</div>
    <label>Notes</label><textarea class="pnotes" rows="2" placeholder="Best wind, sign, dates…">${esc(p.notes)}</textarea>
    <div class="small muted" style="margin:6px 0">${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}${db_ ? ` · ${distTxt(db_.m)} ${card(db_.brg)} of you` : ''}</div>
    ${p.type === 'camera' ? `<button class="btn primary pcam" style="width:100%;margin-bottom:6px">📷 Photos (${camPhotos})</button>` : ''}
    <div class="row"><button class="btn pcone">${S.coneFrom === p.id ? 'Cone: me' : 'Cone here'}</button><button class="btn pmove">Move</button><button class="btn pdel">Delete</button></div>`;
  const redraw = () => { pinMarkers[p.id]?.setIcon(pinIcon(p)); renderPinList(); };
  el.querySelector('.ptype').onchange = e => { p.type = e.target.value; p.color = null; savePins(); redraw(); map.closePopup(); setTimeout(() => pinMarkers[p.id].openPopup(), 50); };
  el.querySelector('.pname').oninput = e => { p.name = e.target.value; savePins(); redraw(); };
  el.querySelector('.pnotes').oninput = e => { p.notes = e.target.value; savePins(); };
  el.querySelectorAll('.sw').forEach(s => s.onclick = () => { p.color = s.dataset.c; savePins(); redraw(); el.querySelectorAll('.sw').forEach(x => x.classList.toggle('on', x === s)); el.querySelector('svg').outerHTML = pinSVG(p.type, p.color, .8); });
  el.querySelector('.pcam')?.addEventListener('click', () => { map.closePopup(); openCamera(p.id); });
  el.querySelector('.pcone').onclick = () => { S.coneFrom = S.coneFrom === p.id ? 'me' : p.id; ls.set('coneFrom', S.coneFrom); renderPins(); drawCone(); map.closePopup(); if (!curHour()) toast('No forecast saved yet'); };
  el.querySelector('.pmove').onclick = () => { map.closePopup(); map.setView([p.lat, p.lon]); startDrop(p.type, p); };
  let armed = false;
  el.querySelector('.pdel').onclick = e => {
    if (!armed) { armed = true; e.target.textContent = camPhotos ? `Delete + ${camPhotos} photos?` : 'Tap again'; e.target.style.background = '#5a1d18'; return; }
    deletePin(p.id);
  };
  return el;
}
async function deletePin(id) {
  const ids = S.photos.filter(x => x.cam === id).map(x => x.id);
  if (ids.length) { await photoDel(ids); S.photos = S.photos.filter(x => x.cam !== id); }
  S.pins = S.pins.filter(x => x.id !== id);
  if (S.coneFrom === id) { S.coneFrom = 'me'; ls.set('coneFrom', 'me'); }
  savePins(); map.closePopup(); renderPins(); drawCone();
}
function renderPinList() {
  const box = $('#pinList'); if (!box) return;
  if (!S.pins.length) { box.innerHTML = '<div class="small muted">No pins yet. Tap ＋ on the map.</div>'; return; }
  const list = S.pins.map(p => ({p, d: S.me ? distBrg(S.me, [p.lat, p.lon]) : null})).sort((a, b) => a.d && b.d ? a.d.m - b.d.m : b.p.created - a.p.created);
  box.innerHTML = list.map(({p, d}) => `<div class="camrow" data-id="${p.id}" style="padding:8px 10px">${pinSVG(p.type, p.color, .7)}
    <div class="grow"><div class="nm">${esc(p.name || PIN_TYPES[p.type]?.n)}</div><div class="small muted">${esc(p.notes || PIN_TYPES[p.type]?.n || '')}</div></div>
    <div class="small muted" style="text-align:right">${d ? distTxt(d.m) + '<br>' + card(d.brg) : ''}</div></div>`).join('');
  box.querySelectorAll('.camrow').forEach(el => el.onclick = () => { const p = S.pins.find(x => x.id === el.dataset.id); showPage('map'); map.setView([p.lat, p.lon], Math.max(map.getZoom(), 17)); setTimeout(() => pinMarkers[p.id]?.openPopup(), 300); });
}

/* pin drop */
let dropType = 'stand', moving = null, afterDrop = null;
function startDrop(type = 'stand', movePin = null, cb = null) {
  showPage('map'); dropType = type; moving = movePin; afterDrop = cb;
  $('#layerMenu').style.display = 'none';
  $('#typeGrid').innerHTML = Object.entries(PIN_TYPES).map(([k, t]) => `<div class="tcell${k === dropType ? ' on' : ''}" data-t="${k}">${pinSVG(k)}<span>${t.n}</span></div>`).join('');
  $('#typeGrid').style.display = movePin ? 'none' : 'grid';
  $('#dropPanel .pop-title').textContent = movePin ? 'Drag the map to put the crosshair on the new spot' : 'Pick a type, then put the crosshair on the spot';
  $$('#typeGrid .tcell').forEach(c => c.onclick = () => { dropType = c.dataset.t; $$('#typeGrid .tcell').forEach(x => x.classList.toggle('on', x === c)); });
  $('#cross').style.display = 'block'; $('#dropPanel').style.display = 'block';
}
function endDrop() { $('#cross').style.display = 'none'; $('#dropPanel').style.display = 'none'; moving = null; }
$('#bAddPin').onclick = () => startDrop();
$('#bDropCancel').onclick = endDrop;
$('#bDropHere').onclick = () => {
  const c = map.getCenter();
  if (moving) { moving.lat = c.lat; moving.lon = c.lng; savePins(); const id = moving.id; endDrop(); renderPins(); drawCone(); toast('Pin moved'); pinMarkers[id]?.openPopup(); return; }
  const p = {id: uid(), lat: c.lat, lon: c.lng, type: dropType, color: null, name: '', notes: '', created: Date.now()};
  S.pins.push(p); savePins(); endDrop(); renderPins();
  const cb = afterDrop; afterDrop = null;
  if (cb) cb(p); else setTimeout(() => pinMarkers[p.id].openPopup(), 100);
};

/* ---------- live county parcel sources (free public ArcGIS layers) ---------- */
const clean = v => v == null ? null : String(v).replace(/\s+/g, ' ').trim() || null;
function landCover(js) {
  try { const o = JSON.parse(js); return Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${v} ac`).join(', '); } catch (e) { return null; }
}
/* Statewide catalog (counties.js): the best free public parcel layer found for each Georgia county. */
const GA = (window.GA_COUNTIES || []);
const PARCEL_SOURCES = [];
const LEGACY = {twiggs: '13289', wilkinson: '13319', cobb: '13067'}; // ids used before the catalog existed
/* counties added from the in-app finder */
const FRX = {owner: /owner|ownnam|own_name|lastname|taxpayer|grantee|^name1$/i, acres: /acre|acrg|^ac$|calc_?ac|gisac|deedac/i,
  id: /^(pin|apn|parcel|parcelid|parcel_id|parcelno|parcel_no|parcelnum|parcel_num|realkey|pid|parno|map_?parcel)$/i, addr: /situs|^address$|prop_?addr|propertyaddress|location|site_?addr|parceladdr/i};
const FSKIP = {owner: /occ|type|class|code|addr|mail|city|state|zip|count|num|date|_id$|flag|pct/i, acres: /cover|crop|adjacent|contig/i};
const FEXACT = {owner: ['OWNER', 'OWNERNAME', 'OWNER_NAME', 'OWNERNME1', 'OWNER1', 'OWNER_1', 'OWN_NAME', 'OWNNAME', 'OWNNAM', 'LASTNAME', 'TAXPAYER', 'NAME1', 'GRANTEE', 'OWNERS']};
function makeCustom(c) {
  return Object.assign({}, c, {map: p => {
    const o = {Owner: c.f.owner ? clean(p[c.f.owner]) : null, 'Parcel ID': c.f.id ? clean(p[c.f.id]) : null, Acres: c.f.acres ? p[c.f.acres] : null, Address: c.f.addr ? clean(p[c.f.addr]) : null};
    const used = Object.values(c.f);
    for (const [k, v] of Object.entries(p)) if (!/^(shape|objectid|fid$|globalid|landcoveracres|cropcoveracres)/i.test(k) && v != null && v !== '' && !used.includes(k)) o[k] = v;
    if (p.LandCoverAcres) o['Land cover'] = landCover(p.LandCoverAcres);
    return o;
  }});
}
// Catalog counties become live sources; a county's density decides how far you must zoom in.
const byUrl = new Map();
GA.forEach(c => {
  if (!c.s) return;
  const s = c.s;
  if (byUrl.has(s.u)) { byUrl.get(s.u).counties.push(c.n); return; } // one regional layer can cover several counties
  const lb = s.b || c.b, area = Math.max((lb[2] - lb[0]) * (lb[3] - lb[1]), 0.01), dense = s.c / area > 300000;
  const src = makeCustom({id: 'ga' + c.fips, fips: c.fips, counties: [c.n], name: c.n + ' County', by: s.p, url: s.u, kind: s.gj ? 'geojson' : 'json', oid: s.o,
    fields: '*', bbox: lb, f: s.f, count: s.c, edited: s.e, minZoom: dense ? 15 : 13, cell: dense ? 0.008 : 0.03, download: s.c <= 30000, catalog: true});
  byUrl.set(s.u, src); PARCEL_SOURCES.push(src);
});
byUrl.forEach(src => { if (src.counties.length > 1) src.name = src.counties.map(n => n).join(' / ') + ' Counties'; });
const LEGACY_URL = {twiggs: 'Twiggs_County_Parcels/FeatureServer/0', wilkinson: 'Wilkinson_GA_gdb/FeatureServer/0', cobb: 'CobbParcels/FeatureServer/0'};
{ // layers added with the finder that the catalog now covers would load twice, so drop them
  const cs = ls.get('customSrc', []), keep = cs.filter(c => !byUrl.has(c.url));
  if (keep.length !== cs.length) ls.set('customSrc', keep);
  keep.forEach(c => PARCEL_SOURCES.push(makeCustom(c)));
}
const countyOf = (lat, lon) => {
  const pt = [lon, lat];
  return GA.find(c => c.g && lon >= c.b[0] && lon <= c.b[2] && lat >= c.b[1] && lat <= c.b[3] && c.g.some(poly => inRing(pt, poly))) || null;
};
const LIVE = {}; // id -> {feat: Map, cells: Set, done, layer}
const liveIndex = [];
function initLive(src) {
  LIVE[src.id] = {feat: new Map(), cells: new Set(), done: false, layer: L.geoJSON(null, {
    style: {color: '#ffd400', weight: 2, opacity: .95, fillColor: '#ffd400', fillOpacity: .03},
    onEachFeature: (f, l) => { l.bindPopup(() => parcelPopup(f)); liveIndex.push({f, l, src: src.id}); }
  })};
  LIVE[src.id].layer.addTo(parcelLayer);
}
PARCEL_SOURCES.forEach(initLive);
const allParcels = () => liveIndex.concat(fileIndex);
function addLive(src, feats, cached) {
  const st = LIVE[src.id], fresh = [];
  for (const f of feats || []) {
    if (!f.geometry || !/Polygon/.test(f.geometry.type)) continue;
    const id = f.id ?? (src.oid && f.properties?.[src.oid]) ?? f.properties?.OBJECTID ?? f.properties?.FID;
    if (id == null || st.feat.has(id)) continue;
    const nf = {type: 'Feature', id, geometry: f.geometry, properties: cached ? f.properties : Object.assign(src.map(f.properties || {}), {Source: `${src.name} · ${src.by}`})};
    st.feat.set(id, nf); fresh.push(nf);
  }
  if (fresh.length) { st.layer.addData(fresh); updateParcelHere(); }
  return fresh.length;
}
const saveLiveT = {};
function saveLive(src) {
  clearTimeout(saveLiveT[src.id]);
  saveLiveT[src.id] = setTimeout(() => { const st = LIVE[src.id]; kvSet('live:' + src.id, {features: [...st.feat.values()], cells: [...st.cells], done: st.done}).catch(() => {}); }, 1500);
}
const qGeo = (src, extra) => `${src.url}/query?outFields=${src.fields}&outSR=4326&f=${src.kind === 'json' ? 'json' : 'geojson'}&geometryPrecision=6&maxAllowableOffset=0.000004&resultRecordCount=2000${extra}`;
// Older map services only speak Esri JSON. Esri marks outer rings clockwise and holes counter-clockwise.
function esriToGeo(j, oid) {
  const signed = r => { let a = 0; for (let i = 0, k = r.length - 1; i < r.length; k = i++) a += (r[i][0] - r[k][0]) * (r[i][1] + r[k][1]); return a; };
  return (j.features || []).map(ft => {
    const rings = ft.geometry && ft.geometry.rings; if (!rings || !rings.length) return null;
    const polys = [];
    for (const r of rings) { if (signed(r) > 0 || !polys.length) polys.push([r]); else polys[polys.length - 1].push(r); }
    const a = ft.attributes || {};
    return {type: 'Feature', id: a[oid] ?? a.OBJECTID ?? a.FID, properties: a, geometry: polys.length === 1 ? {type: 'Polygon', coordinates: polys[0]} : {type: 'MultiPolygon', coordinates: polys}};
  }).filter(Boolean);
}
async function fetchAll(src, extra, onPage) {
  let off = 0;
  for (let guard = 0; guard < 300; guard++) {
    const r = await fetch(qGeo(src, extra + `&resultOffset=${off}`)); if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json(); if (j.error) throw new Error(j.error.message || 'service error');
    const fs = src.kind === 'json' ? esriToGeo(j, src.oid) : (j.features || []); addLive(src, fs); off += fs.length; onPage && onPage(off);
    if (!fs.length || !(j.exceededTransferLimit || j.properties?.exceededTransferLimit)) break;
  }
}
let liveBusy = 0;
function bboxHits(b, bb) { return !(b.getEast() < bb[0] || b.getWest() > bb[2] || b.getNorth() < bb[1] || b.getSouth() > bb[3]); }
async function loadLiveParcels() {
  if (!S.showParcels || !navigator.onLine) return;
  const b = map.getBounds().pad(0.1), z = map.getZoom();
  for (const src of PARCEL_SOURCES) {
    const st = LIVE[src.id];
    if (st.done || z < src.minZoom || !bboxHits(b, src.bbox)) continue;
    const c = src.cell, cells = [];
    for (let x = Math.floor(b.getWest() / c); x <= Math.floor(b.getEast() / c); x++)
      for (let y = Math.floor(b.getSouth() / c); y <= Math.floor(b.getNorth() / c); y++) {
        const k = x + ',' + y; if (st.cells.has(k)) continue;
        const e = [x*c, y*c, (x+1)*c, (y+1)*c]; if (!bboxHits(L.latLngBounds([e[1], e[0]], [e[3], e[2]]), src.bbox)) continue;
        cells.push([k, e]);
      }
    for (const [k, e] of cells.slice(0, 12)) {
      st.cells.add(k); liveBusy++;
      fetchAll(src, `&geometry=${e.join(',')}&geometryType=esriGeometryEnvelope&inSR=4326&spatialRel=esriSpatialRelIntersects`)
        .then(() => saveLive(src)).catch(() => st.cells.delete(k)).finally(() => { liveBusy--; });
    }
  }
}
async function saveCounty(src, btn) {
  if (!navigator.onLine) return toast('Needs signal');
  btn.disabled = true;
  try {
    await fetchAll(src, '&where=1%3D1', n => btn.textContent = `Saving… ${n.toLocaleString()}`);
    LIVE[src.id].done = true; saveLive(src); toast(`${src.name} saved for offline`);
  } catch (e) { toast('Download stopped: ' + e.message); }
  btn.disabled = false; renderSources();
}
function renderSources() {
  const box = $('#srcList'); if (!box) return;
  const withSrc = GA.filter(c => c.s), own = GA.filter(c => c.s && c.s.f.owner);
  $('#catSummary').innerHTML = `Free property lines for <b>${withSrc.length} of ${GA.length}</b> Georgia counties (<b>${own.length}</b> with owner names). They load on their own as you zoom in. Anywhere you've looked stays on your phone for offline use. Save a whole county before you head out.`;
  const here = countyOf(map.getCenter().lat, map.getCenter().lng), hereSrc = here && srcForCounty(here);
  const show = PARCEL_SOURCES.filter(src => src === hereSrc || src.custom || LIVE[src.id]?.feat.size);
  const row = src => { const st = LIVE[src.id];
    return `<div class="camrow" style="cursor:default;padding:9px 10px"><div class="grow"><div class="nm">${esc(src.name)}${src === hereSrc ? ' <span class="badge" style="background:#1d3a2a;color:#9be3b5">ON MAP</span>' : ''}</div>
      <div class="small muted">by ${esc(src.by)}${src.edited ? ' · updated ' + new Date(src.edited).toLocaleDateString([], {month: 'short', year: 'numeric'}) : ''}${src.f && !src.f.owner ? ' · lines only' : ''}</div>
      <div class="small">${st.feat.size.toLocaleString()} parcels on this phone${st.done ? ' · <span class="good">whole county saved ✔</span>' : ''}</div></div>
      <div style="display:flex;flex-direction:column;gap:6px">${src.download && !st.done ? `<button class="btn sm" data-save="${src.id}">Save county</button>` : ''}${src.custom ? `<button class="btn sm" data-rm="${src.id}">Remove</button>` : ''}</div></div>`; };
  box.innerHTML = (here && !hereSrc ? `<div class="small warn">The map is on ${esc(here.n)} County, which has no free property lines yet. Try "Find another layer" below, or load a county file.</div>` : '') +
    (show.length ? show.map(row).join('') : '<div class="small muted">Nothing saved yet. Pan to your land and zoom in.</div>');
  box.querySelectorAll('[data-save]').forEach(b => b.onclick = () => saveCounty(PARCEL_SOURCES.find(s => s.id === b.dataset.save), b));
  box.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => removeSource(b.dataset.rm));
}
function removeSource(id) {
  const i = PARCEL_SOURCES.findIndex(s => s.id === id); if (i < 0) return;
  PARCEL_SOURCES.splice(i, 1);
  parcelLayer.removeLayer(LIVE[id].layer); delete LIVE[id];
  for (let k = liveIndex.length - 1; k >= 0; k--) if (liveIndex[k].src === id) liveIndex.splice(k, 1);
  ls.set('customSrc', ls.get('customSrc', []).filter(c => c.id !== id));
  idbReq('kv', 'readwrite', t => { t.objectStore('kv').delete('live:' + id); }).catch(() => {});
  renderSources(); updateParcelHere(); zoomHint();
}

/* Find free public parcel layers for any county (searches ArcGIS Online's public catalog) */
let findCands = [];
async function findCounty() {
  const raw = $('#findCounty').value.trim(), box = $('#findResults');
  if (raw.length < 3) return toast('Type a county name');
  if (!navigator.onLine) return toast('Needs signal');
  const name = raw.replace(/\s*county\s*/i, ' ').trim();
  box.innerHTML = '<div class="small muted">Searching public map layers… (10–20 seconds)</div>';
  const J = u => fetch(u).then(r => r.json());
  const seen = new Set(), items = [];
  for (const q of [`${name} parcels`, `${name} county tax parcels`, `${name} GA parcels`, `${name} County Georgia`]) {
    try {
      const j = await J('https://www.arcgis.com/sharing/rest/search?f=json&num=40&q=' + encodeURIComponent(q + ' type:"Feature Service" access:public'));
      for (const it of j.results || []) if (it.url && !seen.has(it.url)) { seen.add(it.url); items.push(it); }
    } catch (e) {}
  }
  const key = name.toLowerCase();
  const rel = items.filter(it => [it.title, it.snippet, it.name, (it.tags || []).join(' ')].join(' ').toLowerCase().includes(key)).slice(0, 14);
  const cands = [];
  await Promise.all(rel.map(async it => {
    try {
      const base = it.url.replace(/\/$/, '');
      const svc = await J(base + '?f=json');
      // An item can point at a whole service (with a list of layers) or straight at one layer.
      const layers = svc.layers ? svc.layers.slice(0, 8).map(l => ({u: base + '/' + l.id, gt: l.geometryType}))
        : svc.geometryType ? [{u: base, gt: svc.geometryType, info: svc}] : [];
      for (const l of layers) {
        if (l.gt && l.gt !== 'esriGeometryPolygon') continue;
        const u = l.u, info = l.info || await J(u + '?f=json');
        if (info.geometryType !== 'esriGeometryPolygon') continue;
        const names = (info.fields || []).map(f => f.name);
        const pf = k => (FEXACT[k] && names.find(n => FEXACT[k].includes(n.toUpperCase()))) || names.find(n => FRX[k].test(n) && !(FSKIP[k] && FSKIP[k].test(n))) || null;
        const f = {owner: pf('owner'), acres: pf('acres'), id: pf('id'), addr: pf('addr')};
        if (!f.id && !f.owner && !f.acres) continue;
        const [cnt, ext] = await Promise.all([J(u + '/query?where=1%3D1&returnCountOnly=true&f=json'), J(u + '/query?where=1%3D1&returnExtentOnly=true&outSR=4326&f=json')]);
        const e = ext.extent; if (!e || !isFinite(e.xmin) || !cnt.count) continue;
        let sample = [];
        if (f.owner) { const sm = await J(u + `/query?where=1%3D1&outFields=${encodeURIComponent(f.owner)}&returnGeometry=false&resultRecordCount=6&f=json`); sample = (sm.features || []).map(x => clean(x.attributes[f.owner])).filter(v => v && v.length > 3 && /[a-z]{2}/i.test(v)).slice(0, 2); if (!sample.length) f.owner = null; }
        const cx = (e.xmin + e.xmax) / 2, cy = (e.ymin + e.ymax) / 2, inGA = cx > -85.7 && cx < -80.7 && cy > 30.3 && cy < 35.1;
        cands.push({title: it.title, pub: it.owner, url: u, count: cnt.count, f, bbox: [e.xmin, e.ymin, e.xmax, e.ymax], edited: info.editingInfo?.lastEditDate || it.modified, sample, inGA});
      }
    } catch (e) {}
  }));
  // Georgia only (there are Grady Counties in other states too); fall back to anything if Georgia has none.
  const ga = cands.filter(c => c.inGA), pool = ga.length ? ga : cands;
  pool.sort((a, b) => (!!b.sample.length - !!a.sample.length) || (!!b.f.owner - !!a.f.owner) || (b.edited - a.edited));
  findCands = pool;
  if (!pool.length) { box.innerHTML = `<div class="small muted">No free public parcel layer found for "${esc(raw)}". You can still load a purchased county file below.</div>`; return; }
  box.innerHTML = (ga.length ? '' : '<div class="small warn">Nothing found in Georgia. These are from other states:</div>') + pool.slice(0, 8).map((c, i) => `<div class="camrow" style="cursor:default;padding:9px 10px;align-items:flex-start"><div class="grow">
      <div class="nm">${esc(c.title)}</div><div class="small muted">by ${esc(c.pub)} · ${c.count.toLocaleString()} parcels${c.edited ? ' · updated ' + new Date(c.edited).toLocaleDateString([], {month: 'short', year: 'numeric'}) : ''}</div>
      <div class="small">${c.sample.length ? `<span class="good">Owner names ✓</span> <span class="muted">e.g. ${esc(c.sample[0])}</span>` : '<span class="warn">Lines only, no owner names</span>'}</div></div>
      <button class="btn sm primary" data-use="${i}">Use</button></div>`).join('') +
    '<div class="small muted">These are layers that counties, regional commissions, and others have shared publicly. Pick the newest one with owner names. After you add it, the map jumps there so you can check it covers the right area.</div>';
  box.querySelectorAll('[data-use]').forEach(b => b.onclick = () => useCand(findCands[+b.dataset.use], raw));
}
function useCand(c, label) {
  const area = Math.max((c.bbox[2] - c.bbox[0]) * (c.bbox[3] - c.bbox[1]), 0.005), dense = c.count / area > 300000;
  const nm = /county/i.test(label) ? label.replace(/\b\w/g, ch => ch.toUpperCase()) : label.replace(/\b\w/g, ch => ch.toUpperCase()) + ' County';
  const cfg = {id: 'c_' + uid(), name: nm, by: c.pub, url: c.url, fields: '*', bbox: c.bbox, minZoom: dense ? 15 : 13, cell: dense ? 0.008 : 0.03, download: c.count <= 30000, f: c.f, custom: true};
  ls.set('customSrc', [...ls.get('customSrc', []), cfg]);
  const src = makeCustom(cfg); PARCEL_SOURCES.push(src); initLive(src);
  $('#findResults').innerHTML = ''; $('#findCounty').value = '';
  renderSources(); showPage('map');
  map.fitBounds([[c.bbox[1], c.bbox[0]], [c.bbox[3], c.bbox[2]]]);
  toast(`${nm} added. Zoom in to see property lines.`, 4000);
}
map.on('moveend', () => loadLiveParcels());

/* ---------- parcels ---------- */
const RX = {owner: /(^|_)(own|ownr|owner|owners|ownername|owner_name|ownernme1|name1|grantee|taxpayer)/i, acres: /acre|acrg|_ac$|^ac$|calc_?ac/i,
  id: /^(pin|apn|parcel|parcelid|parcel_id|parcelno|parcel_no|parcelnum|realkey|pid|parno|map_?parcel)$/i, addr: /situs|site_?addr|prop_?addr|location|parceladdr|address/i};
function pick(props, rx) { for (const k in props) if (rx.test(k) && props[k] != null && String(props[k]).trim() !== '') return [k, props[k]]; return null; }
function ringsOf(g) { if (!g) return []; if (g.type === 'Polygon') return [g.coordinates]; if (g.type === 'MultiPolygon') return g.coordinates; return []; }
function ringArea(r, lat0) { const k = 111320, kx = k * Math.cos(lat0 * rad); let a = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0]*kx)*(r[i][1]*k) - (r[i][0]*kx)*(r[j][1]*k); return Math.abs(a / 2); }
function acresOf(g) { const ps = ringsOf(g); if (!ps.length) return null; const lat0 = ps[0][0][0][1]; let m2 = 0; ps.forEach(p => p.forEach((r, i) => m2 += i === 0 ? ringArea(r, lat0) : -ringArea(r, lat0))); return m2 / 4046.86; }
function inRing(pt, r) { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, yi] = r[i], [xj, yj] = r[j]; if (((yi > pt[1]) !== (yj > pt[1])) && (pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi)) c = !c; } return c; }
function inGeom(pt, g) { return ringsOf(g).some(p => inRing(pt, p[0]) && !p.slice(1).some(h => inRing(pt, h))); }
function parcelSummary(f) {
  const pr = f.properties || {};
  if ('Source' in pr && 'Owner' in pr) return {owner: pr.Owner || '(owner not in this free data)', acres: pr.Acres ?? null, id: pr['Parcel ID'] ?? null, addr: pr.Address ?? null, calc: acresOf(f.geometry)};
  const o = pick(pr, RX.owner), a = pick(pr, RX.acres), id = pick(pr, RX.id), ad = pick(pr, RX.addr);
  return {owner: o ? o[1] : '(owner field not found)', acres: a ? a[1] : null, id: id ? id[1] : null, addr: ad ? ad[1] : null, calc: acresOf(f.geometry)};
}
function parcelPopup(f) {
  const s = parcelSummary(f), pr = f.properties || {};
  const rows = Object.entries(pr).filter(([k, v]) => v !== null && v !== '').map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('');
  return `<div><div style="font-size:16px;font-weight:700;color:var(--yellow)">${esc(s.owner)}</div>
    <div class="small">${s.id ? 'Parcel ' + esc(s.id) + ' · ' : ''}${s.acres != null ? esc(s.acres) + ' ac (tax)' : ''}${s.calc ? ` · ${s.calc.toFixed(1)} ac (drawn)` : ''}</div>
    ${s.addr ? `<div class="small muted">${esc(s.addr)}</div>` : ''}
    ${pr['Land cover'] ? `<div class="small" style="margin-top:4px">🌲 ${esc(pr['Land cover'])}</div>` : ''}
    <details style="margin-top:6px"><summary class="small">All fields</summary><table class="attrs">${rows}</table></details></div>`;
}
let fileIndex = [];
const fileGroup = L.layerGroup().addTo(parcelLayer);
function buildParcelLayer() {
  fileGroup.clearLayers(); fileIndex = [];
  S.parcelSets.forEach(set => L.geoJSON(set.fc, {
    style: {color: '#ffd400', weight: 2, opacity: .95, fillColor: '#ffd400', fillOpacity: .03},
    onEachFeature: (f, l) => { l.bindPopup(() => parcelPopup(f)); fileIndex.push({f, l}); }
  }).addTo(fileGroup));
  syncParcelVisibility();
  const n = fileIndex.length;
  $('#parcelStatus').innerHTML = n ? `<b>${n.toLocaleString()}</b> parcels from ${S.parcelSets.map(s => esc(s.name)).join(', ')}` : 'No extra files loaded.';
  updateParcelHere();
}
function updateParcelHere() {
  let top = '', cardHtml = '';
  const idx = allParcels();
  if (S.me && idx.length) {
    const hit = idx.find(x => inGeom([S.me[1], S.me[0]], x.f.geometry));
    if (hit) { const s = parcelSummary(hit.f); top = `🏠 On: ${s.owner}${s.acres != null ? ' · ' + s.acres + ' ac' : ''}`; cardHtml = `<h3>You're standing on</h3>` + parcelPopup(hit.f); }
    else top = '🏠 Not inside a loaded parcel';
  }
  $('#topParcel').textContent = top;
  const c = $('#landHereCard'); c.innerHTML = cardHtml; c.style.display = cardHtml ? 'block' : 'none';
}
function normalizeFC(gj) {
  if (Array.isArray(gj)) gj = {type: 'FeatureCollection', features: gj.flatMap(x => x.features || [])};
  if (gj.type === 'Feature') gj = {type: 'FeatureCollection', features: [gj]};
  if (!gj.features) throw new Error('No features found in that file');
  gj.features = gj.features.filter(f => f.geometry && /Polygon/.test(f.geometry.type));
  if (!gj.features.length) throw new Error('No property polygons in that file');
  const c = gj.features[0].geometry.coordinates.flat(3);
  if (Math.abs(c[0]) > 180 || Math.abs(c[1]) > 90) throw new Error('This file is not in latitude/longitude. Zip the shapefile with its .prj, or export it as GeoJSON (WGS84).');
  return gj;
}
$('#bLoadParcels').onclick = () => $('#fParcels').click();
$('#bFindCounty').onclick = findCounty;
$('#findCounty').addEventListener('keydown', e => { if (e.key === 'Enter') findCounty(); });
$('#fParcels').onchange = async e => {
  const f = e.target.files[0]; if (!f) return; e.target.value = '';
  $('#parcelStatus').textContent = 'Reading ' + f.name + '…';
  try {
    const n = f.name.toLowerCase(); let gj;
    if (n.endsWith('.zip')) gj = await shp(await f.arrayBuffer());
    else if (n.endsWith('.kml')) gj = toGeoJSON.kml(new DOMParser().parseFromString(await f.text(), 'text/xml'));
    else gj = JSON.parse(await f.text());
    const fc = normalizeFC(gj);
    S.parcelSets.push({name: f.name, fc});
    try { await kvSet('parcels', S.parcelSets); } catch (err) { toast('Loaded, but it could not be saved for offline: ' + err.message, 5000); }
    buildParcelLayer();
    const b = L.geoJSON(fc).getBounds(); if (b.isValid()) { showPage('map'); map.fitBounds(b); }
    toast(`Loaded ${fc.features.length.toLocaleString()} parcels`);
  } catch (err) { $('#parcelStatus').innerHTML = `<span class="bad">${esc(err.message)}</span>`; }
};
$('#bClearParcels').onclick = async () => { S.parcelSets = []; try { await kvSet('parcels', []); } catch (e) {} buildParcelLayer(); };
$('#ownerSearch').oninput = e => {
  const q = e.target.value.trim().toLowerCase(), box = $('#ownerResults');
  if (q.length < 2) { box.innerHTML = ''; return; }
  const hits = []; for (const x of allParcels()) { const s = parcelSummary(x.f); if ([s.owner, s.id, s.addr].join(' ').toLowerCase().includes(q)) { hits.push({x, s}); if (hits.length >= 40) break; } }
  box.innerHTML = hits.length ? hits.map((h, i) => `<div class="camrow" data-i="${i}" style="padding:8px 10px;margin-top:8px"><div class="grow"><div class="nm">${esc(h.s.owner)}</div><div class="small muted">${h.s.acres != null ? esc(h.s.acres) + ' ac · ' : ''}${esc(h.s.id || '')} ${esc(h.s.addr || '')}</div></div></div>`).join('') : '<div class="small muted" style="margin-top:8px">No matches</div>';
  box.querySelectorAll('.camrow').forEach(el => el.onclick = () => { const h = hits[+el.dataset.i]; showPage('map'); map.fitBounds(h.x.l.getBounds(), {maxZoom: 17}); setTimeout(() => h.x.l.openPopup(h.x.l.getBounds().getCenter()), 350); });
};

/* =========================================================
   TRAIL CAMERAS
   ========================================================= */
const TAGS = [['buck','Buck'],['doe','Doe'],['fawn','Fawn'],['hog','Hog'],['turkey','Turkey'],['coyote','Coyote'],['bear','Bear'],['person','Person'],['other','Other'],['empty','Empty']];
const ANIMAL = new Set(['buck','doe','fawn','hog','turkey','coyote','bear','other']);
const thumbURL = new Map();
async function thumbOf(id) {
  if (thumbURL.has(id)) return thumbURL.get(id);
  const b = await blobGet(id); const u = b?.thumb ? URL.createObjectURL(b.thumb) : ''; thumbURL.set(id, u); return u;
}
const cams = () => S.pins.filter(p => p.type === 'camera');
const camName = id => { const c = S.pins.find(p => p.id === id); return c ? (c.name || 'Camera') : 'Unassigned'; };

/* EXIF DateTimeOriginal (trail cams write the camera's clock time) */
async function exifTime(file) {
  try {
    const buf = await file.slice(0, 262144).arrayBuffer(), v = new DataView(buf);
    if (v.getUint16(0) !== 0xFFD8) return null;
    let o = 2;
    while (o < v.byteLength - 4) {
      const m = v.getUint16(o); if ((m & 0xFF00) !== 0xFF00) break;
      const len = v.getUint16(o + 2);
      if (m === 0xFFE1 && v.getUint32(o + 4) === 0x45786966) {
        const t = o + 10, le = v.getUint16(t) === 0x4949;
        const g16 = p => v.getUint16(p, le), g32 = p => v.getUint32(p, le);
        const SZ = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];
        const ifd = off => { const n = g16(t + off), out = {}; for (let i = 0; i < n; i++) { const e = t + off + 2 + i*12, tag = g16(e), type = g16(e + 2), cnt = g32(e + 4); out[tag] = {cnt, at: cnt * (SZ[type] || 1) > 4 ? t + g32(e + 8) : e + 8}; } return out; };
        const str = en => { let s = ''; for (let i = 0; i < en.cnt - 1; i++) s += String.fromCharCode(v.getUint8(en.at + i)); return s; };
        const i0 = ifd(g32(t + 4)); let dt = null;
        if (i0[0x8769]) { const ex = ifd(g32(i0[0x8769].at)); if (ex[0x9003]) dt = str(ex[0x9003]); }
        if (!dt && i0[0x0132]) dt = str(i0[0x0132]);
        const mm = dt && dt.match(/(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/);
        return mm ? new Date(+mm[1], mm[2] - 1, +mm[3], +mm[4], +mm[5], +mm[6]).getTime() : null;
      }
      o += 2 + len;
    }
  } catch (e) {}
  return null;
}
async function shrink(file, max, q) {
  let src;
  try { src = await createImageBitmap(file); }
  catch (e) { src = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); }); }
  const w = src.width, h = src.height, s = Math.min(1, max / Math.max(w, h));
  const c = document.createElement('canvas'); c.width = Math.round(w * s); c.height = Math.round(h * s);
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return new Promise(r => c.toBlob(r, 'image/jpeg', q));
}

let importCam = null;
$('#fPhotos').onchange = async e => {
  const files = [...e.target.files]; e.target.value = '';
  if (!files.length || !importCam) return;
  try { await navigator.storage?.persist?.(); } catch (_) {}
  const prog = $('#impProg'), msg = $('#impMsg');
  if (prog) { prog.style.display = 'block'; prog.max = files.length; prog.value = 0; }
  let ok = 0, bad = 0;
  for (const f of files) {
    try {
      const t = (await exifTime(f)) || f.lastModified || Date.now();
      const [full, thumb] = [await shrink(f, 1800, 0.82), await shrink(f, 360, 0.7)];
      const meta = {id: uid(), cam: importCam, t, tags: [], w: null, name: f.name, added: Date.now()};
      await photoAdd(meta, {full, thumb}); S.photos.push(meta); ok++;
    } catch (err) { bad++; }
    if (prog) prog.value = ok + bad; if (msg) msg.textContent = `Importing ${ok + bad} of ${files.length}…`;
  }
  toast(`Added ${ok} photo${ok === 1 ? '' : 's'}${bad ? ` (${bad} failed)` : ''}`);
  renderCams(); enrichWeather();
};

/* weather at the time of each photo (Open-Meteo history) */
let enriching = false;
async function enrichWeather() {
  if (enriching || !navigator.onLine) return; enriching = true;
  try {
    const todo = S.photos.filter(p => !p.w && p.cam && S.pins.find(c => c.id === p.cam));
    const groups = {}; todo.forEach(p => (groups[p.cam] ||= []).push(p));
    for (const [camId, list] of Object.entries(groups)) {
      const c = S.pins.find(x => x.id === camId);
      const cutoff = Date.now() - 6 * 86400000;
      for (const part of [list.filter(p => p.t < cutoff), list.filter(p => p.t >= cutoff)]) {
        if (!part.length) continue;
        const d = x => new Date(x).toISOString().slice(0, 10);
        const t0 = Math.min(...part.map(p => p.t)), t1 = Math.max(...part.map(p => p.t));
        const host = part[0].t < cutoff ? 'https://archive-api.open-meteo.com/v1/archive' : 'https://api.open-meteo.com/v1/forecast';
        const u = `${host}?latitude=${c.lat.toFixed(4)}&longitude=${c.lon.toFixed(4)}&start_date=${d(t0 - 86400000)}&end_date=${d(Math.min(t1 + 86400000, Date.now()))}` +
          `&hourly=temperature_2m,wind_speed_10m,wind_direction_10m,pressure_msl&wind_speed_unit=mph&temperature_unit=fahrenheit&timezone=GMT`;
        try {
          const r = await fetch(u); if (!r.ok) continue; const j = await r.json(), h = j.hourly; if (!h?.time) continue;
          const ts = h.time.map(x => Date.parse(x + ':00Z'));
          for (const p of part) {
            const i = Math.round((p.t - ts[0]) / 3600000);
            if (i < 0 || i >= ts.length || h.wind_direction_10m[i] == null) continue;
            p.w = {wd: h.wind_direction_10m[i], ws: h.wind_speed_10m[i], temp: h.temperature_2m[i], p: h.pressure_msl[i]};
            await photoPutMeta(p);
          }
        } catch (_) {}
      }
    }
  } finally { enriching = false; }
}
const moonOf = t => SunCalc.getMoonIllumination(new Date(t)).phase;

/* --- camera pages --- */
let camView = null, tagFilter = 'all', selMode = false, selected = new Set();
function openCamera(id) { camView = id; tagFilter = 'all'; selMode = false; selected.clear(); showPage('cams'); }
async function renderCams() {
  const body = $('#camsBody'), act = $('#camsActions');
  if (!camView) {
    $('#camsTitle').textContent = 'Cameras';
    act.innerHTML = `<button class="btn sm primary" id="bNewCam">＋ Camera</button>`;
    $('#bNewCam').onclick = () => startDrop('camera', null, p => { toast('Camera placed. Name it, then add photos.'); pinMarkers[p.id].openPopup(); });
    const list = cams();
    if (!list.length) { body.innerHTML = `<div class="card"><h3>No cameras yet</h3><div class="muted small">Tap <b>＋ Camera</b> to place a trail camera on the map. Then load photos from its SD card or your camera roll. Each photo gets the wind, temperature, and moon phase from when it was taken, and that's what builds your activity charts.</div></div>`; return; }
    body.innerHTML = '<div class="list">' + list.map(c => {
      const ph = S.photos.filter(p => p.cam === c.id).sort((a, b) => b.t - a.t);
      const counts = {}; ph.forEach(p => p.tags.forEach(t => counts[t] = (counts[t] || 0) + 1));
      const top = Object.entries(counts).filter(([k]) => k !== 'empty').sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${TAGS.find(t => t[0] === k)[1]} ${n}`).join(' · ');
      return `<div class="camrow" data-id="${c.id}"><div class="camthumb" data-thumb="${ph[0]?.id || ''}">${ph.length ? '' : 'No photos'}</div>
        <div class="grow"><div class="nm">${esc(c.name || 'Unnamed camera')}</div><div class="small muted">${ph.length} photos${ph[0] ? ' · last ' + fmtDate(ph[0].t) : ''}</div><div class="small">${top || '<span class="muted">No tags yet</span>'}</div></div>
        <div class="muted">›</div></div>`;
    }).join('') + '</div>';
    body.querySelectorAll('.camrow').forEach(el => el.onclick = () => openCamera(el.dataset.id));
    body.querySelectorAll('[data-thumb]').forEach(async el => { if (el.dataset.thumb) el.style.backgroundImage = `url(${await thumbOf(el.dataset.thumb)})`; });
    return;
  }
  // single camera gallery
  const c = S.pins.find(p => p.id === camView); if (!c) { camView = null; return renderCams(); }
  $('#camsTitle').textContent = c.name || 'Unnamed camera';
  act.innerHTML = `<button class="btn sm" id="bCamBack">‹ All</button><button class="btn sm" id="bCamMap">Map</button><button class="btn sm primary" id="bCamAdd">＋ Photos</button>`;
  $('#bCamBack').onclick = () => { camView = null; renderCams(); };
  $('#bCamMap').onclick = () => { showPage('map'); map.setView([c.lat, c.lon], 17); };
  $('#bCamAdd').onclick = () => { importCam = c.id; $('#fPhotos').click(); };
  const all = S.photos.filter(p => p.cam === c.id).sort((a, b) => b.t - a.t);
  const counts = {untagged: all.filter(p => !p.tags.length).length}; all.forEach(p => p.tags.forEach(t => counts[t] = (counts[t] || 0) + 1));
  const chips = [['all', 'All', all.length], ['untagged', 'Untagged', counts.untagged], ...TAGS.filter(([k]) => counts[k]).map(([k, n]) => [k, n, counts[k]])];
  const shown = all.filter(p => tagFilter === 'all' ? true : tagFilter === 'untagged' ? !p.tags.length : p.tags.includes(tagFilter));
  let html = `<progress id="impProg" style="display:none"></progress><div class="small muted" id="impMsg"></div>
    <div class="chipbar">${chips.map(([k, n, ct]) => `<div class="chip${tagFilter === k ? ' on' : ''}" data-f="${k}">${n}<span class="n">${ct}</span></div>`).join('')}</div>
    <div class="row" style="justify-content:space-between;margin-bottom:4px"><span class="small muted">${shown.length} shown${all.some(p => !p.w) && navigator.onLine ? ' · adding weather…' : ''}</span><button class="btn sm" id="bSel">${selMode ? 'Done' : 'Select'}</button></div>`;
  if (!all.length) html += `<div class="card muted small">No photos yet. Tap <b>＋ Photos</b> and pick them from your camera roll, or from the SD card through a card reader. The date and time come from each photo's data.</div>`;
  let lastDay = '';
  html += '<div>';
  shown.forEach(p => {
    const day = fmtDate(p.t);
    if (day !== lastDay) { html += (lastDay ? '</div>' : '') + `<div class="dayhdr">${day}</div><div class="grid">`; lastDay = day; }
    html += `<div class="ph-cell${selected.has(p.id) ? ' sel' : ''}" data-id="${p.id}"><span class="tm">${fmtT(p.t)}</span>${p.tags.length ? `<span class="tg">${p.tags.map(t => TAGS.find(x => x[0] === t)[1]).join(', ')}</span>` : ''}</div>`;
  });
  html += (lastDay ? '</div>' : '') + '</div>';
  if (selMode) html += `<div id="selBar"><div class="small muted" style="margin-bottom:6px">${selected.size} selected · tag them all:</div><div class="chips">${TAGS.map(([k, n]) => `<div class="chip" data-bt="${k}">${n}</div>`).join('')}<div class="chip" data-bt="_clear">Clear tags</div><div class="chip" data-bt="_del" style="color:#ff8a80">Delete</div></div></div>`;
  body.innerHTML = html;
  body.querySelectorAll('.chip[data-f]').forEach(el => el.onclick = () => { tagFilter = el.dataset.f; renderCams(); });
  $('#bSel').onclick = () => { selMode = !selMode; selected.clear(); renderCams(); };
  body.querySelectorAll('.ph-cell').forEach(async el => {
    el.onclick = () => { if (selMode) { selected.has(el.dataset.id) ? selected.delete(el.dataset.id) : selected.add(el.dataset.id); el.classList.toggle('sel'); const s = $('#selBar .small'); if (s) s.textContent = `${selected.size} selected · tag them all:`; } else openViewer(shown.map(p => p.id), el.dataset.id); };
    el.style.backgroundImage = `url(${await thumbOf(el.dataset.id)})`;
  });
  body.querySelectorAll('[data-bt]').forEach(el => {
    let armed = false;
    el.onclick = async () => {
      const k = el.dataset.bt, ps = S.photos.filter(p => selected.has(p.id));
      if (!ps.length) return toast('Select some photos first');
      if (k === '_del') { if (!armed) { armed = true; el.textContent = `Delete ${ps.length}?`; return; } await photoDel(ps.map(p => p.id)); S.photos = S.photos.filter(p => !selected.has(p.id)); selected.clear(); renderCams(); return; }
      for (const p of ps) { p.tags = k === '_clear' ? [] : k === 'empty' ? ['empty'] : [...new Set([...p.tags.filter(t => t !== 'empty'), k])]; await photoPutMeta(p); }
      selected.clear(); toast('Tagged'); renderCams();
    };
  });
}

/* --- photo viewer --- */
let vList = [], vIdx = 0, vURL = null;
async function openViewer(ids, id) { vList = ids; vIdx = ids.indexOf(id); $('#viewer').classList.add('on'); await showPhoto(); }
async function showPhoto() {
  const p = S.photos.find(x => x.id === vList[vIdx]); if (!p) return closeViewer();
  if (vURL) URL.revokeObjectURL(vURL);
  const b = await blobGet(p.id); vURL = b?.full ? URL.createObjectURL(b.full) : ''; $('#vImg').src = vURL;
  $('#vTitle').innerHTML = `<b>${esc(camName(p.cam))}</b><br>${fmtDate(p.t)} · ${fmtT(p.t)} <span class="muted">(${vIdx + 1}/${vList.length})</span>`;
  const m = PHASES[phaseIdx(moonOf(p.t))];
  $('#vWx').innerHTML = p.w ? `<div class="row" style="gap:10px"><div style="width:30px;height:30px">${arrowSVG((p.w.wd + 180) % 360)}</div><div>Wind <b>${card(p.w.wd)} ${Math.round(p.w.ws)} mph</b> · ${Math.round(p.w.temp)}°F · ${(p.w.p / 33.8639).toFixed(2)} inHg<br><span class="muted">${m}</span></div></div>`
    : `<span class="muted">${m} · weather is added when you have signal</span>`;
  $('#vTags').innerHTML = TAGS.map(([k, n]) => `<div class="chip${p.tags.includes(k) ? ' on' : ''}" data-k="${k}">${n}</div>`).join('');
  $$('#vTags .chip').forEach(el => el.onclick = async () => {
    const k = el.dataset.k;
    if (p.tags.includes(k)) p.tags = p.tags.filter(t => t !== k);
    else p.tags = k === 'empty' ? ['empty'] : [...p.tags.filter(t => t !== 'empty'), k];
    await photoPutMeta(p); showPhoto();
  });
  $('#vPrev').style.visibility = vIdx > 0 ? 'visible' : 'hidden';
  $('#vNext').style.visibility = vIdx < vList.length - 1 ? 'visible' : 'hidden';
  $('#vDel').textContent = 'Delete'; vDelArmed = false;
}
let vDelArmed = false;
function closeViewer() { $('#viewer').classList.remove('on'); if (vURL) URL.revokeObjectURL(vURL); vURL = null; renderCams(); }
$('#vClose').onclick = closeViewer;
$('#vPrev').onclick = () => { if (vIdx > 0) { vIdx--; showPhoto(); } };
$('#vNext').onclick = () => { if (vIdx < vList.length - 1) { vIdx++; showPhoto(); } };
$('#vDel').onclick = async () => {
  if (!vDelArmed) { vDelArmed = true; $('#vDel').textContent = 'Tap again'; return; }
  const id = vList[vIdx]; await photoDel([id]); S.photos = S.photos.filter(p => p.id !== id); thumbURL.delete(id);
  vList.splice(vIdx, 1); if (!vList.length) return closeViewer(); vIdx = Math.min(vIdx, vList.length - 1); showPhoto();
};
(() => { let x0 = null; const el = $('.vimg');
  el.addEventListener('touchstart', e => x0 = e.touches[0].clientX, {passive: true});
  el.addEventListener('touchend', e => { if (x0 == null) return; const dx = e.changedTouches[0].clientX - x0; if (Math.abs(dx) > 50) (dx < 0 ? $('#vNext') : $('#vPrev')).click(); x0 = null; }); })();

/* =========================================================
   ACTIVITY + GAME PLAN
   ========================================================= */
function fillFilters() {
  const fc = $('#fCam'), cur = fc.value;
  fc.innerHTML = '<option value="all">All cameras</option>' + cams().map(c => `<option value="${c.id}">${esc(c.name || 'Unnamed camera')}</option>`).join('');
  if ([...fc.options].some(o => o.value === cur)) fc.value = cur;
  const fs = $('#fSpecies'), cs = fs.value;
  fs.innerHTML = '<option value="all">All animals</option>' + TAGS.filter(([k]) => ANIMAL.has(k)).map(([k, n]) => `<option value="${k}">${n}</option>`).join('');
  fs.value = cs || 'all';
  if (!fs.value) fs.value = 'all';
}
['#fCam', '#fSpecies', '#fPeriod'].forEach(s => $(s).onchange = renderActivity);
/* A sighting = tagged photos at one camera, grouped when less than 10 minutes apart (one deer = one burst). */
function sightings() {
  const cam = $('#fCam').value, sp = $('#fSpecies').value, days = +$('#fPeriod').value;
  const since = days ? Date.now() - days * 86400000 : 0;
  const ps = S.photos.filter(p => (cam === 'all' || p.cam === cam) && p.t >= since && (sp === 'all' ? p.tags.some(t => ANIMAL.has(t)) : p.tags.includes(sp)))
    .sort((a, b) => a.cam === b.cam ? a.t - b.t : a.cam < b.cam ? -1 : 1);
  const ev = []; let last = null;
  ps.forEach(p => { if (last && last.cam === p.cam && p.t - last.t < 10 * 60000) { last = p; return; } ev.push(p); last = p; });
  return {ev, photos: ps.length};
}
function barChart(id, labels, values, opts = {}) {
  const W = 340, H = 130, pl = 24, pb = 18, n = values.length, max = Math.max(1, ...values);
  const bw = (W - pl) / n, gap = Math.min(4, bw * 0.25);
  const peak = values.indexOf(Math.max(...values));
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H + 4}" role="img" aria-label="${esc(opts.title || '')}">`;
  (opts.shade || []).forEach(i => s += `<rect class="night" x="${pl + i*bw}" y="0" width="${bw}" height="${H - pb}"/>`);
  [0, .5, 1].forEach(f => { const y = (H - pb) * (1 - f) + 2; s += `<line class="grid" x1="${pl}" x2="${W}" y1="${y}" y2="${y}"/><text x="${pl - 4}" y="${y + 3}" text-anchor="end">${Math.round(max * f)}</text>`; });
  values.forEach((v, i) => {
    const h = (H - pb - 2) * v / max, x = pl + i*bw + gap/2, y = H - pb - h, w = bw - gap, r = Math.min(4, w/2, h);
    if (v > 0) s += `<path class="bar${opts.shade?.includes(i) ? ' dim' : ''}" d="M${x} ${H - pb}V${y + r}a${r} ${r} 0 0 1 ${r} ${-r}h${w - 2*r}a${r} ${r} 0 0 1 ${r} ${r}V${H - pb}z"/>`;
    if (i === peak && v > 0) s += `<text class="lbl" x="${x + w/2}" y="${y - 4}" text-anchor="middle">${v}</text>`;
    if (labels[i]) s += `<text x="${x + w/2}" y="${H - 4}" text-anchor="middle">${labels[i]}</text>`;
    s += `<rect class="hit" data-chart="${id}" data-i="${i}" x="${pl + i*bw}" y="0" width="${bw}" height="${H}"/>`;
  });
  return s + '</svg>';
}
function renderActivity() {
  fillFilters();
  const body = $('#actBody'), {ev, photos} = sightings(), spName = $('#fSpecies').selectedOptions[0]?.text || '';
  const tagged = S.photos.filter(p => p.tags.length).length;
  if (!S.photos.length) { body.innerHTML = `<div class="card"><h3>No photos yet</h3><div class="small muted">Add a camera on the Cameras tab, load photos, and tag them (Buck, Doe, Hog…). The charts here show when and in what weather your animals move.</div></div>`; return; }
  if (!ev.length) { body.innerHTML = `<div class="card small muted">No ${spName.toLowerCase()} sightings match these filters. You have ${S.photos.length} photos, ${tagged} tagged.</div>`; return; }
  const hours = Array(24).fill(0), wind = Array(8).fill(0), moon = Array(8).fill(0); let nW = 0;
  ev.forEach(p => { hours[new Date(p.t).getHours()]++; moon[phaseIdx(moonOf(p.t))]++; if (p.w) { wind[sector8(p.w.wd)]++; nW++; } });
  const temps = ev.filter(p => p.w).map(p => p.w.temp);
  let tl = [], tv = [];
  if (temps.length) { const lo = Math.floor(Math.min(...temps) / 10) * 10, hi = Math.floor(Math.max(...temps) / 10) * 10; for (let b = lo; b <= hi; b += 10) { tl.push(b + '°'); tv.push(temps.filter(t => t >= b && t < b + 10).length); } }
  const at = cams().find(c => c.id === $('#fCam').value) || cams()[0] || {lat: hereLatLon()[0], lon: hereLatLon()[1]};
  const w = legalWindow(Date.now(), at.lat, at.lon), srH = new Date(w.sunrise).getHours(), ssH = new Date(w.sunset).getHours();
  const night = [...Array(24).keys()].filter(h => h < srH || h > ssH);
  const pk = hours.indexOf(Math.max(...hours)), daylight = ev.filter(p => { const h = new Date(p.t).getHours(); return h >= srH && h <= ssH; }).length;
  const tips = {};
  tips.hour = i => `${fmtHr(i)}–${fmtHr((i + 1) % 24)}: ${hours[i]} sighting${hours[i] === 1 ? '' : 's'}`;
  tips.wind = i => `Wind from ${DIR8[i]}: ${wind[i]} sighting${wind[i] === 1 ? '' : 's'}`;
  tips.temp = i => `${tl[i]}s °F: ${tv[i]} sightings`;
  tips.moon = i => `${PHASES[i]}: ${moon[i]} sightings`;
  body.innerHTML = `
    <div class="stat"><div><b>${ev.length}</b><span>${esc(spName)} sightings</span></div><div><b>${fmtHr(pk)}</b><span>Peak hour</span></div><div><b>${Math.round(daylight / ev.length * 100)}%</b><span>In daylight</span></div></div>
    <div class="card"><h3>Game plan · next 3 days</h3><div id="gpBody"></div></div>
    <div class="card"><h3>Time of day</h3>${barChart('hour', hours.map((_, i) => i % 3 === 0 ? fmtHr(i) : ''), hours, {shade: night, title: 'Sightings by hour'})}<div class="tip" id="tip-hour">Tap a bar. Shaded hours are dark.</div></div>
    <div class="card"><h3>Wind direction (blowing from)</h3>${nW ? barChart('wind', DIR8, wind, {title: 'Sightings by wind'}) + `<div class="tip" id="tip-wind">${nW} of ${ev.length} sightings have weather attached.</div>` : '<div class="small muted">Weather gets attached when you are online and the camera is placed on the map.</div>'}</div>
    ${tv.length ? `<div class="card"><h3>Temperature</h3>${barChart('temp', tl, tv, {title: 'Sightings by temperature'})}<div class="tip" id="tip-temp">&nbsp;</div></div>` : ''}
    <div class="card"><h3>Moon phase</h3>${barChart('moon', PHASE_SHORT, moon, {title: 'Sightings by moon phase'})}<div class="tip" id="tip-moon">&nbsp;</div></div>
    <div class="small muted">Photos less than 10 minutes apart at the same camera count as one sighting, so a burst of 8 pictures of one buck counts once. With fewer than about 30 sightings, the patterns are mostly noise. These charts don't account for how many days each camera was out.</div>`;
  body.querySelectorAll('.hit').forEach(r => r.onclick = () => { const id = r.dataset.chart; $('#tip-' + id).textContent = tips[id](+r.dataset.i); });
  renderGamePlan(ev, hours, wind, nW);
}
function renderGamePlan(ev, hours, wind, nW) {
  const el = $('#gpBody');
  if (!S.wx) { el.innerHTML = '<div class="small muted">Needs a forecast. Open the Weather tab with signal.</div>'; return; }
  if (ev.length < 12) { el.innerHTML = `<div class="small muted">Needs at least 12 sightings of this animal (you have ${ev.length}). Keep tagging photos.</div>`; return; }
  const N = ev.length, meanW = nW / 8;
  const rateH = hours.map(c => (c + 0.5) / (N + 12));
  const windF = s => nW >= 15 ? Math.min(1.8, Math.max(0.5, (wind[s] + 1) / (meanW + 1))) : 1;
  const days = {};
  S.wx.hours.filter(h => h.t > Date.now() - 3600000 && isLegal(h.t, S.wx.lat, S.wx.lon)).forEach(h => {
    const k = new Date(h.t).toDateString(); (days[k] ||= []).push({h, score: rateH[new Date(h.t).getHours()] * windF(sector8(h.wd))});
  });
  const all = Object.values(days).flat(); if (!all.length) { el.innerHTML = '<div class="small muted">No forecast hours left in legal light.</div>'; return; }
  const max = Math.max(...all.map(x => x.score));
  el.innerHTML = Object.values(days).slice(0, 3).map(arr => {
    const best = arr.reduce((a, b) => b.score > a.score ? b : a);
    return `<div class="gp-day"><div class="row" style="justify-content:space-between"><b>${fmtDate(arr[0].h.t)}</b><span class="small">Best: <b>${fmtH(best.h.t)}</b> · ${card(best.h.wd)} wind</span></div>
      <div class="heat" style="grid-template-columns:repeat(${arr.length},1fr)">${arr.map(x => `<div title="${fmtH(x.h.t)}" style="opacity:${(0.12 + 0.88 * x.score / max).toFixed(2)}"></div>`).join('')}</div>
      <div class="heat-lbl" style="grid-template-columns:repeat(${arr.length},1fr)">${arr.map((x, i) => `<span>${i % 2 === 0 ? fmtH(x.h.t) : ''}</span>`).join('')}</div></div>`;
  }).join('') + `<div class="small muted">Brighter means more likely, based only on your photos. It's scored by when your sightings happen${nW >= 15 ? ' and which winds they happen on' : ''}, matched against the forecast. It's a pattern-match from your own data, not a deer movement model.</div>`;
}

/* ---------- offline tiles ---------- */
const lon2x = (lon, z) => Math.floor((lon + 180) / 360 * 2 ** z);
const lat2y = (lat, z) => Math.floor((1 - Math.log(Math.tan(lat * rad) + 1 / Math.cos(lat * rad)) / Math.PI) / 2 * 2 ** z);
const clampLat = v => Math.max(-85, Math.min(85, v)), clampLon = v => Math.max(-180, Math.min(179.9999, v));
// Tile ranges for the view. Counted with arithmetic so a zoomed-out view never builds a giant list.
function tileRanges() {
  const b = map.getBounds(), maxZ = +$('#dlMaxZ').value, minZ = Math.max(11, Math.min(Math.floor(map.getZoom()), maxZ) - 3), out = [];
  for (let z = minZ; z <= maxZ; z++) {
    const x0 = lon2x(clampLon(b.getWest()), z), x1 = lon2x(clampLon(b.getEast()), z), y0 = lat2y(clampLat(b.getNorth()), z), y1 = lat2y(clampLat(b.getSouth()), z);
    out.push({z, x0, x1, y0, y1, n: (x1 - x0 + 1) * (y1 - y0 + 1)});
  }
  return out;
}
const TILE_CAP = 6000;
const tileCount = () => 2 * tileRanges().reduce((a, r) => a + r.n, 0);
function tileList() {
  if (tileCount() > TILE_CAP) return null;
  const out = [];
  for (const key of ['usgsImg', 'usgsTopo']) for (const r of tileRanges())
    for (let x = r.x0; x <= r.x1; x++) for (let y = r.y0; y <= r.y1; y++) out.push(TILE[key].replace('{z}', r.z).replace('{x}', x).replace('{y}', y));
  return out;
}
function updateDlEstimate() {
  const el = $('#dlEstimate'); if (!el) return; const n = tileCount();
  el.innerHTML = n > TILE_CAP ? '<span class="warn">Area too big. Zoom the map in to your property first.</span>' : `${n.toLocaleString()} tiles, about ${Math.max(1, Math.round(n * 0.02))} MB`;
}
$('#dlMaxZ').onchange = updateDlEstimate;
$('#bDownload').onclick = async () => {
  if (!navigator.serviceWorker?.controller) { $('#dlMsg').innerHTML = '<span class="warn">Offline saving needs the app opened from its web address. Reload once after the first visit.</span>'; return; }
  const urls = tileList(); if (!urls) { toast('Too big. Zoom the map in to your property first.'); return; }
  try { await navigator.storage?.persist?.(); } catch (e) {}
  const prog = $('#dlProg'); prog.style.display = 'block'; prog.max = urls.length; prog.value = 0; let done = 0, fail = 0; const q = urls.slice();
  $('#bDownload').disabled = true;
  await Promise.all(Array.from({length: 6}, async () => { while (q.length) { const u = q.shift(); try { await fetch(u, {mode: 'no-cors'}); } catch (e) { fail++; } prog.value = ++done; $('#dlMsg').textContent = `${done} / ${urls.length}`; } }));
  $('#bDownload').disabled = false;
  $('#dlMsg').innerHTML = fail ? `<span class="warn">Saved with ${fail} misses. Run it again on better signal.</span>` : '<span class="good">Area saved for offline ✔</span>';
  renderOffStatus();
};
$('#bClearTiles').onclick = async () => { try { await caches.delete('hm-tiles'); toast('Saved map cleared'); } catch (e) {} renderOffStatus(); };
async function renderOffStatus() {
  const sw = !!navigator.serviceWorker?.controller; let tiles = '—', used = '';
  try { if (self.caches) { const c = await caches.open('hm-tiles'); tiles = (await c.keys()).length.toLocaleString(); } } catch (e) {}
  try { const est = await navigator.storage.estimate(); used = `${(est.usage / 1048576).toFixed(0)} MB of ${(est.quota / 1073741824).toFixed(1)} GB`; } catch (e) {}
  $('#offStatus').innerHTML = `<div>Connection</div><div>${navigator.onLine ? '<span class="good">Online</span>' : '<span class="warn">Offline</span>'}</div>
    <div>Offline mode</div><div>${sw ? '<span class="good">Ready</span>' : '<span class="warn">Not active yet</span>'}</div>
    <div>Saved tiles</div><div>${tiles}</div><div>Storage</div><div>${used || '—'}</div>
    <div>Forecast</div><div>${S.wx ? `saved ${fmtDur(Date.now() - S.wx.fetchedAt)} ago` : 'none yet'}</div>`;
}

/* ---------- backup ---------- */
$('#bExport').onclick = async () => {
  const data = JSON.stringify({app: 'huntmap', version: 2, exported: Date.now(), pins: S.pins, photoTags: S.photos.map(({id, cam, t, tags, w, name}) => ({id, cam, t, tags, w, name}))});
  try { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([data], {type: 'application/json'})); a.download = `huntmap-backup-${new Date().toISOString().slice(0, 10)}.json`; a.click(); toast('Backup saved'); }
  catch (e) { try { await navigator.clipboard.writeText(data); toast('Backup copied'); } catch (_) { toast('Export failed'); } }
};
$('#bImportBtn').onclick = () => $('#fImport').click();
$('#fImport').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try {
    const j = JSON.parse(await f.text()); const ids = new Set(S.pins.map(p => p.id)); let n = 0;
    (j.pins || []).forEach(p => { if (p && typeof p.lat === 'number' && !ids.has(p.id)) { S.pins.push(p); n++; } });
    let t = 0; for (const pt of (j.photoTags || [])) { const p = S.photos.find(x => x.id === pt.id); if (p) { p.tags = pt.tags || []; p.w = p.w || pt.w; await photoPutMeta(p); t++; } }
    savePins(); renderPins(); toast(`Imported ${n} pins${t ? `, ${t} photo tags` : ''}`);
  } catch (err) { toast('That file is not a Hunt Map backup'); }
};

/* ---------- map search: counties and owner names, with suggestions ---------- */
const sq = $('#q'), sugg = $('#sugg');
let suggT = null, suggSeq = 0, suggOwners = [];
const srcForCounty = c => PARCEL_SOURCES.find(s => s.counties && s.counties.includes(c.n));
function hideSugg() { sugg.style.display = 'none'; sugg.innerHTML = ''; }
function suggRow(icon, main, sub, data) { return `<div class="sg" ${data}><span class="sgi">${icon}</span><div class="grow"><div class="nm">${main}</div>${sub ? `<div class="small muted">${sub}</div>` : ''}</div></div>`; }
function renderSugg(local, remote, loading) {
  const q = sq.value.trim(); if (q.length < 2) return hideSugg();
  let h = '';
  const ql = q.toLowerCase();
  const cs = GA.filter(c => c.n.toLowerCase().startsWith(ql)).concat(GA.filter(c => !c.n.toLowerCase().startsWith(ql) && c.n.toLowerCase().includes(ql))).slice(0, 4);
  if (cs.length) h += '<div class="sgh">Counties</div>' + cs.map(c => { const src = srcForCounty(c);
    return suggRow('📍', esc(c.n) + ' County', src ? (src.f.owner ? 'Property lines + owner names' : 'Property lines only') : 'No free property lines yet', `data-county="${c.fips}"`); }).join('');
  if (local.length) h += '<div class="sgh">Owners on loaded parcels</div>' + local.map((x, i) => suggRow('🏠', esc(x.s.owner), [x.s.acres != null ? esc(x.s.acres) + ' ac' : '', esc(x.s.id || '')].filter(Boolean).join(' · '), `data-local="${i}"`)).join('');
  if (remote.length) h += '<div class="sgh">Owners nearby</div>' + remote.map((x, i) => suggRow('🔎', esc(x.owner), [esc(x.county), x.acres != null ? esc(x.acres) + ' ac' : '', esc(x.pid || '')].filter(Boolean).join(' · '), `data-remote="${i}"`)).join('');
  if (loading) h += '<div class="sgh">Searching owners nearby…</div>';
  if (!h) h = '<div class="sgh">No matches</div>';
  sugg.innerHTML = h; sugg.style.display = 'block';
  sugg.querySelectorAll('[data-county]').forEach(el => el.onclick = () => goCounty(GA.find(c => c.fips === el.dataset.county)));
  sugg.querySelectorAll('[data-local]').forEach(el => el.onclick = () => { const x = local[+el.dataset.local]; doneSearch(); map.fitBounds(x.l.getBounds(), {maxZoom: 17}); setTimeout(() => x.l.openPopup(x.l.getBounds().getCenter()), 350); });
  sugg.querySelectorAll('[data-remote]').forEach(el => el.onclick = () => goRemote(remote[+el.dataset.remote]));
}
function localOwnerHits(ql) {
  const out = [], seen = new Set();
  for (const x of allParcels()) { const s = parcelSummary(x.f); if (s.owner && s.owner.toLowerCase().includes(ql) && !seen.has(s.owner + s.id)) { seen.add(s.owner + s.id); out.push({x, s, l: x.l}); if (out.length >= 5) break; } }
  return out;
}
// Ask the county servers near the map for owners matching the text (works for parcels you haven't loaded yet).
async function remoteOwnerHits(q, seq) {
  if (!navigator.onLine) return [];
  const c = map.getCenter(), b = map.getBounds().pad(0.6);
  const srcs = PARCEL_SOURCES.filter(src => src.f && src.f.owner && bboxHits(b, src.bbox))
    .sort((a, z) => Math.hypot((a.bbox[0] + a.bbox[2]) / 2 - c.lng, (a.bbox[1] + a.bbox[3]) / 2 - c.lat) - Math.hypot((z.bbox[0] + z.bbox[2]) / 2 - c.lng, (z.bbox[1] + z.bbox[3]) / 2 - c.lat)).slice(0, 5);
  const like = q.toUpperCase().replace(/'/g, "''").replace(/[%_]/g, '');
  const res = await Promise.all(srcs.map(async src => {
    try {
      const flds = [src.oid || 'OBJECTID', src.f.owner, src.f.acres, src.f.id].filter(Boolean).join(',');
      const u = `${src.url}/query?where=${encodeURIComponent(`UPPER(${src.f.owner}) LIKE '%${like}%'`)}&outFields=${encodeURIComponent(flds)}&returnGeometry=false&resultRecordCount=6&f=json`;
      const j = await fetch(u).then(r => r.json());
      return (j.features || []).map(ft => ({src, oid: ft.attributes[src.oid || 'OBJECTID'], owner: clean(ft.attributes[src.f.owner]), acres: src.f.acres ? ft.attributes[src.f.acres] : null, pid: src.f.id ? clean(ft.attributes[src.f.id]) : null, county: src.name}));
    } catch (e) { return []; }
  }));
  return seq === suggSeq ? res.flat().filter(x => x.owner).slice(0, 10) : null;
}
sq.addEventListener('input', () => {
  const q = sq.value.trim(), ql = q.toLowerCase(), seq = ++suggSeq;
  const local = q.length >= 3 ? localOwnerHits(ql) : [];
  renderSugg(local, [], q.length >= 3 && navigator.onLine);
  clearTimeout(suggT);
  if (q.length >= 3) suggT = setTimeout(async () => { let r = await remoteOwnerHits(q, seq); if (r) {
    const have = new Set(local.map(x => (x.s.owner + '|' + (x.s.id || '')).toUpperCase()));
    r = r.filter(x => !have.has((x.owner + '|' + (x.pid || '')).toUpperCase())); // already listed under loaded parcels
    suggOwners = r; renderSugg(local, r, false); } }, 400);
});
sq.addEventListener('focus', () => { if (sq.value.trim().length >= 2) sq.dispatchEvent(new Event('input')); });
sq.addEventListener('keydown', e => { if (e.key === 'Enter') { const first = sugg.querySelector('.sg'); if (first) first.click(); } if (e.key === 'Escape') doneSearch(); });
$('#qClear').onclick = () => { sq.value = ''; hideSugg(); sq.blur(); };
map.on('click', () => { hideSugg(); sq.blur(); });
function doneSearch() { hideSugg(); sq.blur(); }
function goCounty(c) {
  doneSearch(); sq.value = c.n + ' County';
  map.fitBounds([[c.b[1], c.b[0]], [c.b[3], c.b[2]]]);
  const src = srcForCounty(c);
  toast(src ? `${c.n} County: zoom in to see property lines` : `${c.n} County has no free property lines yet. See More → County property lines.`, 3500);
}
async function goRemote(x) {
  doneSearch(); sq.value = x.owner;
  try {
    const u = `${x.src.url}/query?objectIds=${x.oid}&outFields=*&outSR=4326&f=${x.src.kind === 'json' ? 'json' : 'geojson'}`;
    const j = await fetch(u).then(r => r.json());
    const fs = x.src.kind === 'json' ? esriToGeo(j, x.src.oid) : (j.features || []);
    addLive(x.src, fs); saveLive(x.src);
    const id = fs[0] && (fs[0].id ?? fs[0].properties?.[x.src.oid]);
    const hit = liveIndex.find(e => e.src === x.src.id && e.f.id === id);
    if (hit) { map.fitBounds(hit.l.getBounds(), {maxZoom: 17}); setTimeout(() => hit.l.openPopup(hit.l.getBounds().getCenter()), 400); }
    else toast('Could not load that parcel');
  } catch (e) { toast('Could not load that parcel'); }
}

/* ---------- navigation ---------- */
let curPage = 'map';
function showPage(p) {
  curPage = p;
  $$('#nav button').forEach(b => b.classList.toggle('on', b.dataset.page === p));
  $$('.page').forEach(el => el.classList.toggle('on', el.id === 'pg-' + p));
  $('#layerMenu').style.display = 'none';
  if (p !== 'map') endDrop();
  if (p === 'map') setTimeout(() => map.invalidateSize(), 50);
  if (p === 'cams') renderCams();
  if (p === 'activity') renderActivity();
  if (p === 'weather') renderWx();
  if (p === 'more') { renderSources(); renderPinList(); renderOffStatus(); updateDlEstimate(); updateParcelHere(); }
}
$$('#nav button').forEach(b => b.onclick = () => { if (b.dataset.page === 'cams' && curPage === 'cams') camView = null; showPage(b.dataset.page); });
$('#bLayers').onclick = e => { e.stopPropagation(); endDrop(); const m = $('#layerMenu'); m.style.display = m.style.display === 'block' ? 'none' : 'block'; };
$$('#baseSeg button').forEach(b => b.onclick = () => setBase(b.dataset.base));
$('#chkParcels').checked = S.showParcels; $('#chkCone').checked = S.showCone; $('#chkLabels').checked = S.showLabels; $('#coneLen').value = String(S.coneLen);
$('#chkParcels').onchange = e => { S.showParcels = e.target.checked; ls.set('showParcels', S.showParcels); syncParcelVisibility(); loadLiveParcels(); zoomHint(); };
$('#chkCone').onchange = e => { S.showCone = e.target.checked; ls.set('showCone', S.showCone); drawCone(); };
$('#chkLabels').onchange = e => { S.showLabels = e.target.checked; ls.set('showLabels', S.showLabels); map.fire('zoomend'); };
$('#coneLen').onchange = e => { S.coneLen = +e.target.value; ls.set('coneLen', S.coneLen); drawCone(); };
window.addEventListener('online', () => { loadLiveParcels(); syncOfflineUnderlay(); renderTop(); refreshWx(false); enrichWeather(); });
window.addEventListener('offline', () => { syncOfflineUnderlay(); renderWx(); toast('No signal: using saved map and data'); });

/* ---------- updates ---------- */
let swReg = null;
function askVersion() { navigator.serviceWorker?.controller?.postMessage('version'); }
async function checkUpdate(manual) {
  if (!swReg || !navigator.onLine) { if (manual) $('#updMsg').textContent = navigator.onLine ? 'Offline mode is not active yet.' : 'No signal. It will check next time you are online.'; return; }
  try { await swReg.update(); if (manual && !swReg.installing && !swReg.waiting) $('#updMsg').textContent = 'You have the latest version ✔'; }
  catch (e) { if (manual) $('#updMsg').textContent = 'Could not check: ' + e.message; }
}
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('message', e => { if (e.data?.type === 'version') $('#appVer').textContent = e.data.version; });
  const bootAt = Date.now();
  // A new version that arrives while the app is still opening reloads straight away; later ones ask first.
  navigator.serviceWorker.addEventListener('controllerchange', () => { askVersion(); if (!hadController) return; if (Date.now() - bootAt < 10000) location.reload(); else $('#updBar').style.display = 'flex'; });
  navigator.serviceWorker.register('sw.js', {updateViaCache: 'none'}).then(r => { swReg = r; askVersion(); checkUpdate(false); }).catch(() => {});
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkUpdate(false); });
  setInterval(() => checkUpdate(false), 30 * 60000);
}
$('#bReload').onclick = () => location.reload();
$('#bCheckUpd').onclick = () => { $('#updMsg').textContent = 'Checking…'; checkUpdate(true); };

/* ---------- boot ---------- */
setBase(S.base);
map.fire('zoomend');
renderPins(); renderWx();
kvGet('parcels').then(v => { if (Array.isArray(v)) S.parcelSets = v; buildParcelLayer(); }).catch(() => buildParcelLayer());
Promise.all(PARCEL_SOURCES.map(src => kvGet('live:' + src.id).then(async v => {
    const old = Object.keys(LEGACY).find(k => LEGACY[k] === src.fips && src.url.endsWith(LEGACY_URL[k]));
    if (!v && old) v = await kvGet('live:' + old).catch(() => null); // carry over parcels saved by earlier versions
    if (v) { addLive(src, v.features, true); (v.cells || []).forEach(c => LIVE[src.id].cells.add(c)); LIVE[src.id].done = !!v.done; }
  }).catch(() => {})))
  .then(() => { loadLiveParcels(); zoomHint(); });
photosAll().then(ps => { S.photos = ps || []; enrichWeather(); }).catch(() => {});
startGPS();
if (!S.wx || Date.now() - S.wx.fetchedAt > 45 * 60000) refreshWx(false);
setInterval(() => { renderTop(); if (navigator.onLine && S.wx && Date.now() - S.wx.fetchedAt > 45 * 60000) refreshWx(false); }, 60000);
