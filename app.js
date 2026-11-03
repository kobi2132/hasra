import { CONFIG } from "./config.js";
import { createStore, normPhone, tsMillis } from "./store.js";
import { loadVideos, guessYear } from "./videos.js";

const store = createStore();
const $ = (s, r = document) => r.querySelector(s);
const app = $("#app");
let videos = [];
let route = { name: "list" };
const ui = { q: "", person: null, sort: "order" };
let player = null, playerVid = null, pendingSeek = null, tick = null;
let marking = null; // {t} כשטופס "סמן רגע" פתוח
let editing = null; // {coll,id} פריט בעריכה
let descOpen = false;
let editVideo = false;

/* ---------- helpers ---------- */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function fmt(s) {
  s = Math.max(0, Math.round(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(r).padStart(2, "0");
}
function parseT(str) {
  const p = String(str).trim().split(":").map(Number);
  if (p.some(isNaN) || !p.length) return null;
  return p.reduce((a, b) => a * 60 + b, 0);
}
function hue(name) { let h = 0; for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
function initials(n) { return String(n || "?").replace(/^(דוד|דודה|סבא|סבתא)\s+/, "").trim().charAt(0) || "?"; }
function av(n) { return `<span class="avatar" style="background:hsl(${hue(n)} 45% 42%)" aria-hidden="true">${esc(initials(n))}</span>`; }
const rtf = new Intl.RelativeTimeFormat("he", { numeric: "auto" });
function ago(ms) {
  const d = (ms - Date.now()) / 1000;
  const units = [["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60]];
  for (const [u, s] of units) if (Math.abs(d) >= s) return rtf.format(Math.round(d / s), u);
  return "עכשיו";
}
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), 3200);
}
function knownNames() {
  const s = new Set();
  store.list("tags").forEach((t) => s.add(t.name));
  store.list("users").forEach((u) => u.name && s.add(u.name));
  return [...s].sort((a, b) => b.length - a.length);
}
function richify(text) {
  let h = esc(text);
  h = h.replace(/(^|[^\d:])(\d{1,2}:\d{2}(?::\d{2})?)(?![\d:])/g, (m, pre, t) => `${pre}<button class="tlink" data-seek="${parseT(t)}">${t}</button>`);
  const names = knownNames().map(esc);
  h = h.replace(/@([^\s@<]+(?:\s[^\s@<]+)?)/g, (m, cand) => {
    const hit = names.find((n) => cand === n || cand.startsWith(n));
    if (hit) return `<span class="mention">@${hit}</span>${cand.slice(hit.length)}`;
    const one = cand.split(/\s/)[0];
    return `<span class="mention">@${one}</span>${cand.slice(one.length)}`;
  });
  return h;
}
function videoMerged(v) {
  const e = store.data.videoEdits.get(v.id) || {};
  return { ...v, title: e.title || v.title, desc: e.desc ?? v.desc, year: e.year || guessYear(e.title || v.title, e.desc ?? v.desc) };
}
const thumbUrl = (v) => (v.demo ? "" : `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`);

/* ---------- routing ---------- */
function parseRoute() {
  const h = location.hash.replace(/^#\/?/, "");
  const [path, qs] = h.split("?");
  const params = new URLSearchParams(qs || "");
  if (path.startsWith("v/")) return { name: "video", id: decodeURIComponent(path.slice(2)), t: +params.get("t") || 0 };
  return { name: "list", person: params.get("p") || null };
}
function onRoute() {
  const r = parseRoute();
  const changedVideo = r.name !== route.name || r.id !== route.id;
  route = r;
  if (r.name === "list") {
    ui.person = r.person;
    destroyPlayer();
    renderList(true);
  } else {
    if (changedVideo) { marking = null; editing = null; descOpen = false; editVideo = false; destroyPlayer(); renderVideoShell(); }
    renderVideoParts();
    if (r.t) seek(r.t);
  }
  if (changedVideo) window.scrollTo(0, 0);
}
window.addEventListener("hashchange", onRoute);

/* ---------- top bar ---------- */
function topBar(left) {
  const u = store.user;
  const userBtn = u
    ? `<button class="userbtn" data-act="menu">${av(u.name)}<span>${esc(u.name)}</span>${store.isAdmin ? '<span class="badge">מנהל</span>' : ""}</button>`
    : `<button class="userbtn anon" data-act="login">כניסה</button>`;
  return `${store.mode === "demo" ? '<div class="demo-bar">מצב הדגמה: הנתונים נשמרים רק בדפדפן הזה</div>' : ""}
  <header class="top">${left}<span class="grow"></span>${userBtn}</header>`;
}

/* ---------- list ---------- */
function filtered() {
  const q = ui.q.trim().toLowerCase();
  let list = videos.map(videoMerged).map((v) => {
    const tags = store.list("tags", v.id).map((t) => t.name);
    const hls = store.list("highlights", v.id);
    return { ...v, tags, hlCount: hls.length, cmCount: store.list("comments", v.id).length, hls };
  });
  if (ui.person) list = list.filter((v) => v.tags.includes(ui.person));
  if (q) {
    list = list.map((v) => {
      const inMain = (v.title + " " + v.desc + " " + v.tags.join(" ")).toLowerCase().includes(q);
      const hit = v.hls.find((h) => h.text.toLowerCase().includes(q));
      return inMain || hit ? { ...v, hit: !inMain && hit ? hit : null } : null;
    }).filter(Boolean);
  }
  if (ui.sort === "year") list.sort((a, b) => (a.year || 9999) - (b.year || 9999) || a.order - b.order);
  return list;
}
function peopleChips() {
  const counts = new Map();
  store.list("tags").forEach((t) => counts.set(t.name, (counts.get(t.name) || 0) + 1));
  const names = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "he"));
  if (!names.length) return "";
  return `<div class="chips" role="group" aria-label="סינון לפי מי בסרטון">
    <button class="chip" aria-pressed="${!ui.person}" data-person="">כולם</button>
    ${names.map(([n, c]) => `<button class="chip" aria-pressed="${ui.person === n}" data-person="${esc(n)}">${esc(n)} <span class="n">${c}</span></button>`).join("")}
  </div>`;
}
function card(v) {
  const img = thumbUrl(v);
  return `<a class="card" href="#/v/${encodeURIComponent(v.id)}">
    <div class="thumb ${img ? "" : "ph"}">${img ? `<img src="${img}" alt="" loading="lazy">` : ""}<div class="scan"></div>
      ${v.secs ? `<span class="dur">${fmt(v.secs)}</span>` : ""}${v.year ? `<span class="yr">${v.year}</span>` : ""}</div>
    <div class="body"><h3>${esc(v.title)}</h3>${v.desc ? `<p>${esc(v.desc)}</p>` : ""}
      ${v.hit ? `<div class="hit">★ ${fmt(v.hit.t)} ${esc(v.hit.text)}</div>` : ""}
      <div class="meta"><span>★ ${v.hlCount} רגעים</span><span>💬 ${v.cmCount}</span>${v.tags.length ? `<span>👤 ${v.tags.length}</span>` : ""}</div></div>
  </a>`;
}
function renderList(full) {
  const list = filtered();
  const listHtml = list.length ? list.map(card).join("") : `<div class="empty">${videos.length ? "לא נמצאו סרטונים. נסו מילה אחרת." : "לא הצלחנו לטעון את הסרטונים מיוטיוב. נסו לרענן."}</div>`;
  if (!full && $("#vlist")) {
    $("#chips").innerHTML = peopleChips();
    $("#vlist").innerHTML = listHtml;
    $("#count").textContent = countText(list);
    $("#topbar").innerHTML = topBar(brand());
    return;
  }
  app.innerHTML = `<div id="topbar">${topBar(brand())}</div>
  <main class="wrap">
    <div class="tools">
      <label class="search"><span aria-hidden="true">⌕</span><input id="q" type="search" placeholder="חיפוש: עוגה, כנרת, סבתא…" value="${esc(ui.q)}" aria-label="חיפוש"></label>
      <div class="seg" role="group" aria-label="מיון">
        <button data-sort="order" aria-pressed="${ui.sort === "order"}">סדר הפלייליסט</button>
        <button data-sort="year" aria-pressed="${ui.sort === "year"}">לפי שנה</button>
      </div>
    </div>
    <div id="chips">${peopleChips()}</div>
    <p class="count" id="count">${countText(list)}</p>
    <div class="grid" id="vlist">${listHtml}</div>
  </main>`;
  $("#q").addEventListener("input", (e) => { ui.q = e.target.value; renderList(false); });
}
const brand = () => `<a class="brand" href="#/">חסרה על הימין<span class="rec" aria-hidden="true"></span></a>`;
function countText(list) {
  if (!videos.length) return "";
  return list.length === videos.length ? `${videos.length} סרטונים` : `${list.length} מתוך ${videos.length} סרטונים`;
}

/* ---------- video page ---------- */
function curVideo() {
  const v = videos.find((x) => x.id === route.id);
  return v ? videoMerged(v) : null;
}
function renderVideoShell() {
  const v = curVideo();
  if (!v) { app.innerHTML = `<div id="topbar">${topBar(`<a class="back" href="#/">→ כל הסרטונים</a>`)}</div><div class="empty">הסרטון לא נמצא.</div>`; return; }
  app.innerHTML = `<div id="topbar"></div>
  <main class="wrap"><div class="vgrid">
    <div class="a-player"><div class="pbox">${v.demo ? `<div class="ph">▶ PLAY<br>${esc(v.title)}<br><small>נגן הדגמה</small></div>` : '<div id="yt"></div>'}</div>
      <div class="tl" id="tl" title="לחצו כדי לקפוץ"><div class="track"></div><div class="fill" id="tlfill"></div><div id="tlmarks"></div></div></div>
    <section class="sec a-info vinfo" id="s-info"></section>
    <section class="sec a-side" id="s-hl"></section>
    <section class="sec a-people" id="s-people"></section>
    <section class="sec a-cmts" id="s-cmts"></section>
  </div></main>`;
  if (!v.demo) createPlayer(v.id, route.t);
  startTick();
}
function renderVideoParts() {
  const v = curVideo();
  if (!v || !$("#s-info")) return;
  $("#topbar").innerHTML = topBar(`<a class="back" href="#/${ui.person ? "?p=" + encodeURIComponent(ui.person) : ""}">→ כל הסרטונים</a>`);
  keepInputs(() => {
    $("#s-info").innerHTML = infoHtml(v);
    $("#s-hl").innerHTML = hlHtml(v);
    $("#s-people").innerHTML = peopleHtml(v);
    $("#s-cmts").innerHTML = cmtsHtml(v);
    $("#tlmarks").innerHTML = store.list("highlights", v.id).map((h) =>
      `<span class="mk" style="left:${dur(v) ? Math.min(100, (h.t / dur(v)) * 100) : 0}%" data-seek="${h.t}" title="${esc(fmt(h.t) + " " + h.text)}"></span>`).join("");
  });
}
function dur(v) { return v.secs || (player?.getDuration?.() || 0); }

// שומר טקסט שהוקלד ופוקוס כשהנתונים מתעדכנים בזמן אמת
function keepInputs(fn) {
  const vals = {};
  document.querySelectorAll("[data-keep]").forEach((el) => (vals[el.id] = el.value));
  const a = document.activeElement, aid = a?.id, sel = a && "selectionStart" in a ? [a.selectionStart, a.selectionEnd] : null;
  fn();
  for (const [id, val] of Object.entries(vals)) { const el = document.getElementById(id); if (el && val) el.value = val; }
  if (aid) { const el = document.getElementById(aid); if (el) { el.focus(); if (sel) try { el.setSelectionRange(...sel); } catch {} } }
}

function infoHtml(v) {
  if (editVideo && store.isAdmin) {
    return `<form id="f-video" class="addhl" style="background:none;padding:0;margin:0">
      <label class="hint">שם הסרטון<input class="field" name="title" value="${esc(v.title)}" required></label>
      <label class="hint">שנה<input class="field" name="year" inputmode="numeric" value="${esc(v.year || "")}" style="max-width:120px"></label>
      <label class="hint">תיאור<textarea class="field" name="desc">${esc(v.desc)}</textarea></label>
      <div class="row"><button class="btn primary">שמירה</button><button type="button" class="btn ghost" data-act="cancel-video">ביטול</button></div>
    </form>`;
  }
  const long = v.desc.length > 220 || v.desc.split("\n").length > 4;
  return `<h2>${esc(v.title)}</h2>
    <div class="meta" style="margin-top:6px">${v.year ? `<span>${v.year}</span>` : ""}${v.secs ? `<span>${fmt(v.secs)}</span>` : ""}
      ${v.demo ? "" : `<a href="https://www.youtube.com/watch?v=${esc(v.id)}" target="_blank" rel="noopener">פתיחה ביוטיוב</a>`}
      ${store.isAdmin ? `<button class="linkbtn" data-act="edit-video">✎ עריכת שם ותיאור</button>` : ""}</div>
    ${v.desc ? `<p class="desc ${long && !descOpen ? "clamp" : ""}">${richify(v.desc)}</p>${long ? `<button class="linkbtn" data-act="toggle-desc">${descOpen ? "פחות" : "עוד"}</button>` : ""}` : ""}`;
}
function itemActions(coll, item) {
  if (!store.canEdit(item)) return "";
  return `<span class="acts"><button class="icon" data-act="edit" data-coll="${coll}" data-id="${item.id}" aria-label="עריכה" title="עריכה">✎</button><button class="icon" data-act="del" data-coll="${coll}" data-id="${item.id}" aria-label="מחיקה" title="מחיקה">🗑</button></span>`;
}
function hlHtml(v) {
  const hs = store.list("highlights", v.id).sort((a, b) => a.t - b.t);
  const form = marking ? `<form class="addhl" id="f-hl">
      <div class="row"><button type="button" class="btn" data-act="nudge" data-d="-5">‎−5 שנ׳</button>
        <input class="tin" id="hl-t" data-keep value="${fmt(marking.t)}" aria-label="זמן" inputmode="numeric">
        <button type="button" class="btn" data-act="nudge" data-d="5">‎+5 שנ׳</button></div>
      <input class="field" id="hl-text" data-keep placeholder="מה רואים כאן?" maxlength="200" autocomplete="off">
      <div class="row"><button class="btn primary">שמירה</button><button type="button" class="btn ghost" data-act="cancel-mark">ביטול</button></div>
    </form>` : "";
  return `<div class="sec-h"><h3>רגעים בסרטון</h3>${marking ? "" : `<button class="btn primary" data-act="mark">＋ סמן רגע</button>`}</div>
    ${form}
    <ul class="hl-list" id="hl-list">${hs.map((h) => {
      if (editing?.id === h.id) return `<li><form class="addhl" id="f-edit" data-coll="highlights" data-id="${h.id}" style="flex:1">
        <div class="row"><input class="tin" name="t" value="${fmt(h.t)}" aria-label="זמן"></div>
        <input class="field" name="text" value="${esc(h.text)}" maxlength="200">
        <div class="row"><button class="btn primary">שמירה</button><button type="button" class="btn ghost" data-act="cancel-edit">ביטול</button></div></form></li>`;
      return `<li class="hl" data-t="${h.t}"><button class="go" data-seek="${h.t}"><span class="t">${fmt(h.t)}</span><span class="d">${esc(h.text)}<span class="by">${esc(h.authorName || "")}</span></span></button>${itemActions("highlights", h)}</li>`;
    }).join("") || `<li class="hint" style="padding:6px 2px">עוד אין רגעים. לחצו "סמן רגע" בזמן הצפייה.</li>`}</ul>`;
}
function peopleHtml(v) {
  const tags = store.list("tags", v.id).sort((a, b) => a.name.localeCompare(b.name, "he"));
  const names = knownNames().filter((n) => !tags.some((t) => t.name === n));
  return `<div class="sec-h"><h3>מי בסרטון</h3></div>
  <div class="people">${tags.map((t) => `<span class="person"><a href="#/?p=${encodeURIComponent(t.name)}" style="display:inline-flex;align-items:center;gap:6px;color:inherit;text-decoration:none" title="כל הסרטונים של ${esc(t.name)}">${av(t.name)}${esc(t.name)}</a>${store.canEdit(t) ? `<button class="x" data-act="del" data-coll="tags" data-id="${t.id}" aria-label="הסרת התיוג של ${esc(t.name)}">×</button>` : ""}</span>`).join("")}
    <form class="tagadd" id="f-tag"><input id="tag-in" data-keep list="names" placeholder="＋ תיוג מישהו" maxlength="40" autocomplete="off" aria-label="שם לתיוג"></form>
    <datalist id="names">${names.map((n) => `<option value="${esc(n)}">`).join("")}</datalist>
  </div>`;
}
function cmtsHtml(v) {
  const cs = store.list("comments", v.id).sort((a, b) => tsMillis(a.createdAt) - tsMillis(b.createdAt));
  return `<div class="sec-h"><h3>תגובות</h3><span class="sub">${cs.length || ""}</span></div>
  <div class="cmts">${cs.map((c) => {
    if (editing?.id === c.id) return `<form class="addhl" id="f-edit" data-coll="comments" data-id="${c.id}"><textarea class="field" name="text" maxlength="2000">${esc(c.text)}</textarea>
      <div class="row"><button class="btn primary">שמירה</button><button type="button" class="btn ghost" data-act="cancel-edit">ביטול</button></div></form>`;
    return `<div class="cmt">${av(c.authorName)}<div><div class="h"><b>${esc(c.authorName || "")}</b> · ${ago(tsMillis(c.createdAt))}${c.edited ? " · נערך" : ""}</div><p>${richify(c.text)}</p></div>${itemActions("comments", c)}</div>`;
  }).join("") || `<p class="hint" style="margin:0">עוד אין תגובות. מה אתם זוכרים מהיום הזה?</p>`}</div>
  <form class="compose" id="f-cmt"><textarea id="cmt-in" data-keep rows="1" maxlength="2000" placeholder="כתבו תגובה… @ לתיוג, 3:12 לקישור לזמן"></textarea><button class="btn primary">שליחה</button></form>`;
}

/* ---------- player ---------- */
function createPlayer(id, start) {
  playerVid = id;
  window.ytReady.then((YT) => {
    if (playerVid !== id || !$("#yt")) return;
    player = new YT.Player("yt", {
      videoId: id,
      host: "https://www.youtube.com",
      playerVars: { rel: 0, playsinline: 1, modestbranding: 1, start: Math.floor(start || 0), hl: "iw" },
      events: {
        onReady: () => { if (pendingSeek != null) { seek(pendingSeek); pendingSeek = null; } renderVideoParts(); },
      },
    });
  });
}
function destroyPlayer() {
  clearInterval(tick); tick = null;
  try { player?.destroy?.(); } catch {}
  player = null; playerVid = null;
}
function curTime() { return player?.getCurrentTime ? player.getCurrentTime() : 0; }
function seek(t) {
  if (!player?.seekTo) { pendingSeek = t; return; }
  player.seekTo(t, true); player.playVideo();
  if (window.matchMedia("(max-width:999px)").matches) $(".pbox")?.scrollIntoView({ behavior: "smooth", block: "start" });
}
function startTick() {
  clearInterval(tick);
  tick = setInterval(() => {
    const v = curVideo(); if (!v) return;
    const d = dur(v), t = curTime();
    const fill = $("#tlfill"); if (fill && d) fill.style.width = Math.min(100, (t / d) * 100) + "%";
    const items = [...document.querySelectorAll("#hl-list .hl")];
    let on = null;
    items.forEach((li) => { if (+li.dataset.t <= t + 0.5) on = li; });
    items.forEach((li) => li.classList.toggle("on", li === on && t > 0));
  }, 500);
}

/* ---------- dialogs ---------- */
const dlg = $("#dlg");
let afterLogin = null;
function openLogin(then) {
  afterLogin = then || null;
  dlg.innerHTML = `<form method="dialog" id="f-login">
    <h2>חסרה על הימין</h2>
    <p class="lead">כדי לסמן רגעים, לתייג ולהגיב, ספרו לנו מי אתם. המכשיר יזכור אתכם.</p>
    <label>איך קוראים לך?<input class="field" name="name" required maxlength="40" autocomplete="name" placeholder="למשל: דודה רותי"></label>
    <label>מספר טלפון<input class="field" name="phone" required inputmode="tel" autocomplete="tel" dir="ltr" style="text-align:right" placeholder="050-0000000"></label>
    <p class="small">המספר משמש רק כדי לזהות אותך גם ממכשיר אחר. הוא לא מוצג לאף אחד ולא נשלחות אליו הודעות.</p>
    <p class="err" id="login-err"></p>
    <div class="acts"><button class="btn primary" style="flex:1;justify-content:center;padding:11px">כניסה</button><button type="button" class="btn ghost" data-act="close">רק לצפות</button></div>
  </form>`;
  dlg.showModal();
  setTimeout(() => dlg.querySelector("[name=name]").focus(), 50);
}
function openMenu() {
  const u = store.user;
  dlg.innerHTML = `<form method="dialog">
    <div style="text-align:center">${av(u?.name)}</div>
    <h2>${esc(u?.name || "")}</h2>
    ${store.isAdmin ? `<p class="lead">מחובר כמנהל${store.adminEmail ? " (" + esc(store.adminEmail) + ")" : ""}</p>` : ""}
    <div class="acts" style="flex-direction:column">
      ${store.isAdmin ? "" : `<button type="button" class="btn" data-act="admin">כניסת מנהל עם גוגל</button>`}
      <button type="button" class="btn" data-act="logout">יציאה</button>
      <button type="button" class="btn ghost" data-act="close">סגירה</button>
    </div>
    <p class="err" id="menu-err"></p>
  </form>`;
  dlg.showModal();
}
function requireLogin(fn) { if (store.user) fn(); else openLogin(fn); }

/* ---------- events ---------- */
document.addEventListener("click", async (e) => {
  const seekEl = e.target.closest("[data-seek]");
  if (seekEl) { e.preventDefault(); seek(+seekEl.dataset.seek); return; }
  const tl = e.target.closest("#tl");
  if (tl) { const r = tl.getBoundingClientRect(); const v = curVideo(); const d = v && dur(v); if (d) seek(((e.clientX - r.left) / r.width) * d); return; }
  const p = e.target.closest("[data-person]");
  if (p) { const n = p.dataset.person; location.hash = n ? "#/?p=" + encodeURIComponent(n) : "#/"; return; }
  const s = e.target.closest("[data-sort]");
  if (s) { ui.sort = s.dataset.sort; renderList(true); return; }
  const a = e.target.closest("[data-act]");
  if (!a) return;
  const act = a.dataset.act;
  try {
    if (act === "login") openLogin();
    else if (act === "menu") openMenu();
    else if (act === "close") dlg.close();
    else if (act === "logout") { await store.logout(); dlg.close(); toast("יצאת מהחשבון"); }
    else if (act === "admin") {
      const r = await store.adminLogin();
      if (r.ok) { dlg.close(); toast(r.claimed ? "נרשמת כמנהל האתר" : "מחובר כמנהל"); }
      else if (r.reason === "not-admin") $("#menu-err").textContent = `החשבון ${r.email} אינו מנהל.`;
    }
    else if (act === "mark") requireLogin(() => {
      player?.pauseVideo?.();
      marking = { t: Math.floor(curTime()) };
      editing = null;
      renderVideoParts();
      $("#hl-text")?.focus();
    });
    else if (act === "cancel-mark") { marking = null; renderVideoParts(); }
    else if (act === "nudge") {
      const inp = $("#hl-t"); const t = Math.max(0, (parseT(inp.value) ?? marking.t) + +a.dataset.d);
      marking.t = t; inp.value = fmt(t); if (player?.seekTo) player.seekTo(t, true);
    }
    else if (act === "edit") { editing = { coll: a.dataset.coll, id: a.dataset.id }; marking = null; renderVideoParts(); }
    else if (act === "cancel-edit") { editing = null; renderVideoParts(); }
    else if (act === "del") {
      const label = { highlights: "את הרגע", comments: "את התגובה", tags: "את התיוג" }[a.dataset.coll];
      if (a.dataset.coll === "tags" || confirm(`למחוק ${label}?`)) { await store.remove(a.dataset.coll, a.dataset.id); }
    }
    else if (act === "edit-video") { editVideo = true; renderVideoParts(); }
    else if (act === "cancel-video") { editVideo = false; renderVideoParts(); }
    else if (act === "toggle-desc") { descOpen = !descOpen; renderVideoParts(); }
  } catch (err) {
    console.error(err);
    const msg = authErr(err);
    const box = $("#menu-err");
    if (act === "admin" && box) box.textContent = msg; else toast(msg);
  }
});

function authErr(err) {
  const c = err?.code || "";
  const map = {
    "auth/unauthorized-domain": "הדומיין של האתר לא מאושר ב־Firebase (Authentication › Settings › Authorized domains).",
    "auth/operation-not-allowed": "כניסה עם גוגל לא מופעלת ב־Firebase (Authentication › Sign-in method).",
    "auth/popup-blocked": "הדפדפן חסם את החלון הקופץ. אפשרו חלונות קופצים לאתר ונסו שוב.",
    "auth/network-request-failed": "בעיית רשת. נסו שוב.",
    "permission-denied": "אין הרשאה במסד הנתונים. ודאו שכללי האבטחה (Rules) פורסמו.",
  };
  return (map[c] || "משהו השתבש. נסו שוב.") + (c ? ` [${c}]` : err?.message ? ` [${String(err.message).slice(0, 80)}]` : "");
}

document.addEventListener("submit", async (e) => {
  const f = e.target;
  if (f.id === "f-login") {
    e.preventDefault();
    const name = f.name.value.trim().replace(/\s+/g, " ");
    const phone = normPhone(f.phone.value);
    if (!name) return;
    if (phone.length < 9 || phone.length > 10) { $("#login-err").textContent = "מספר הטלפון לא נראה תקין"; return; }
    try {
      const u = await store.login(name, phone);
      dlg.close();
      toast(`שלום ${u.name}!`);
      const fn = afterLogin; afterLogin = null; fn?.();
    } catch (err) { console.error(err); $("#login-err").textContent = "הכניסה נכשלה. " + authErr(err); }
    return;
  }
  if (!["f-hl", "f-cmt", "f-tag", "f-edit", "f-video"].includes(f.id)) return;
  e.preventDefault();
  const v = curVideo(); if (!v) return;
  try {
    if (f.id === "f-hl") {
      const text = $("#hl-text").value.trim(); if (!text) return;
      const t = parseT($("#hl-t").value) ?? marking.t;
      await store.add("highlights", { videoId: v.id, t: Math.max(0, Math.round(t)), text });
      marking = null; $("#hl-text").value = ""; renderVideoParts(); toast("הרגע נשמר");
    } else if (f.id === "f-cmt") {
      const inp = $("#cmt-in"); const text = inp.value.trim(); if (!text) return;
      requireLogin(async () => {
        await store.add("comments", { videoId: v.id, text });
        const i = $("#cmt-in"); if (i) { i.value = ""; i.style.height = ""; }
        renderVideoParts();
      });
    } else if (f.id === "f-tag") {
      const inp = $("#tag-in"); const name = inp.value.trim().replace(/\s+/g, " "); if (!name) return;
      requireLogin(async () => {
        if (store.list("tags", v.id).some((t) => t.name === name)) { toast(`${name} כבר מתויג`); }
        else await store.add("tags", { videoId: v.id, name });
        const i = $("#tag-in"); if (i) i.value = "";
        renderVideoParts();
        $("#tag-in")?.focus();
      });
    } else if (f.id === "f-edit") {
      const coll = f.dataset.coll, id = f.dataset.id;
      const patch = { text: f.text.value.trim(), edited: true };
      if (!patch.text) return;
      if (coll === "highlights") { const t = parseT(f.t.value); if (t != null) patch.t = Math.max(0, Math.round(t)); }
      await store.update(coll, id, patch);
      editing = null; renderVideoParts();
    } else if (f.id === "f-video") {
      const year = parseInt(f.year.value, 10);
      await store.update("videoEdits", v.id, { title: f.title.value.trim(), desc: f.desc.value.trim(), year: year >= 1900 && year < 2100 ? year : null });
      editVideo = false; renderVideoParts(); toast("נשמר");
    }
  } catch (err) { console.error(err); toast("השמירה נכשלה. " + authErr(err)); }
});

// Enter שולח תגובה, Shift+Enter שורה חדשה; הגדלת תיבת התגובה
document.addEventListener("keydown", (e) => {
  if (e.target.id === "cmt-in" && e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); e.target.form.requestSubmit(); }
});
document.addEventListener("input", (e) => {
  if (e.target.id === "cmt-in") { e.target.style.height = "auto"; e.target.style.height = Math.min(160, e.target.scrollHeight) + "px"; }
});

/* ---------- start ---------- */
let renderQueued = false;
store.onChange(() => {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    if (route.name === "list") renderList(false); else renderVideoParts();
  });
});

(async function main() {
  try { await store.init(); } catch (e) { console.error(e); toast("אין חיבור למסד הנתונים. " + authErr(e)); }
  videos = await loadVideos();
  route = { name: "none" };
  onRoute();
})();
