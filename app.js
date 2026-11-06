/* Aerial Ops Log — Woodward Aviation
 * Flights are saved on the phone first (IndexedDB), then sent to the Google Sheet
 * whenever there is signal. Nothing is lost if the app closes or the phone has no service. */
(function () {
"use strict";

const API = (window.AOL_CONFIG || {}).apiUrl || "";
const TYPE_LABEL = { predator: "Predator control", survey: "Mule deer survey", other: "Other" };
const TYPE_TAG = { predator: ["pc", "PC"], survey: ["ms", "Survey"], other: ["ot", "Other"] };
const DEER = [["bucks", "Bucks"], ["does", "Does"], ["fawns", "Fawns"], ["unclassified", "Unclassified"]];
const DEFAULT_CFG = { pilots: [], aircraft: [], species: ["Coyote", "Feral hog", "Bobcat"] };

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const today = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} }
};

/* ---------------- IndexedDB: the outbox and the draft photos ---------------- */
let dbp;
function idb() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open("aerial-ops-log", 1);
    r.onupgradeneeded = () => { r.result.createObjectStore("queue", { keyPath: "clientId" }); r.result.createObjectStore("kv"); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function tx(store, mode, fn) {
  const db = await idb();
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode), s = t.objectStore(store);
    let out; const req = fn(s);
    if (req) req.onsuccess = () => { out = req.result; };
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}
const queue = {
  all: () => tx("queue", "readonly", s => s.getAll()),
  put: item => tx("queue", "readwrite", s => s.put(item)),
  del: id => tx("queue", "readwrite", s => s.delete(id))
};
const kv = {
  get: k => tx("kv", "readonly", s => s.get(k)),
  set: (k, v) => tx("kv", "readwrite", s => s.put(v, k)),
  del: k => tx("kv", "readwrite", s => s.delete(k))
};

/* ---------------- state ---------------- */
let code = ls.get("aol-code", "");
let cfg = ls.get("aol-cfg", DEFAULT_CFG);
let role = ls.get("aol-role", "crew"); // "crew" logs flights; "admin" also sees Records
let records = ls.get("aol-records", null); // {at, flights}, admin only
let step = 0;
let photos = []; // {blob, url}
let form = blankForm();
let pendingCount = 0;

function blankForm() {
  return { date: today(), pilot: "", aircraft: "", hstart: "", hend: "", type: "", hunters: [newHunter()],
    area: "", conditions: "", deer: { bucks: 0, does: 0, fawns: 0, unclassified: 0 }, purpose: "", notes: "" };
}
function newHunter() { return { name: "", license: "", harvest: {} }; }

/* ---------------- ui helpers ---------------- */
let tt;
function toast(m) { const t = $("#toast"); t.textContent = m; t.hidden = false; clearTimeout(tt); tt = setTimeout(() => (t.hidden = true), 2800); }
function chip() {
  const s = $("#sync");
  if (!navigator.onLine) { s.className = "chip warn"; s.textContent = pendingCount ? `No signal · ${pendingCount} waiting` : "No signal"; return; }
  if (pendingCount) { s.className = "chip warn"; s.textContent = `${pendingCount} waiting to send`; return; }
  s.className = "chip ok"; s.textContent = "All sent";
}
async function refreshPending() {
  try { pendingCount = (await queue.all()).length; } catch (e) { pendingCount = 0; }
  const p = $("#pending");
  p.hidden = !pendingCount;
  p.textContent = pendingCount ? `${pendingCount} flight${pendingCount > 1 ? "s" : ""} saved on this phone, waiting for signal to send.` : "";
  chip();
}

function show(view) {
  if (!code) view = "code";
  $("#tabs").hidden = view === "code";
  $$("nav.tabs button").forEach(b => b.setAttribute("aria-selected", b.dataset.view === view));
  if (view === "records" && role !== "admin") view = "log";
  $$("nav.tabs button").forEach(b => b.setAttribute("aria-selected", b.dataset.view === view));
  ["code", "log", "mine", "records"].forEach(v => ($("#view-" + v).hidden = v !== view));
  if (view !== "code") ls.set("aol-tab", view);
  if (view === "mine") renderMine();
  if (view === "records") { renderRecords(); loadRecords(); }
}
$$("nav.tabs button").forEach(b => b.addEventListener("click", () => show(b.dataset.view)));

