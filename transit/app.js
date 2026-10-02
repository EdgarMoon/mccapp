/* 출근 버스 — Gare Centrale 실시간 트래커 (STM GTFS-Realtime) */
const API = 'https://api.stm.info/pub/od/gtfs-rt/ic/v2';
const REM_EXIT = [45.4994, -73.5652]; // Gare Centrale REM 출구 (Bonaventure/Hilton 쪽)
const OFFICE = [45.4971, -73.5547];   // 80 Rue Queen (사무실)
const REFRESH_MS = 25000;

const ROUTES = {
  '74':  { color: '#1E88E5', dir: '1', dirName: 'Sud',  stop: '52732', stopName: 'Robert-Bourassa / Viger' },
  '168': { color: '#43A047', dir: '0', dirName: 'Sud',  stop: '52732', stopName: 'Robert-Bourassa / Viger' },
  '35':  { color: '#8E24AA', dir: '1', dirName: 'Ouest', stop: '61657', stopName: 'du Beaver Hall / Viger' },
  '777': { color: '#FB8C00', dir: null, dirName: '',    stop: '62148', stopName: 'Station Bonaventure' },
};
const DIR_NAMES = { '0': { '74': 'Nord', '168': 'Sud', '35': 'Est', '777': 'Est' },
                    '1': { '74': 'Sud',  '168': 'Nord', '35': 'Ouest', '777': 'Ouest' } };

let FeedMessage = null;
let map, routeData = {}, tripDirs = {};
let busMarkers = {};   // vehicleKey -> marker
let stopMarkers = {};  // stopId -> marker
const seenStopIds = new Set();
let arrivals = {};      // stopId -> [{route, dir, mins}]
let routeCounts = {};

// STM 실시간 피드의 direction_id가 정적 GTFS와 뒤집혀 오는 경우가 있어
// trip_id 기준으로 정적 GTFS의 방향을 우선 사용한다.
function tripDir(trip) {
  if (!trip) return '';
  const tid = String(trip.trip_id || '');
  if (tid && tripDirs[tid] != null) return String(tripDirs[tid]);
  return trip.direction_id != null ? String(trip.direction_id) : '';
}

