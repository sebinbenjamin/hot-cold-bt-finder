"use strict";

/* ============================================================
   State
   ============================================================ */
const S = {
  scan: null,           // BluetoothLEScan handle
  devices: new Map(),   // id -> {id,name,rssi,ema,txPower,last}
  target: null,         // id being hunted
  ema: null,            // smoothed rssi of target
  history: [],          // {t, ema}
  lastHeard: 0,
  tickTimer: null,
  audio: null,
  sound: true,
  buzz: true,
  wakeLock: null,
  watched: new Set(),
  filter: "",
  namedOnly: false,
  advCount: 0,
  watchdog: null
};

const ALPHA = 0.25;          // EMA smoothing
const TX_POWER = -59;        // assumed dBm at 1 metre
const PATH_LOSS = 2.0;
const RSSI_MIN = -100, RSSI_MAX = -35;
const TREND_WINDOW = 2500;   // ms to look back for warmer/colder
const TREND_DEADBAND = 1.5;  // dB

const $ = id => document.getElementById(id);

/* ============================================================
   Support check
   ============================================================ */
async function checkSupport(){
  const box = $("support");
  const embedded = window.self !== window.top;

  if(embedded){
    box.innerHTML = "<b>This page is running inside another app's frame.</b> " +
      "Chrome only hands Bluetooth to a page it loads directly, so scanning is blocked here. " +
      "Save the file, put it on any https address, and open that address in Chrome on your phone.";
    $("btnScan").disabled = true; $("btnPick").disabled = true;
    return;
  }
  if(navigator.bluetooth && navigator.bluetooth.getAvailability){
    try{
      if(!(await navigator.bluetooth.getAvailability())){
        box.innerHTML = "<b>No Bluetooth radio available.</b> Switch Bluetooth on in system settings, " +
          "then reload. On Android, location permission also has to be granted to Chrome.";
        $("btnScan").disabled = true; $("btnPick").disabled = true;
        return;
      }
    }catch(e){}
  }
  if(!navigator.bluetooth){
    box.innerHTML = "<b>Bluetooth isn't available here.</b> This needs Chrome on Android " +
      "and a page served over https. A file opened straight from storage won't work.";
    $("btnScan").disabled = true; $("btnPick").disabled = true;
    return;
  }
  if(!navigator.bluetooth.requestLEScan){
    box.innerHTML = "<b>Full scanning isn't available here.</b> This browser build can't start Bluetooth LE scans. " +
      "Use <b>Add a device by hand</b> to watch a specific device instead.";
    $("btnScan").disabled = false;
    $("btnScan").textContent = "Use picker instead";
  } else {
    box.innerHTML = "<b>Two ways in.</b> <i>Start scan</i> hears every advertisement in range. " +
      "<i>Add a device by hand</i> uses Chrome's own picker and needs no flags — better if scanning is blocked.";
    $("btnScan").disabled = false;
    $("btnScan").textContent = "Start scan";
  }
}

/* ============================================================
   Scanning
   ============================================================ */
async function startScan(){
  if(!navigator.bluetooth){
    $("hint").textContent = "Bluetooth isn't available in this browser.";
    return;
  }
  if(!navigator.bluetooth.requestLEScan){
    $("hint").textContent = "This browser doesn't support full Bluetooth scanning. Using the manual picker instead.";
    diag("Falling back to picker");
    await pickOne();
    return;
  }

  try{
    S.advCount = 0;
    diag("Requesting scan permission…");
    setStatus("Scanning", true);
    navigator.bluetooth.addEventListener("advertisementreceived", onAdvert);
    S.scan = await navigator.bluetooth.requestLEScan({
      acceptAllAdvertisements: true,
      keepRepeatedDevices: true
    });
    $("btnScan").textContent = "Stop scan";
    $("hint").textContent = "Listening. Devices sort by strength, strongest first.";
    diag("Scan running · 0 advertisements");

    // If the radio is scanning but nothing arrives, it's almost always location permission.
    clearTimeout(S.watchdog);
    S.watchdog = setTimeout(() => {
      if(S.scan && S.advCount === 0){
        $("hint").innerHTML = "<b>Scan started but nothing is coming through.</b> " +
          "Android hides Bluetooth advertisements from Chrome unless Chrome has Location " +
          "permission. Open Android Settings → Apps → Chrome → Permissions → Location → " +
          "Allow, make sure Location itself is switched on, then reload and scan again.";
      }
    }, 7000);

  }catch(err){
    stopScan();
    const map = {
      NotAllowedError: "Permission was refused. Tap Start scan and choose Allow on the prompt.",
      NotSupportedError: "This Chrome build can't scan. Enable chrome://flags/#enable-experimental-web-platform-features and restart Chrome.",
      NotFoundError: "No Bluetooth adapter found. Switch Bluetooth on and reload.",
      InvalidStateError: "A scan is already running in another tab. Close it and try again.",
      SecurityError: "Blocked by the page's permissions policy — open this file as a top-level page in Chrome, not inside another app."
    };
    $("hint").textContent = map[err.name] || (err.name + ": " + err.message);
    diag("Scan failed · " + err.name);
  }
}