/* ---------------- API ---------------- */
async function apiGet(action) {
  const r = await fetch(`${API}?action=${action}&code=${encodeURIComponent(code)}`, { cache: "no-store" });
  return r.json();
}
async function apiPost(body) {
  // text/plain keeps this a "simple" request, which Apps Script accepts from another site.
  const r = await fetch(API, { method: "POST", body: JSON.stringify(body) });
  return r.json();
}
async function loadConfig() {
  if (!navigator.onLine || !code) return;
  try {
    const r = await apiGet("config");
    if (r.ok) { setRole(r.role); cfg = { pilots: r.pilots || [], aircraft: r.aircraft || [], species: (r.species && r.species.length) ? r.species : DEFAULT_CFG.species }; ls.set("aol-cfg", cfg); if (step === 0) renderStep1(); if (step === 1) renderMission(); }
    else if (r.error === "bad_code") signOut("That code no longer works. Ask the office for the current one.");
  } catch (e) { /* offline or slow: keep the saved lists */ }
}
function setRole(r) {
  role = r === "admin" ? "admin" : "crew"; ls.set("aol-role", role);
  $("#tab-records").hidden = role !== "admin";
  $("#role-label").textContent = role === "admin" ? "office (admin)" : "crew";
  if (role !== "admin") { records = null; ls.del("aol-records"); if (!$("#view-records").hidden) show("log"); }
}
function signOut(msg) { code = ""; ls.del("aol-code"); show("code"); if (msg) { $("#code-err").textContent = msg; $("#code-err").hidden = false; } }

$("#btn-switch").addEventListener("click", () => { $("#code-err").hidden = true; signOut(); });

/* ---------------- crew code ---------------- */
$("#code-btn").addEventListener("click", async () => {
  const v = $("#code-in").value.trim(); const er = $("#code-err");
  if (!v) { er.textContent = "Enter your code."; er.hidden = false; return; }
  if (!API || API.startsWith("PASTE")) { er.textContent = "This app isn't connected to the records sheet yet. The office needs to finish setup (config.js)."; er.hidden = false; return; }
  if (!navigator.onLine) { er.textContent = "You need signal the first time you sign in."; er.hidden = false; return; }
  const btn = $("#code-btn"); btn.disabled = true; btn.textContent = "Checking…";
  try {
    code = v;
    const r = await apiGet("config");
    if (!r.ok) { code = ""; er.textContent = "That code isn't right. Check with the office."; er.hidden = false; return; }
    ls.set("aol-code", v); setRole(r.role); $("#code-in").value = "";
    cfg = { pilots: r.pilots || [], aircraft: r.aircraft || [], species: (r.species && r.species.length) ? r.species : DEFAULT_CFG.species };
    ls.set("aol-cfg", cfg);
    er.hidden = true; if ($("#done").hidden) go(step); show(role === "admin" ? "records" : "log");
  } catch (e) { code = ""; er.textContent = "Couldn't reach the records sheet. Try again in a moment."; er.hidden = false; }
  finally { btn.disabled = false; btn.textContent = "Continue"; }
});

/* ---------------- draft ---------------- */
function saveDraft() { ls.set("aol-draft", { form, step }); }
async function saveDraftPhotos() { try { await kv.set("draft-photos", photos.map(p => p.blob)); } catch (e) {} }
async function loadDraft() {
  const d = ls.get("aol-draft", null);
  if (d && d.form) { form = Object.assign(blankForm(), d.form); step = Math.min(d.step || 0, 3); }
  try { const blobs = (await kv.get("draft-photos")) || []; photos = blobs.map(b => ({ blob: b, url: URL.createObjectURL(b) })); } catch (e) {}
}

/* ---------------- step 1 ---------------- */
function options(list, val) {
  const all = val && !list.includes(val) ? [...list, val] : list;
  return `<option value="">Select…</option>` + all.map(x => `<option${x === val ? " selected" : ""}>${esc(x)}</option>`).join("");
}
function renderStep1() {
  $("#f-date").value = form.date; $("#f-hstart").value = form.hstart;
  $("#f-pilot").innerHTML = options(cfg.pilots, form.pilot);
  $("#f-aircraft").innerHTML = options(cfg.aircraft, form.aircraft);
  $$('input[name="ftype"]').forEach(r => { r.checked = r.value === form.type; r.closest("label").classList.toggle("on", r.checked); });
}