function haversine(a, b) {
  const R = 6371000, toRad = d => d * Math.PI / 180;
  const dLat = toRad(b[0] - a[0]), dLon = toRad(b[1] - a[1]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
function walkMin(latlng) {
  const p = Array.isArray(latlng) ? latlng : [latlng.lat, latlng.lng];
  return Math.max(1, Math.round(haversine(REM_EXIT, p) / 80));
}
function fmtMins(m) {
  if (m < 1) return '<span class="soon">곧 도착</span>';
  return m + '분';
}

async function initProto() {
  const text = await (await fetch('gtfsrt.proto.txt')).text();
  // proto의 snake_case 필드명(vehicle.trip.route_id 등)을 그대로 쓰기 위해 keepCase 사용
  FeedMessage = protobuf.parse(text, { keepCase: true }).root.lookupType('transit_realtime.FeedMessage');
}

async function fetchFeed(name) {
  const key = localStorage.getItem('stm_api_key') || '';
  const res = await fetch(API + '/' + name, {
    headers: { 'apikey': key, 'Accept': 'application/x-protobuf' },
  });
  if (res.status === 401 || res.status === 403) {
    showKeyOverlay();
    throw new Error('API 키 오류 (' + res.status + ')');
  }
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return FeedMessage.decode(new Uint8Array(await res.arrayBuffer()));
}

function initMap() {
  map = L.map('map', { zoomControl: false }).setView(REM_EXIT, 14);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Esri, HERE, Garmin, OpenStreetMap contributors', maxZoom: 19,
  }).addTo(map);
  L.marker(REM_EXIT, {
    icon: L.divIcon({ className: '', html: '<div style="font-size:22px">🚇</div>', iconSize: [24, 24], iconAnchor: [12, 12] }),
  }).addTo(map).bindPopup('<b>REM 하차</b> (Bonaventure 쪽 출구)');
  L.marker(OFFICE, {
    icon: L.divIcon({ className: '', html: '<div style="font-size:22px">🏢</div>', iconSize: [24, 24], iconAnchor: [12, 12] }),
  }).addTo(map).bindPopup('<b>사무실</b> (80 Rue Queen)');

  // 노선 폴리라인 + 정류장
  for (const [rn, cfg] of Object.entries(ROUTES)) {
    const rd = routeData[rn];
    if (!rd) continue;
    for (const [d, line] of Object.entries(rd.shapes)) {
      L.polyline(line.map(p => [p[0], p[1]]), {
        color: cfg.color, weight: 4, opacity: 0.5,
      }).addTo(map);
    }
    for (const s of rd.stops) {
      if (seenStopIds.has(s.id)) continue;
      seenStopIds.add(s.id);
      // 같은 정류장을 쓰는 노선이 여러 개면 색을 합친 핀 1개로 표시
      const keyRns = Object.keys(ROUTES).filter(r => ROUTES[r].stop === s.id);
      let m;
      if (keyRns.length) {
        const bg = keyRns.length === 1
          ? ROUTES[keyRns[0]].color
          : 'conic-gradient(' + keyRns.map((r, i) =>
              `${ROUTES[r].color} ${Math.round(i * 100 / keyRns.length)}% ${Math.round((i + 1) * 100 / keyRns.length)}%`
            ).join(', ') + ')';
        m = L.marker([s.lat, s.lon], {
          icon: L.divIcon({ className: '', html: `<div class="key-pin" style="background:${bg}"></div>`, iconSize: [16, 16], iconAnchor: [8, 8] }),
        });
      } else {
        m = L.circleMarker([s.lat, s.lon], { radius: 3.5, color: '#666', weight: 1, fillColor: '#fff', fillOpacity: 1 });
      }
      m.bindPopup(() => popupHtml(s.id, s.name));
      m.addTo(map);
      stopMarkers[s.id] = m;
    }
  }
  buildLegend();
  buildPanel();
  // 관심 지역(Gare Centrale + 주요 정류장 + 사무실)에 맞게 지도 범위 조정
  const bounds = L.latLngBounds([REM_EXIT, OFFICE]);
  for (const cfg of Object.values(ROUTES)) {
    const m = stopMarkers[cfg.stop];
    if (m) bounds.extend(m.getLatLng());
  }
  map.fitBounds(bounds, { padding: [36, 36] });
}

function popupHtml(stopId, name) {
  const list = (arrivals[stopId] || []).slice(0, 6);
  let h = `<b>${name}</b><br><span style="color:#888">정류장 ${stopId}</span><br>`;
  if (!list.length) h += '도착 정보 없음';
  for (const a of list) {
    const c = ROUTES[a.route] ? ROUTES[a.route].color : '#333';
    h += `<span style="display:inline-block;min-width:34px;text-align:center;background:${c};color:#fff;border-radius:6px;font-weight:700;padding:0 6px;margin-right:6px">${a.route}</span> <b class="arr">${fmtMins(a.mins)}</b> <span style="color:#666">${a.dirName}</span><br>`;
  }
  return h;
}

function buildLegend() {
  const el = document.getElementById('legend');
  el.innerHTML = Object.entries(ROUTES).map(([rn, cfg]) =>
    `<div><span class="dot" style="background:${cfg.color}"></span><b>${rn}</b><span id="cnt-${rn}"></span></div>`
  ).join('');
}