function diag(t){ $("diag").textContent = t; }

function stopScan(){
  clearTimeout(S.watchdog);
  if(S.scan){ try{ S.scan.stop(); }catch(e){} S.scan = null; }
  navigator.bluetooth.removeEventListener("advertisementreceived", onAdvert);
  $("btnScan").textContent = "Start scan";
  setStatus("Idle", false);
}

function onAdvert(e){
  const id = e.device.id;
  const rssi = e.rssi;
  if(typeof rssi !== "number") return;

  S.advCount++;
  if(S.scan && S.advCount % 5 === 1) diag(`Scan running · ${S.advCount} advertisements`);

  let d = S.devices.get(id);
  if(!d){
    d = { id, name: e.device.name || e.name || "", rssi, ema: rssi, txPower: null };
    S.devices.set(id, d);
  }
  if(!d.name && (e.device.name || e.name)) d.name = e.device.name || e.name;
  if(typeof e.txPower === "number") d.txPower = e.txPower;
  d.rssi = rssi;
  d.ema = d.ema == null ? rssi : d.ema + ALPHA * (rssi - d.ema);
  d.last = Date.now();

  if(S.target === id) feedTarget(d.rssi, d.txPower);
  if($("viewList").classList.contains("active")) renderList();
}

/* Flag-free path: Chrome's picker, one device at a time, all kept on the list */
async function pickOne(){
  try{
    const device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true, optionalServices: []
    });

    if(S.watched.has(device.id)){
      $("hint").textContent = "That one's already on the list.";
      return;
    }
    if(!device.watchAdvertisements){
      $("hint").textContent = "This Chrome can't stream signal strength. Enable " +
        "chrome://flags/#enable-experimental-web-platform-features and try again.";
      return;
    }

    const rec = {
      id: device.id, name: device.name || "", rssi: null, ema: null,
      txPower: null, last: 0, pinned: true
    };
    S.devices.set(device.id, rec);
    S.watched.add(device.id);
    renderList();

    device.addEventListener("advertisementreceived", ev => {
      if(typeof ev.rssi !== "number") return;
      rec.rssi = ev.rssi;
      rec.ema = rec.ema == null ? ev.rssi : rec.ema + ALPHA * (ev.rssi - rec.ema);
      if(typeof ev.txPower === "number") rec.txPower = ev.txPower;
      rec.last = Date.now();
      if(S.target === device.id) feedTarget(rec.rssi, rec.txPower);
      if($("viewList").classList.contains("active")) renderList();
    });

    await device.watchAdvertisements();
    setStatus(`Watching ${S.watched.size}`, true);
    $("hint").textContent = S.watched.size === 1
      ? "Added. Add more devices, or tap one to start hunting it."
      : `Watching ${S.watched.size} devices. Tap one to start hunting it.`;
  }catch(err){
    if(err.name === "NotFoundError") return;          // user dismissed the picker
    $("hint").textContent = "Couldn't watch that device: " + err.message;
  }
}

/* ============================================================
   List rendering
   ============================================================ */
function renderList(){
  const now = Date.now();
  for(const [id,d] of S.devices){
    if(!d.pinned && id !== S.target && now - d.last > 12000) S.devices.delete(id);
  }

  const arr = [...S.devices.values()].sort((a,b) => {
    if(a.ema == null) return 1;
    if(b.ema == null) return -1;
    return b.ema - a.ema;
  });

  const q = S.filter.trim().toLowerCase();
  const shown = arr.filter(d => {
    if(S.namedOnly && !d.name) return false;
    if(!q) return true;
    return d.name.toLowerCase().includes(q) || d.id.toLowerCase().includes(q);
  });

  $("count").textContent = (q || S.namedOnly)
    ? `${shown.length} of ${arr.length} shown`
    : (arr.length ? `${arr.length} device${arr.length === 1 ? "" : "s"}` : "");

  const ul = $("list");
  $("empty").style.display = shown.length ? "none" : "block";
  $("empty").textContent = arr.length
    ? "No device matches that filter."
    : "Nothing on the list yet. Scan, or add a device by hand.";

  ul.innerHTML = shown.map(d => {
    const silent = d.ema == null || now - d.last > 12000;
    const lit = silent ? 0 : Math.max(0, Math.min(10, Math.round(pct(d.ema) * 10)));
    const segs = Array.from({length:10}, (_,i) =>
      `<span class="seg${i < lit ? " lit" : ""}"></span>`).join("");
    const name = d.name ? esc(d.name) : `<span class="anon">Unnamed device</span>`;
    const dbm  = silent ? "—" : `${Math.round(d.ema)} dBm`;
    const meta = d.ema == null
      ? "waiting for first signal"
      : silent ? "gone quiet" : `${roughDistance(d.ema, d.txPower)} away`;
    return `<li data-id="${esc(d.id)}">
      <div class="row-top">
        <span class="dev-name">${name}</span>
        <span class="dbm mono">${dbm}</span>
      </div>
      <div class="segs">${segs}</div>
      <div class="row-meta">${meta} · ${esc(d.id).slice(0,10)}</div>
    </li>`;
  }).join("");
}