const FIELD = { "f-date": "date", "f-pilot": "pilot", "f-aircraft": "aircraft", "f-hstart": "hstart", "f-hend": "hend", "f-notes": "notes", "m-area": "area", "m-cond": "conditions", "m-purpose": "purpose" };
function onField(e) {
  const t = e.target, id = t.id;
  if (FIELD[id]) { form[FIELD[id]] = t.value; t.classList.remove("invalid"); }
  if (t.name === "ftype") { form.type = t.value; $$('input[name="ftype"]').forEach(r => r.closest("label").classList.toggle("on", r.checked)); $("#err-0").hidden = true; }
  if (id === "f-hend" || id === "f-hstart") renderHours();
  if (t.dataset.h != null) { form.hunters[+t.dataset.h][t.dataset.k] = t.value; t.classList.remove("invalid"); }
  if (t.dataset.cnt) setCount(t.dataset.cnt, t.value, false);
  saveDraft();
}
document.addEventListener("input", onField);
document.addEventListener("change", e => { if (e.target.tagName === "SELECT" || e.target.type === "radio") onField(e); });

/* ---------------- step 2 ---------------- */
function counter(key, label, val) {
  const id = "c-" + key.replace(/[^a-z0-9]/gi, "_");
  return `<div class="ctr"><span class="nm">${esc(label)}</span><div class="row"><button type="button" data-dec="${esc(key)}" aria-label="Minus one ${esc(label)}">−</button><input class="num" inputmode="numeric" data-cnt="${esc(key)}" id="${esc(id)}" value="${val || 0}" aria-label="${esc(label)} count"><button type="button" data-inc="${esc(key)}" aria-label="Plus one ${esc(label)}">+</button></div></div>`;
}
function pastAreas() {
  const seen = new Set((records && records.flights || []).map(f => f.area).filter(Boolean));
  ls.get("aol-areas", []).forEach(a => seen.add(a));
  return [...seen].sort();
}
function areaField() {
  return `<label class="f"><span>Area / property <span class="req">required</span></span><input id="m-area" list="area-list" value="${esc(form.area)}" placeholder="Ranch or property name" autocomplete="off"></label><datalist id="area-list">${pastAreas().map(a => `<option value="${esc(a)}"></option>`).join("")}</datalist>`;
}
function renderMission() {
  const m = $("#mission");
  if (form.type === "predator") {
    m.innerHTML = `<div class="stack"><div><h2>Predator control</h2><p class="lead">List every hunter aboard before takeoff. Tap counters as animals are taken.</p></div>
      ${areaField()}
      ${form.hunters.map((h, i) => `<div class="hunter"><div class="hd"><h3>Hunter ${i + 1}</h3>${form.hunters.length > 1 ? `<button type="button" class="btn small ghost" data-rmh="${i}">Remove</button>` : ""}</div>
        <div class="grid2"><label class="f"><span>Name <span class="req">required</span></span><input id="h-name-${i}" data-h="${i}" data-k="name" value="${esc(h.name)}" autocomplete="off"></label>
        <label class="f"><span>License / permit # <span class="req">required</span></span><input id="h-lic-${i}" class="num" data-h="${i}" data-k="license" value="${esc(h.license)}" autocapitalize="characters" autocomplete="off"></label></div>
        <div class="counters">${cfg.species.map(s => counter(i + "|" + s, s, h.harvest[s])).join("")}</div></div>`).join("")}
      <button type="button" class="btn" id="btn-addh">+ Add hunter</button>
      <div class="total"><span>Total harvest</span><b id="tot">${harvestTotal()}</b></div></div>`;
  } else if (form.type === "survey") {
    m.innerHTML = `<div class="stack"><div><h2>Mule deer survey</h2><p class="lead">Tap counters as groups are classified. The total adds up on its own.</p></div>
      <div class="grid2">${areaField()}
      <label class="f"><span>Survey conditions <span class="req">required</span></span><select id="m-cond"><option value="">Select…</option>${["Good", "Fair", "Poor"].map(c => `<option${c === form.conditions ? " selected" : ""}>${c}</option>`).join("")}</select></label></div>
      <div class="counters">${DEER.map(([k, l]) => counter("deer|" + k, l, form.deer[k])).join("")}</div>
      <div class="total"><span>Total deer</span><b id="tot">${deerTotal()}</b></div></div>`;
  } else {
    m.innerHTML = `<div class="stack"><div><h2>Other flight</h2><p class="lead">Say what the flight was for.</p></div>
      <label class="f"><span>Purpose <span class="req">required</span></span><input id="m-purpose" value="${esc(form.purpose)}" placeholder="Charter, cattle gather, ferry, training…"></label></div>`;
  }
}
function harvestTotal() { return form.hunters.reduce((a, h) => a + Object.values(h.harvest || {}).reduce((x, y) => x + (+y || 0), 0), 0); }
function deerTotal() { return DEER.reduce((a, [k]) => a + (+form.deer[k] || 0), 0); }
function getCount(k) { const [a, b] = k.split("|"); return a === "deer" ? (+form.deer[b] || 0) : (+form.hunters[+a].harvest[b] || 0); }
function setCount(key, v, push) {
  v = Math.max(0, Math.min(9999, parseInt(v, 10) || 0));
  const [a, b] = key.split("|");
  if (a === "deer") form.deer[b] = v; else form.hunters[+a].harvest[b] = v;
  if (push !== false) { const inp = document.querySelector(`[data-cnt="${CSS.escape(key)}"]`); if (inp) inp.value = v; }
  const t = $("#tot"); if (t) t.textContent = form.type === "survey" ? deerTotal() : harvestTotal();
  saveDraft();
}
document.addEventListener("click", e => {
  const t = e.target.closest("button"); if (!t) return;
  if (t.dataset.inc) setCount(t.dataset.inc, getCount(t.dataset.inc) + 1);
  if (t.dataset.dec) setCount(t.dataset.dec, getCount(t.dataset.dec) - 1);
  if (t.id === "btn-addh") { form.hunters.push(newHunter()); renderMission(); saveDraft(); }
  if (t.dataset.rmh != null) { form.hunters.splice(+t.dataset.rmh, 1); renderMission(); saveDraft(); }
  if (t.dataset.rmp != null) { const p = photos.splice(+t.dataset.rmp, 1)[0]; if (p) URL.revokeObjectURL(p.url); renderShots(); saveDraftPhotos(); }
});