function buildPanel() {
  const panel = document.getElementById('panel');
  panel.innerHTML = '';
  for (const [rn, cfg] of Object.entries(ROUTES)) {
    const card = document.createElement('div');
    card.className = 'card';
    card.style.borderTopColor = cfg.color;
    card.id = 'card-' + rn;
    card.innerHTML = `
      <div class="route" style="color:${cfg.color}">${rn}</div>
      <div class="dir">${cfg.dirName ? cfg.dirName + '행 · ' : ''}${cfg.stopName}</div>
      <div class="walk" id="walk-${rn}"></div>
      <div class="times" id="times-${rn}">…</div>`;
    card.onclick = () => {
      const m = stopMarkers[cfg.stop];
      if (m) { map.flyTo(m.getLatLng(), 16, { duration: 0.8 }); setTimeout(() => m.openPopup(), 850); }
    };
    panel.appendChild(card);
    const sm = stopMarkers[cfg.stop];
    if (sm) document.getElementById('walk-' + rn).textContent = '🚶 정류장까지 약 ' + walkMin(sm.getLatLng()) + '분';
  }
}

function updateBuses(feed) {
  const now = Date.now() / 1000;
  const seen = new Set();
  routeCounts = {};
  const items = [];
  for (const e of feed.entity) {
    const v = e.vehicle;
    if (!v || !v.position) continue;
    const rn = String(v.trip && v.trip.route_id || '');
    if (!ROUTES[rn]) continue;
    const vid = (v.vehicle && v.vehicle.id) || e.id;
    const key = rn + ':' + vid;
    seen.add(key);
    routeCounts[rn] = (routeCounts[rn] || 0) + 1;
    const age = v.timestamp ? now - Number(v.timestamp) : 999;
    items.push({ key, rn, v, age });
  }
  // 겹치는 버스 마커 분리: 화면 좌표 기준 30px 이내에 있으면 원형으로 벌려 표시
  const pts = items.map(it => ({
    it,
    p: map.latLngToContainerPoint([it.v.position.latitude, it.v.position.longitude]),
  }));
  const R = 30;
  const groups = [];
  for (const cur of pts) {
    const hits = groups.filter(g => g.some(o => Math.hypot(o.p.x - cur.p.x, o.p.y - cur.p.y) < R));
    if (!hits.length) { groups.push([cur]); continue; }
    const g = hits[0];
    g.push(cur);
    for (const h of hits.slice(1)) { g.push(...h); groups.splice(groups.indexOf(h), 1); }
  }
  for (const g of groups) {
    g.sort((a, b) => (a.it.key < b.it.key ? -1 : 1));
    const rad = Math.max(22, 11 * g.length);
    g.forEach((cur, i) => {
      let p = cur.p;
      if (g.length > 1) {
        const ang = (i / g.length) * Math.PI * 2 - Math.PI / 2;
        p = L.point(p.x + Math.cos(ang) * rad, p.y + Math.sin(ang) * rad);
      }
      cur.ll = map.containerPointToLatLng(p);
    });
  }
  for (const cur of pts) {
    const { it } = cur;
    const stale = it.age > 120;
    const html = `<div class="bus-badge${stale ? ' stale' : ''}" style="background:${ROUTES[it.rn].color}">${it.rn}</div>`;
    const latlng = cur.ll;
    if (busMarkers[it.key]) {
      busMarkers[it.key].setLatLng(latlng);
      busMarkers[it.key].setIcon(L.divIcon({ className: '', html, iconSize: [30, 30], iconAnchor: [15, 15] }));
    } else {
      busMarkers[it.key] = L.marker(latlng, {
        icon: L.divIcon({ className: '', html, iconSize: [30, 30], iconAnchor: [15, 15] }),
      }).addTo(map);
    }
    const dirName = (DIR_NAMES[tripDir(it.v.trip)] || {})[it.rn] || '';
    busMarkers[it.key].bindPopup(`<b>${it.rn}번</b> ${dirName}<br><span style="color:#888">${Math.max(0, Math.round(it.age))}초 전 위치</span>`);
  }
  for (const [k, m] of Object.entries(busMarkers)) {
    if (!seen.has(k)) { map.removeLayer(m); delete busMarkers[k]; }
  }
  for (const rn of Object.keys(ROUTES)) {
    const el = document.getElementById('cnt-' + rn);
    if (el) el.textContent = '· ' + (routeCounts[rn] || 0) + '대';
  }
}