$("list").addEventListener("click", e => {
  const li = e.target.closest("li");
  if(li) hunt(li.dataset.id);
});

/* ============================================================
   Hunt mode
   ============================================================ */
function hunt(id){
  const d = S.devices.get(id);
  if(!d) return;
  S.target = id;
  S.ema = d.ema;
  S.history = [];
  S.lastHeard = d.last || 0;

  $("targetName").textContent = d.name || "Unnamed device";
  swap("viewHunt");
  startAudio();
  requestWake();
  scheduleTick();
  drawTrace();
}

function leaveHunt(){
  S.target = null;
  stopTick();
  releaseWake();
  swap("viewList");
  renderList();
}

function feedTarget(rssi, txPower){
  S.ema = S.ema == null ? rssi : S.ema + ALPHA * (rssi - S.ema);
  S.lastHeard = Date.now();
  S.history.push({ t: S.lastHeard, ema: S.ema });
  if(S.history.length > 400) S.history.shift();
  paintHunt(txPower);
}

function paintHunt(txPower){
  const v = S.ema;
  const p = pct(v);

  // needle: -90deg (far) .. +90deg (here)
  $("needle").style.transform = `rotate(${(-90 + p * 180).toFixed(1)}deg)`;

  // arc fill along a 160r semicircle
  const arcLen = Math.PI * 160;
  const arc = $("arcFill");
  arc.style.strokeDasharray = arcLen;
  arc.style.strokeDashoffset = arcLen * (1 - p);

  $("glow").style.opacity = (p * p).toFixed(2);
  $("rssiVal").textContent = Math.round(v);
  $("distVal").textContent = "roughly " + roughDistance(v, txPower) + " away";

  // warmer / colder from the slope of the smoothed line
  const now = Date.now();
  const past = S.history.find(h => now - h.t <= TREND_WINDOW);
  const box = $("verdict"), word = $("verdictWord"), why = $("verdictWhy");
  box.classList.remove("warmer","colder");

  if(!past || S.history.length < 6){
    word.textContent = "Hold still"; why.textContent = "Building a baseline";
  } else {
    const delta = S.ema - past.ema;
    if(delta > TREND_DEADBAND){
      box.classList.add("warmer");
      word.textContent = "Warmer"; why.textContent = `Up ${delta.toFixed(1)} dB — keep going`;
    } else if(delta < -TREND_DEADBAND){
      box.classList.add("colder");
      word.textContent = "Colder"; why.textContent = `Down ${Math.abs(delta).toFixed(1)} dB — turn around`;
    } else {
      word.textContent = "No change"; why.textContent = "Move further before deciding";
    }
  }
  drawTrace();
}

/* ============================================================
   Click track — pace carries the distance, not the screen
   ============================================================ */
function startAudio(){
  if(!S.audio){
    const C = window.AudioContext || window.webkitAudioContext;
    if(C) S.audio = new C();
  }
  if(S.audio && S.audio.state === "suspended") S.audio.resume();
}

function click(strength){
  if(S.sound && S.audio){
    const t = S.audio.currentTime;
    const osc = S.audio.createOscillator(), g = S.audio.createGain();
    osc.type = "square";
    osc.frequency.value = 620 + strength * 900;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.18, t + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    osc.connect(g).connect(S.audio.destination);
    osc.start(t); osc.stop(t + 0.06);
  }
  if(S.buzz && navigator.vibrate) navigator.vibrate(14 + Math.round(strength * 22));
}

function scheduleTick(){
  stopTick();
  const step = () => {
    if(S.target == null) return;
    const stale = Date.now() - S.lastHeard > 8000;
    const p = stale ? 0 : pct(S.ema);
    if(stale){
      $("verdictWord").textContent = "Lost it";
      $("verdictWhy").textContent = "No advertisements for 8 seconds";
      $("verdict").classList.remove("warmer","colder");
    } else {
      click(p);
    }
    const interval = 1250 - p * 1160;   // 1250ms far → 90ms close
    S.tickTimer = setTimeout(step, Math.max(90, interval));
  };
  step();
}
function stopTick(){ if(S.tickTimer){ clearTimeout(S.tickTimer); S.tickTimer = null; } }