/* ---------------- step 3 ---------------- */
function hoursVal() { const s = parseFloat(form.hstart), e = parseFloat(form.hend); if (isNaN(s) || isNaN(e)) return null; return Math.round((e - s) * 10) / 10; }
function renderHours() { const h = hoursVal(); $("#hours").textContent = h == null ? "—" : h.toFixed(1); }
function renderShots() { $("#shots").innerHTML = photos.map((p, i) => `<div class="shot"><img src="${p.url}" alt="Log photo ${i + 1}"><button type="button" data-rmp="${i}" aria-label="Remove photo ${i + 1}">×</button></div>`).join(""); }
$("#f-photo").addEventListener("change", async e => {
  const files = [...e.target.files]; e.target.value = "";
  for (const f of files) {
    try { const blob = await compress(f); photos.push({ blob, url: URL.createObjectURL(blob) }); }
    catch (err) { toast("That photo couldn't be read. Try again."); }
  }
  renderShots(); saveDraftPhotos(); $("#err-2").hidden = true;
});
function compress(file) {
  return new Promise((res, rej) => {
    const img = new Image(), u = URL.createObjectURL(file);
    img.onload = () => {
      const max = 1800, sc = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas"); c.width = Math.round(img.width * sc); c.height = Math.round(img.height * sc);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(u);
      c.toBlob(b => (b ? res(b) : rej()), "image/jpeg", 0.8);
    };
    img.onerror = () => { URL.revokeObjectURL(u); rej(); };
    img.src = u;
  });
}

/* ---------------- validation & steps ---------------- */
function mark(id) { const el = document.getElementById(id); if (el) el.classList.add("invalid"); return id; }
function validate(s) {
  const bad = []; let msg = "";
  if (s === 0) {
    if (!form.date) bad.push(mark("f-date"));
    if (!form.pilot) bad.push(mark("f-pilot"));
    if (!form.aircraft) bad.push(mark("f-aircraft"));
    if (form.hstart === "" || isNaN(parseFloat(form.hstart))) bad.push(mark("f-hstart"));
    if (!form.type) { bad.push("type"); msg = bad.length === 1 ? "Pick a flight type." : ""; }
  }
  if (s === 1) {
    if (form.type !== "other" && !form.area.trim()) bad.push(mark("m-area"));
    if (form.type === "predator") form.hunters.forEach((h, i) => { if (!h.name.trim()) bad.push(mark("h-name-" + i)); if (!h.license.trim()) bad.push(mark("h-lic-" + i)); });
    if (form.type === "survey" && !form.conditions) bad.push(mark("m-cond"));
    if (form.type === "other" && !form.purpose.trim()) bad.push(mark("m-purpose"));
  }
  if (s === 2) {
    const h = hoursVal();
    if (form.hend === "" || h == null) bad.push(mark("f-hend"));
    else if (h <= 0) { bad.push(mark("f-hend")); msg = `Hobbs end must be higher than Hobbs start (${form.hstart}).`; }
    else if (h > 12) { bad.push(mark("f-hend")); msg = `That's ${h.toFixed(1)} hours. Check Hobbs start and end.`; }
    if (!photos.length) { bad.push("photo"); msg = msg || "Take a photo of the log page before continuing."; }
  }
  const er = $("#err-" + s);
  if (bad.length) { er.textContent = msg || "Fill in the fields marked in red."; er.hidden = false; return false; }
  er.hidden = true; return true;
}
const NEXT_LABEL = ["Next: Mission", "Next: Postflight", "Next: Review", "Submit flight"];
function go(s) {
  step = s;
  $$(".step").forEach(el => (el.hidden = +el.dataset.step !== s));
  $$("#steps li").forEach(li => { const i = +li.dataset.s; li.className = i < s ? "done" : i === s ? "cur" : ""; });
  $("#btn-back").style.visibility = s === 0 ? "hidden" : "visible";
  $("#btn-next").textContent = NEXT_LABEL[s];
  if (s === 0) renderStep1();
  if (s === 1) renderMission();
  if (s === 2) { $("#f-hend").value = form.hend; $("#f-notes").value = form.notes; renderHours(); renderShots(); }
  if (s === 3) renderReview();
  saveDraft(); window.scrollTo({ top: 0 });
}
$("#btn-back").addEventListener("click", () => go(Math.max(0, step - 1)));
$("#btn-next").addEventListener("click", () => { if (step < 3) { if (validate(step)) go(step + 1); } else submit(); });

