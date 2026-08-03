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
  watchdog: null,
  scanLabel: "Start scan"   // restored by stopScan(); set by checkSupport()
};

const ALPHA = 0.25;          // EMA smoothing
const TX_POWER = -59;        // assumed dBm at 1 metre
const PATH_LOSS = 2.0;
const RSSI_MIN = -100, RSSI_MAX = -35;
const TREND_WINDOW = 2500;   // ms to look back for warmer/colder
const TREND_DEADBAND = 1.5;  // dB
const SCAN_PERMISSION_TIMEOUT = 20000; // ms to wait for requestLEScan() to settle

const $ = id => document.getElementById(id);

/* Chrome exposes requestLEScan behind the experimental flag on every platform, but only
   ChromeOS and Android actually implement scanning. On Windows the backend still rides on
   Windows 8 APIs that have no scan support, so the call prompts for permission and then
   never settles. Detect the platform so the copy can say that instead of hanging silently. */
function platformName(){
  const p = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "";
  const ua = navigator.userAgent || "";
  if(/android/i.test(ua)) return "android";
  if(/cros|chrome ?os/i.test(p + ua)) return "chromeos";
  if(/win/i.test(p)) return "windows";
  if(/mac/i.test(p)) return "mac";
  if(/linux/i.test(p)) return "linux";
  return "other";
}
function scanningActuallyWorks(){
  const p = platformName();
  return p === "android" || p === "chromeos";
}

/* ============================================================
   Support check
   ============================================================ */
async function checkSupport(){
  const box = $("support");

  const blocked = msg => {
    box.textContent = msg;
    $("btnScan").disabled = true; $("btnPick").disabled = true;
  };

  if(window.self !== window.top){
    blocked("Open this page directly in Chrome. Bluetooth is blocked inside other apps.");
    return;
  }
  if(!navigator.bluetooth){
    blocked("This browser can't do Bluetooth. Use Chrome, over https.");
    return;
  }
  if(navigator.bluetooth.getAvailability){
    try{
      if(!(await navigator.bluetooth.getAvailability())){
        blocked("Bluetooth is off. Switch it on and reload.");
        return;
      }
    }catch(e){}
  }

  if(!navigator.bluetooth.requestLEScan){
    S.scanLabel = "Use picker instead";
    box.textContent = "Scanning isn't available here — add a device by hand instead.";
  } else if(!scanningActuallyWorks()){
    S.scanLabel = "Start scan";
    box.textContent = "Scanning only works on Android. Here, add a device by hand.";
  } else {
    S.scanLabel = "Start scan";
    box.textContent = "Scan hears everything nearby. Add by hand picks one device.";
  }
  $("btnScan").disabled = false;
  $("btnScan").textContent = S.scanLabel;
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
    await pickOne();
    return;
  }

  try{
    S.advCount = 0;
    $("hint").textContent = "Waiting for permission…";
    setStatus("Scanning", true);
    navigator.bluetooth.addEventListener("advertisementreceived", onAdvert);
    // requestLEScan() can hang indefinitely on desktop Chrome (Windows/macOS/Linux) even after
    // the user grants permission — the API is only solid on ChromeOS/Android. Race it against a
    // timeout so the UI never gets stuck on "Requesting scan permission…" forever.
    const pending = navigator.bluetooth.requestLEScan({
      acceptAllAdvertisements: true,
      keepRepeatedDevices: true
    });
    // If the timeout wins, the scan may still start later with nobody holding the handle.
    // Stop it on arrival so it can't keep the radio busy invisibly.
    pending.then(scan => { if(S.scan !== scan){ try{ scan.stop(); }catch(e){} } }, () => {});
    S.scan = await Promise.race([
      pending,
      new Promise((_, reject) =>
        setTimeout(() => reject({ name: "PermissionTimeout" }), SCAN_PERMISSION_TIMEOUT))
    ]);
    $("btnScan").textContent = "Stop scan";
    $("hint").textContent = "Listening. Strongest first.";

    // Scan handle in hand but no adverts: on Android that's the Location permission, on
    // desktop it's the platform gap that no setting can fix.
    clearTimeout(S.watchdog);
    S.watchdog = setTimeout(() => {
      if(S.scan && S.advCount === 0){
        $("hint").textContent = scanningActuallyWorks()
          ? "Nothing coming through. Give Chrome Location permission in Android settings, then scan again."
          : "Nothing coming through. Add a device by hand instead.";
      }
    }, 7000);

  }catch(err){
    stopScan();
    const map = {
      NotAllowedError: "Permission refused. Tap Start scan and choose Allow.",
      NotSupportedError: "This Chrome build can't scan. Add a device by hand instead.",
      NotFoundError: "No Bluetooth adapter. Switch Bluetooth on and reload.",
      InvalidStateError: "A scan is already running in another tab.",
      SecurityError: "Blocked. Open this page directly in Chrome.",
      PermissionTimeout: "The scan never started. Add a device by hand instead."
    };
    $("hint").textContent = map[err.name] || "Couldn't start the scan.";
  }
}

function stopScan(){
  clearTimeout(S.watchdog);
  if(S.scan){ try{ S.scan.stop(); }catch(e){} S.scan = null; }
  navigator.bluetooth.removeEventListener("advertisementreceived", onAdvert);
  $("btnScan").textContent = S.scanLabel;
  setStatus("Idle", false);
}

function onAdvert(e){
  const id = e.device.id;
  const rssi = e.rssi;
  if(typeof rssi !== "number") return;

  S.advCount++;

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
      $("hint").textContent = "Already on the list.";
      return;
    }
    if(!device.watchAdvertisements){
      $("hint").textContent = "This Chrome can't read signal strength.";
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
    $("hint").textContent = "Tap a device to start hunting it.";
  }catch(err){
    if(err.name === "NotFoundError") return;          // user dismissed the picker
    $("hint").textContent = "Couldn't watch that device.";
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
    ? "Nothing matches that filter."
    : "Nothing yet.";

  ul.innerHTML = shown.map(d => {
    const silent = d.ema == null || now - d.last > 12000;
    const lit = silent ? 0 : Math.max(0, Math.min(10, Math.round(pct(d.ema) * 10)));
    const segs = Array.from({length:10}, (_,i) =>
      `<span class="seg${i < lit ? " lit" : ""}"></span>`).join("");
    const name = d.name ? esc(d.name) : `<span class="anon">Unnamed device</span>`;
    const dbm  = silent ? "—" : `${Math.round(d.ema)} dBm`;
    const meta = d.ema == null
      ? "waiting for signal"
      : silent ? "gone quiet" : `${roughDistance(d.ema, d.txPower)} away`;
    return `<li data-id="${esc(d.id)}">
      <div class="row-top">
        <span class="dev-name">${name}</span>
        <span class="dbm mono">${dbm}</span>
      </div>
      <div class="segs">${segs}</div>
      <div class="row-meta">${meta}</div>
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
  if(d.ema == null) resetGauge();else paintHunt(d.txPower);
  swap("viewHunt");
  startAudio();
  requestWake();
  scheduleTick();
  drawTrace();
}

/* Park the gauge at empty until the first reading, so it can't read as full signal. */
function resetGauge(){
  const arcLen = Math.PI * 160;
  $("needle").style.transform = "rotate(-90deg)";
  $("arcFill").style.strokeDasharray = arcLen;
  $("arcFill").style.strokeDashoffset = arcLen;
  $("glow").style.opacity = 0;
  $("rssiVal").textContent = "--";
  $("distVal").textContent = "waiting for a signal";
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
      $("verdictWhy").textContent = "No signal for 8 seconds";
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