/* ============================================================
   Strip trace
   ============================================================ */
function drawTrace(){
  const c = $("trace");
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, h = c.clientHeight;
  if(c.width !== w * dpr){ c.width = w * dpr; c.height = h * dpr; }
  const g = c.getContext("2d");
  g.setTransform(dpr,0,0,dpr,0,0);
  g.clearRect(0,0,w,h);

  const now = Date.now(), span = 60000;
  const pts = S.history.filter(p => now - p.t <= span);
  if(pts.length < 2) return;

  g.strokeStyle = "#2C3340"; g.lineWidth = 1;
  for(let i = 1; i < 4; i++){
    const y = (h / 4) * i;
    g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke();
  }

  g.beginPath();
  pts.forEach((p, i) => {
    const x = w - ((now - p.t) / span) * w;
    const y = h - pct(p.ema) * (h - 8) - 4;
    i ? g.lineTo(x, y) : g.moveTo(x, y);
  });
  g.strokeStyle = "#F0A639"; g.lineWidth = 2;
  g.lineJoin = "round"; g.lineCap = "round";
  g.stroke();
}

/* ============================================================
   Helpers
   ============================================================ */
function pct(rssi){
  return Math.max(0, Math.min(1, (rssi - RSSI_MIN) / (RSSI_MAX - RSSI_MIN)));
}
function roughDistance(rssi, txPower){
  const tx = (typeof txPower === "number") ? txPower : TX_POWER;
  const m = Math.pow(10, (tx - rssi) / (10 * PATH_LOSS));
  if(m < 0.6) return "arm's length";
  if(m < 1.5) return "about a metre";
  if(m < 25) return `about ${m.toFixed(m < 10 ? 1 : 0)} m`;
  return "25 m or more";
}
function esc(s){ return String(s).replace(/[&<>"']/g, c =>
  ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c])); }
function swap(id){
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  $(id).classList.add("active");
  window.scrollTo(0,0);
}
function setStatus(text, on){
  $("statusText").textContent = text;
  $("lamp").classList.toggle("on", !!on);
}
async function requestWake(){
  try{ if("wakeLock" in navigator) S.wakeLock = await navigator.wakeLock.request("screen"); }catch(e){}
}
function releaseWake(){ if(S.wakeLock){ S.wakeLock.release().catch(()=>{}); S.wakeLock = null; } }

/* ============================================================
   Wiring
   ============================================================ */
$("btnScan").addEventListener("click", () => S.scan ? stopScan() : startScan());
$("btnPick").addEventListener("click", pickOne);

$("q").addEventListener("input", e => { S.filter = e.target.value; renderList(); });
$("btnNamed").addEventListener("click", e => {
  S.namedOnly = !S.namedOnly;
  e.currentTarget.setAttribute("aria-pressed", String(S.namedOnly));
  renderList();
});
$("btnBack").addEventListener("click", leaveHunt);

$("btnSound").addEventListener("click", e => {
  S.sound = !S.sound;
  e.currentTarget.setAttribute("aria-pressed", String(S.sound));
  e.currentTarget.textContent = S.sound ? "Sound on" : "Sound off";
  if(S.sound) startAudio();
});
$("btnBuzz").addEventListener("click", e => {
  S.buzz = !S.buzz;
  e.currentTarget.setAttribute("aria-pressed", String(S.buzz));
  e.currentTarget.textContent = S.buzz ? "Buzz on" : "Buzz off";
});

document.addEventListener("visibilitychange", () => {
  if(document.hidden) stopTick();
  else if(S.target != null){ scheduleTick(); requestWake(); }
});
window.addEventListener("resize", drawTrace);

// gauge ticks
(function ticks(){
  const g = $("ticks");
  for(let i = 0; i <= 20; i++){
    const major = i % 5 === 0;
    const a = Math.PI * (1 - i / 20);
    const r1 = major ? 132 : 140, r2 = 150;
    const l = document.createElementNS("http://www.w3.org/2000/svg","line");
    l.setAttribute("x1", 200 + Math.cos(a) * r1); l.setAttribute("y1", 168 - Math.sin(a) * r1);
    l.setAttribute("x2", 200 + Math.cos(a) * r2); l.setAttribute("y2", 168 - Math.sin(a) * r2);
    l.setAttribute("class", "tick" + (major ? " major" : ""));
    g.appendChild(l);
  }
})();

checkSupport();
setInterval(() => { if($("viewList").classList.contains("active")) renderList(); }, 1500);