function renderReview() {
  const h = hoursVal();
  let mission = "";
  if (form.type === "predator") {
    mission = `<div class="tblwrap"><table><thead><tr><th>Hunter</th><th>License</th>${cfg.species.map(s => `<th class="n">${esc(s)}</th>`).join("")}</tr></thead><tbody>${form.hunters.map(x => `<tr><td>${esc(x.name)}</td><td class="mono">${esc(x.license)}</td>${cfg.species.map(s => `<td class="n">${x.harvest[s] || 0}</td>`).join("")}</tr>`).join("")}</tbody></table></div><div class="total"><span>Total harvest</span><b>${harvestTotal()}</b></div>`;
  } else if (form.type === "survey") {
    mission = `<dl class="kv">${DEER.map(([k, l]) => `<dt>${l}</dt><dd>${form.deer[k] || 0}</dd>`).join("")}<dt>Conditions</dt><dd>${esc(form.conditions)}</dd></dl><div class="total"><span>Total deer</span><b>${deerTotal()}</b></div>`;
  } else mission = `<dl class="kv"><dt>Purpose</dt><dd>${esc(form.purpose)}</dd></dl>`;
  $("#review").innerHTML = `<div class="stack"><dl class="kv"><dt>Date</dt><dd>${esc(form.date)}</dd><dt>Pilot</dt><dd>${esc(form.pilot)}</dd><dt>Aircraft</dt><dd>${esc(form.aircraft)}</dd><dt>Type</dt><dd>${TYPE_LABEL[form.type]}</dd>${form.type !== "other" ? `<dt>Area</dt><dd>${esc(form.area)}</dd>` : ""}<dt>Hobbs</dt><dd style="font-family:var(--mono)">${esc(form.hstart)} → ${esc(form.hend)} = <b>${h.toFixed(1)} hr</b></dd><dt>Log photos</dt><dd>${photos.length}</dd>${form.notes ? `<dt>Notes</dt><dd>${esc(form.notes)}</dd>` : ""}</dl>${mission}</div>`;
}