function updateArrivals(feed) {
  const now = Date.now() / 1000;
  arrivals = {};
  for (const e of feed.entity) {
    const tu = e.trip_update;
    if (!tu || !tu.trip) continue;
    const rn = String(tu.trip.route_id || '');
    if (!ROUTES[rn]) continue;
    const dir = tripDir(tu.trip);
    for (const stu of tu.stop_time_update || []) {
      const sid = String(stu.stop_id || '');
      const t = stu.arrival && stu.arrival.time ? Number(stu.arrival.time) : (stu.departure && stu.departure.time ? Number(stu.departure.time) : null);
      if (t == null) continue;
      const mins = (t - now) / 60;
      if (mins < -1 || mins > 120) continue;
      (arrivals[sid] = arrivals[sid] || []).push({ route: rn, dir, dirName: (DIR_NAMES[dir] || {})[rn] || '', mins: Math.max(0, Math.round(mins)) });
    }
  }
  for (const sid of Object.keys(arrivals)) {
    arrivals[sid].sort((a, b) => a.mins - b.mins);
  }
  // 패널 갱신
  for (const [rn, cfg] of Object.entries(ROUTES)) {
    const el = document.getElementById('times-' + rn);
    if (!el) continue;
    let list = (arrivals[cfg.stop] || []).filter(a => a.route === rn);
    if (cfg.dir) list = list.filter(a => a.dir === cfg.dir);
    list = list.slice(0, 2);
    el.innerHTML = list.length
      ? list.map(a => fmtMins(a.mins)).join(' · ')
      : '<span class="none">2시간 내 도착 없음</span>';
  }
}

// 배포 시 version.json의 v와 함께 올릴 것
const APP_VERSION = '20261002d';
async function checkVersion() {
  try {
    const r = await fetch('version.json?ts=' + Date.now());
    if (!r.ok) return;
    const j = await r.json();
    if (j.v && j.v !== APP_VERSION && !document.getElementById('verBanner')) {
      const b = document.createElement('div');
      b.id = 'verBanner';
      b.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2000;background:#333;color:#fff;text-align:center;padding:10px;font-size:14px;';
      b.textContent = '새 버전이 있습니다 — 눌러서 새로고침';
      b.onclick = () => location.reload();
      document.body.appendChild(b);
    }
  } catch (e) { /* 무시 */ }
}

async function refresh() {
  try {
    const [vp, tu] = await Promise.all([fetchFeed('vehiclePositions'), fetchFeed('tripUpdates')]);
    updateBuses(vp);
    updateArrivals(tu);
    checkVersion();
    const d = new Date();
    document.getElementById('updated').textContent =
      '업데이트 ' + d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0');
  } catch (err) {
    console.error(err);
    if (!String(err.message).includes('API 키')) {
      document.getElementById('updated').textContent = '업데이트 실패 — ↻를 눌러주세요';
    }
  }
}

function showKeyOverlay() {
  document.getElementById('keyOverlay').classList.add('show');
  const cur = localStorage.getItem('stm_api_key') || '';
  document.getElementById('keyInput').value = cur;
}

async function boot() {
  await initProto();
  routeData = await (await fetch('data/routes4.json')).json();
  tripDirs = await (await fetch('data/trip_dirs.json')).json();
  initMap();
  if (!localStorage.getItem('stm_api_key')) {
    document.getElementById('updated').textContent = 'STM API 키를 입력해 주세요';
    showKeyOverlay();
  } else await refresh();
  setInterval(refresh, REFRESH_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
}

document.getElementById('btnRefresh').onclick = refresh;
document.getElementById('btnKey').onclick = showKeyOverlay;
document.getElementById('keySave').onclick = () => {
  const v = document.getElementById('keyInput').value.trim();
  if (!v) return;
  localStorage.setItem('stm_api_key', v);
  document.getElementById('keyOverlay').classList.remove('show');
  refresh();
};

boot();