/* ---------------- submit & outbox ---------------- */
function buildFlight() {
  const f = { clientId: uid(), date: form.date, pilot: form.pilot, aircraft: form.aircraft, type: form.type,
    hobbsStart: +form.hstart, hobbsEnd: +form.hend, hours: hoursVal(), notes: form.notes.trim() };
  if (form.type === "predator") {
    f.area = form.area.trim();
    f.hunters = form.hunters.map(h => ({ name: h.name.trim(), license: h.license.trim().toUpperCase(), harvest: Object.fromEntries(Object.entries(h.harvest).filter(([, v]) => +v > 0)) }));
    f.harvestTotal = harvestTotal();
  }
  if (form.type === "survey") { f.area = form.area.trim(); f.conditions = form.conditions; f.deer = { ...form.deer }; f.deerTotal = deerTotal(); }
  if (form.type === "other") f.purpose = form.purpose.trim();
  return f;
}
async function submit() {
  const btn = $("#btn-next"); btn.disabled = true; btn.textContent = "Saving…";
  const flight = buildFlight();
  try {
    await queue.put({ clientId: flight.clientId, flight, photos: photos.map(p => p.blob), savedAt: Date.now() });
  } catch (e) {
    $("#err-3").textContent = "This phone couldn't save the flight. Free up some storage, then tap Submit again.";
    $("#err-3").hidden = false; btn.disabled = false; btn.textContent = NEXT_LABEL[3]; return;
  }
  addMine(flight);
  if (flight.area) { const a = ls.get("aol-areas", []); if (!a.includes(flight.area)) { a.push(flight.area); ls.set("aol-areas", a); } }
  photos.forEach(p => URL.revokeObjectURL(p.url)); photos = []; kv.del("draft-photos").catch(() => {});
  const keep = { pilot: form.pilot, aircraft: form.aircraft, hstart: form.hend };
  form = Object.assign(blankForm(), keep); step = 0; saveDraft();
  btn.disabled = false;
  $$(".step").forEach(el => (el.hidden = true)); $("#nav-actions").hidden = true; $("#steps").hidden = true; $("#done").hidden = false;
  $("#done-msg").textContent = "Saved on this phone. Sending to the records sheet…";
  await refreshPending();
  const sent = await flush();
  $("#done-msg").textContent = sent.includes(flight.clientId)
    ? `Sent. ${flight.hours.toFixed(1)} hours logged for ${flight.pilot} in ${flight.aircraft}.`
    : "No signal right now. The flight is saved on this phone and will send itself once you're back in range. You don't need to do anything else.";
}
$("#btn-new").addEventListener("click", () => { $("#done").hidden = true; $("#nav-actions").hidden = false; $("#steps").hidden = false; go(0); });

const toB64 = blob => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.onerror = rej; r.readAsDataURL(blob); });
let flushing = null;
function flush() {
  if (flushing) return flushing.then(() => flush());
  flushing = (async () => {
    const sent = [];
    if (!code || !API || API.startsWith("PASTE") || !navigator.onLine) return sent;
    let items = [];
    try { items = await queue.all(); } catch (e) { return sent; }
    for (const it of items) {
      try {
        const ph = await Promise.all((it.photos || []).map(async b => ({ mime: b.type || "image/jpeg", data: await toB64(b) })));
        const r = await apiPost({ action: "submit", code, flight: it.flight, photos: ph });
        if (r.ok) { await queue.del(it.clientId); sent.push(it.clientId); markSent(it.clientId); }
        else if (r.error === "bad_code") { signOut("The crew code changed. Enter the new one; your saved flights will send after."); break; }
        else if (r.error === "invalid") { it.problem = r.message; await queue.put(it); toast("A saved flight was rejected: " + r.message); }
      } catch (e) { break; } // no signal or the sheet is unreachable: try again later
    }
    return sent;
  })();
  return flushing.finally(async () => { flushing = null; await refreshPending(); if (role === "admin" && records) loadRecords(true); if (!$("#view-mine").hidden) renderMine(); });
}
window.addEventListener("online", () => { chip(); flush(); loadConfig(); });
window.addEventListener("offline", chip);
document.addEventListener("visibilitychange", () => { if (!document.hidden) flush(); });
setInterval(() => { if (pendingCount) flush(); }, 60000);
$("#sync").addEventListener("click", () => { if (pendingCount) { toast("Trying to send…"); flush(); } else chip(); });

/* ---------------- my flights (this phone only) ---------------- */
function addMine(f) {
  const list = ls.get("aol-mine", []);
  list.unshift({ id: f.clientId, date: f.date, pilot: f.pilot, aircraft: f.aircraft, type: f.type, area: f.area || "", purpose: f.purpose || "",
    hours: f.hours, total: f.type === "predator" ? f.harvestTotal : f.type === "survey" ? f.deerTotal : null, sent: false });
  ls.set("aol-mine", list.slice(0, 100));
}
function markSent(id) { const list = ls.get("aol-mine", []); const m = list.find(x => x.id === id); if (m) { m.sent = true; ls.set("aol-mine", list); } }
async function renderMine() {
  let waiting = new Set();
  try { waiting = new Set((await queue.all()).map(q => q.clientId)); } catch (e) {}
  const list = ls.get("aol-mine", []);
  $("#mine-list").innerHTML = list.length ? list.map(m => {
    const [cls, lab] = TYPE_TAG[m.type] || TYPE_TAG.other;
    const isWait = waiting.has(m.id) || !m.sent;
    const sub = m.type === "predator" ? `${m.total || 0} taken` : m.type === "survey" ? `${m.total || 0} deer` : esc(m.purpose);
    return `<div class="flight"><div style="padding:12px 14px;display:grid;grid-template-columns:auto 1fr auto;gap:10px;align-items:center"><span class="tag ${cls}">${lab}</span><span class="meta"><b>${esc(m.date)} · ${esc(String(m.aircraft).split(" ")[0])} · ${(+m.hours || 0).toFixed(1)} h</b><small>${esc(m.area)}${m.area ? " · " : ""}${sub}</small></span><span class="tag ${isWait && waiting.has(m.id) ? "wait" : "sent"}">${isWait && waiting.has(m.id) ? "Waiting" : "Sent"}</span></div></div>`;
  }).join("") : `<div class="empty">No flights from this phone yet. Flights you submit show up here with whether they've reached the office.</div>`;
}

/* ---------------- records ---------------- */
async function loadRecords(quiet) {
  if (role !== "admin") return;
  if (!navigator.onLine || !code || !API || API.startsWith("PASTE")) { renderRecords(); return; }
  try {
    const r = await apiGet("records");
    if (r.ok) { records = { at: Date.now(), flights: r.flights || [] }; ls.set("aol-records", records); renderRecords(); }
    else if (r.error === "admin_only") setRole("crew");
    else if (r.error === "bad_code") signOut("That code no longer works.");
  } catch (e) { if (!quiet) toast("Couldn't reach the records sheet."); renderRecords(); }
}
$("#btn-refresh").addEventListener("click", () => loadRecords());
["#r-type", "#r-pilot", "#r-from", "#r-to"].forEach(s => $(s).addEventListener("input", renderRecords));
function filtered() {
  const t = $("#r-type").value, p = $("#r-pilot").value, fr = $("#r-from").value, to = $("#r-to").value;
  return (records ? records.flights : []).filter(f => (!t || f.type === t) && (!p || f.pilot === p) && (!fr || f.date >= fr) && (!to || f.date <= to))
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
}
function renderRecords() {
  const all = records ? records.flights : [];
  $("#rec-asof").textContent = records ? `All flights from every pilot. Updated ${new Date(records.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}.` : "All flights from every pilot, newest first.";
  const sel = $("#r-pilot"), cur = sel.value, names = [...new Set([...cfg.pilots, ...all.map(f => f.pilot)])].filter(Boolean).sort();
  sel.innerHTML = `<option value="">All pilots</option>` + names.map(n => `<option${n === cur ? " selected" : ""}>${esc(n)}</option>`).join("");
  const list = filtered();
  const hrs = list.reduce((a, f) => a + (+f.hours || 0), 0);
  $("#stats").innerHTML = [["Flights", list.length], ["Flight hours", hrs.toFixed(1)], ["Predators taken", list.reduce((a, f) => a + (f.harvestTotal || 0), 0)], ["Deer counted", list.reduce((a, f) => a + (f.deerTotal || 0), 0)]]
    .map(([k, v]) => `<div class="stat"><div class="v">${v}</div><div class="k">${k}</div></div>`).join("");

  const byPilot = {}, bySp = {}, byLic = {}, byArea = {};
  list.forEach(f => {
    const p = byPilot[f.pilot] || (byPilot[f.pilot] = { n: 0, h: 0, pc: 0, ms: 0 });
    p.n++; p.h += +f.hours || 0; if (f.type === "predator") p.pc++; if (f.type === "survey") p.ms++;
    if (f.type === "predator") (f.hunters || []).forEach(h => {
      Object.entries(h.harvest || {}).forEach(([s, v]) => (bySp[s] = (bySp[s] || 0) + (+v || 0)));
      const k = h.license + "|" + h.name, o = byLic[k] || (byLic[k] = { name: h.name, lic: h.license, fl: 0, tot: 0 });
      o.fl++; o.tot += Object.values(h.harvest || {}).reduce((a, b) => a + (+b || 0), 0);
    });
    if (f.type === "survey") {
      const a = byArea[f.area] || (byArea[f.area] = { n: 0, bucks: 0, does: 0, fawns: 0, unclassified: 0, t: 0 });
      a.n++; DEER.forEach(([k]) => (a[k] += +(f.deer || {})[k] || 0)); a.t += f.deerTotal || 0;
    }
  });
  let h = "";
  if (Object.keys(byPilot).length) h += `<div class="panel stack"><h3>Hours by pilot</h3><div class="tblwrap"><table><thead><tr><th>Pilot</th><th class="n">Flights</th><th class="n">Predator</th><th class="n">Survey</th><th class="n">Hours</th></tr></thead><tbody>${Object.entries(byPilot).sort((a, b) => b[1].h - a[1].h).map(([n, p]) => `<tr><td>${esc(n)}</td><td class="n">${p.n}</td><td class="n">${p.pc}</td><td class="n">${p.ms}</td><td class="n">${p.h.toFixed(1)}</td></tr>`).join("")}</tbody></table></div></div>`;
  if (Object.keys(byLic).length) h += `<div class="panel stack"><h3>Harvest by hunter</h3><div class="tblwrap"><table><thead><tr><th>Hunter</th><th>License / permit</th><th class="n">Flights</th><th class="n">Taken</th></tr></thead><tbody>${Object.values(byLic).sort((a, b) => b.tot - a.tot).map(o => `<tr><td>${esc(o.name)}</td><td class="mono">${esc(o.lic)}</td><td class="n">${o.fl}</td><td class="n">${o.tot}</td></tr>`).join("")}</tbody></table></div>${Object.keys(bySp).length ? `<div class="tblwrap"><table><thead><tr><th>Species</th><th class="n">Taken</th></tr></thead><tbody>${Object.entries(bySp).sort((a, b) => b[1] - a[1]).map(([s, v]) => `<tr><td>${esc(s)}</td><td class="n">${v}</td></tr>`).join("")}</tbody></table></div>` : ""}</div>`;
  if (Object.keys(byArea).length) h += `<div class="panel stack"><h3>Mule deer by area</h3><div class="tblwrap"><table><thead><tr><th>Area</th><th class="n">Flights</th>${DEER.map(([, l]) => `<th class="n">${l}</th>`).join("")}<th class="n">Total</th></tr></thead><tbody>${Object.entries(byArea).sort().map(([n, a]) => `<tr><td>${esc(n)}</td><td class="n">${a.n}</td>${DEER.map(([k]) => `<td class="n">${a[k]}</td>`).join("")}<td class="n"><b>${a.t}</b></td></tr>`).join("")}</tbody></table></div></div>`;
  $("#summaries").innerHTML = h;
  $("#flights").innerHTML = list.length ? list.map(flightCard).join("")
    : `<div class="empty">${!records ? (navigator.onLine ? "Loading records…" : "Records load the first time you open this tab with signal.") : all.length ? "No flights match these filters." : "No flights logged yet. Flights appear here once they reach the records sheet."}</div>`;
}
function flightCard(f) {
  let detail = "";
  if (f.type === "predator") detail = `<div class="tblwrap"><table><thead><tr><th>Hunter</th><th>License</th><th>Harvest</th></tr></thead><tbody>${(f.hunters || []).map(h => `<tr><td>${esc(h.name)}</td><td class="mono">${esc(h.license)}</td><td>${Object.entries(h.harvest || {}).map(([s, v]) => esc(s) + " " + v).join(", ") || "None"}</td></tr>`).join("")}</tbody></table></div>`;
  if (f.type === "survey") detail = `<dl class="kv">${DEER.map(([k, l]) => `<dt>${l}</dt><dd>${(f.deer || {})[k] || 0}</dd>`).join("")}<dt>Conditions</dt><dd>${esc(f.conditions)}</dd></dl>`;
  if (f.type === "other") detail = `<dl class="kv"><dt>Purpose</dt><dd>${esc(f.purpose)}</dd></dl>`;
  const nh = (f.hunters || []).length;
  const sub = f.type === "predator" ? `${f.harvestTotal || 0} taken · ${nh} hunter${nh === 1 ? "" : "s"}` : f.type === "survey" ? `${f.deerTotal || 0} deer` : esc(f.purpose || "");
  const [cls, lab] = TYPE_TAG[f.type] || TYPE_TAG.other;
  return `<details class="flight"><summary><span class="tag ${cls}">${lab}</span><span class="meta"><b>${esc(f.date)} · ${esc(f.pilot)} · ${esc(String(f.aircraft).split(" ")[0])}</b><small>${esc(f.area || "")}${f.area ? " · " : ""}${sub}</small></span><span class="hrs">${(+f.hours || 0).toFixed(1)} h</span></summary>
  <div class="body"><dl class="kv"><dt>Hobbs</dt><dd style="font-family:var(--mono)">${esc(f.hobbsStart)} → ${esc(f.hobbsEnd)}</dd>${f.notes ? `<dt>Notes</dt><dd>${esc(f.notes)}</dd>` : ""}<dt>Log</dt><dd>${(f.logPhotos || []).map((u, i) => `<a href="${esc(u)}" target="_blank" rel="noopener">Log photo${f.logPhotos.length > 1 ? " " + (i + 1) : ""}</a>`).join(" · ") || "No photo"}</dd></dl>${detail}</div></details>`;
}

/* ---------------- start ---------------- */
(async function start() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  setRole(role);
  await loadDraft();
  go(step);
  show(code ? ls.get("aol-tab", "log") : "code");
  await refreshPending();
  loadConfig();
  flush();
})();
})();
