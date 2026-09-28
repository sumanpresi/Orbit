import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { DateTime } from "https://cdn.jsdelivr.net/npm/luxon@3/+esm";
import { nextRun, describe } from "./schedule-core.js";
import { normalizeUrl, appFor, intentUrl, hostOf } from "./applink.js";

const CFG = window.ORBIT_CONFIG || {};
const sb = createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const CACHE = "orbit.links.v1";

const state = { user: null, links: [], filter: "", editing: null, sched: null, swReg: null, channel: null };

// ── Boot ────────────────────────────────────────────────────────────
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").then((r) => { state.swReg = r; refreshPushUi(); });
}

sb.auth.onAuthStateChange((_e, session) => setUser(session?.user || null));
sb.auth.getSession().then(({ data }) => setUser(data.session?.user || null));

function setUser(user) {
  const changed = user?.id !== state.user?.id;
  state.user = user;
  $("#auth").hidden = !!user;
  $("#app").hidden = !user;
  if (!user) { state.channel?.unsubscribe(); state.channel = null; return; }
  if (!changed) return;
  const meta = user.user_metadata || {};
  $("#avatar").innerHTML = meta.avatar_url ? `<img src="${esc(meta.avatar_url)}" alt="" referrerpolicy="no-referrer">` : esc((user.email || "?")[0].toUpperCase());
  $("#m-email").textContent = user.email || "";
  try { state.links = JSON.parse(localStorage.getItem(CACHE + user.id) || "[]"); } catch { state.links = []; }
  render();
  load();
  subscribeRealtime();
  refreshPushUi();
}

// ── Auth UI ─────────────────────────────────────────────────────────
const home = () => location.origin + location.pathname.replace(/[^/]*$/, "");
$("#btn-google").onclick = () => sb.auth.signInWithOAuth({ provider: "google", options: { redirectTo: home() } });
$("#form-email").onsubmit = async (e) => {
  e.preventDefault();
  const { error } = await sb.auth.signInWithOtp({ email: $("#email").value.trim(), options: { emailRedirectTo: home() } });
  $("#auth-msg").textContent = error ? error.message : "Check your inbox for the sign-in link.";
};
$("#btn-menu").onclick = () => openSheet("#sheet-menu");
$("#m-signout").onclick = async () => { closeSheets(); await sb.auth.signOut(); };
$("#m-devices").onclick = () => togglePush();

// ── Data ────────────────────────────────────────────────────────────
async function load() {
  setSync("busy");
  const { data, error } = await sb.from("orbit_links").select("*").order("position").order("created_at");
  if (error) { setSync("off", "Offline"); return; }
  state.links = data;
  persist(); render(); setSync("ok");
}

function subscribeRealtime() {
  state.channel?.unsubscribe();
  state.channel = sb.channel("orbit-" + state.user.id)
    .on("postgres_changes", { event: "*", schema: "public", table: "orbit_links", filter: `user_id=eq.${state.user.id}` }, (p) => {
      if (p.eventType === "DELETE") state.links = state.links.filter((l) => l.id !== p.old.id);
      else {
        const i = state.links.findIndex((l) => l.id === p.new.id);
        if (i >= 0) state.links[i] = p.new; else state.links.push(p.new);
      }
      persist(); render();
    })
    .subscribe((s) => setSync(s === "SUBSCRIBED" ? "ok" : "busy"));
}

function persist() { try { localStorage.setItem(CACHE + state.user.id, JSON.stringify(state.links)); } catch {} }

async function upsertLink(patch) {
  setSync("busy");
  const { data, error } = patch.id
    ? await sb.from("orbit_links").update(patch).eq("id", patch.id).select().single()
    : await sb.from("orbit_links").insert(patch).select().single();
  if (error) { toast(error.message); setSync("off", "Sync error"); return null; }
  const i = state.links.findIndex((l) => l.id === data.id);
  if (i >= 0) state.links[i] = data; else state.links.push(data);
  persist(); render(); setSync("ok");
  return data;
}

function setSync(kind, text) {
  $("#sync-dot").className = "dot " + (kind === "ok" ? "ok" : kind === "off" ? "off" : "");
  $("#sync-text").textContent = text || (kind === "ok" ? "Synced" : "Syncing…");
}
window.addEventListener("online", load);
window.addEventListener("offline", () => setSync("off", "Offline"));
document.addEventListener("visibilitychange", () => { if (!document.hidden && state.user) load(); });

// ── Render ──────────────────────────────────────────────────────────
const ICON = {
  bell: '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M12 22a2.5 2.5 0 0 0 2.5-2.5h-5A2.5 2.5 0 0 0 12 22zm7-6V11a7 7 0 0 0-5.5-6.8V3.5a1.5 1.5 0 0 0-3 0v.7A7 7 0 0 0 5 11v5l-2 2v1h18v-1l-2-2z"/></svg>',
  open: '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M14 3h7v7h-2V6.4l-9.3 9.3-1.4-1.4L17.6 5H14V3zM5 5h6v2H5v12h12v-6h2v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z"/></svg>',
  more: '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M12 7a2 2 0 1 1 0-4 2 2 0 0 1 0 4zm0 7a2 2 0 1 1 0-4 2 2 0 0 1 0 4zm0 7a2 2 0 1 1 0-4 2 2 0 0 1 0 4z"/></svg>',
  pen: '<svg viewBox="0 0 24 24" width="15" height="15"><path fill="currentColor" d="M3 17.2V21h3.8l11-11-3.8-3.8-11 11zM20.7 7a1 1 0 0 0 0-1.4l-2.3-2.3a1 1 0 0 0-1.4 0l-1.8 1.8 3.8 3.8L20.7 7z"/></svg>',
};

function render() {
  const q = state.filter.toLowerCase();
  const items = state.links.filter((l) => !q || l.name.toLowerCase().includes(q) || l.url.toLowerCase().includes(q));
  $("#empty").hidden = state.links.length > 0;
  const active = state.links.filter((l) => l.schedule?.enabled).length;
  const pending = state.links.reduce((a, l) => a + (l.pending_count || 0), 0);
  $("#stats").innerHTML = `<span><b>${state.links.length}</b> links</span><span><b>${active}</b> scheduled</span>${pending ? `<span><b>${pending}</b> unseen</span>` : ""}`;

  $("#list").innerHTML = items.map((l) => {
    const on = !!l.schedule?.enabled;
    const next = on && l.next_run_at ? DateTime.fromISO(l.next_run_at).setZone(TZ).toRelative() : "";
    const app = appFor(l.url);
    return `
    <article class="card glass" data-id="${l.id}">
      <div class="fav"><img src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostOf(l.url))}&sz=64" alt="" loading="lazy" onerror="this.remove()"></div>
      <div class="meta">
        <div class="name">
          <span class="name-text" data-act="rename">${esc(l.name)}</span>
          <button class="edit-btn" data-act="rename" aria-label="Rename">${ICON.pen}</button>
          <button class="act bell ${on ? "on" : ""}" data-act="sched" aria-label="Schedule reminder" title="Schedule reminder">${ICON.bell}</button>
        </div>
        <div class="url">${esc(app ? app.app + " · " : "")}${esc(hostOf(l.url))}</div>
        <div class="when">
          <span class="pill ${on ? "live" : ""}">${esc(describe(l.schedule))}</span>
          ${next ? `<span class="pill">next ${esc(next)}</span>` : ""}
          ${l.pending_count ? `<span class="pill count">${l.pending_count} unseen</span>` : ""}
        </div>
      </div>
      <div class="actions">
        <button class="act" data-act="open" aria-label="Open">${ICON.open}</button>
        <button class="act" data-act="edit" aria-label="More">${ICON.more}</button>
      </div>
    </article>`;
  }).join("");
}

$("#search").oninput = (e) => { state.filter = e.target.value; render(); };

$("#list").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-act]");
  const card = e.target.closest(".card");
  if (!btn || !card) return;
  const link = state.links.find((l) => l.id === card.dataset.id);
  const act = btn.dataset.act;
  if (act === "open") openLink(link);
  else if (act === "edit") openLinkSheet(link);
  else if (act === "sched") openSchedSheet(link);
  else if (act === "rename") startRename(card, link);
});

// Inline rename: tap the name (or pencil), type, Enter to save / Esc to cancel
function startRename(card, link) {
  const el = $(".name-text", card);
  if (el.isContentEditable) return;
  el.contentEditable = "true";
  el.focus();
  document.getSelection().selectAllChildren(el);
  const finish = async (save) => {
    el.contentEditable = "false";
    el.removeEventListener("keydown", onKey);
    const name = el.textContent.trim().slice(0, 80);
    if (save && name && name !== link.name) await upsertLink({ id: link.id, name });
    else el.textContent = link.name;
  };
  const onKey = (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); el.blur(); }
    if (ev.key === "Escape") { el.textContent = link.name; el.blur(); }
  };
  el.addEventListener("keydown", onKey);
  el.addEventListener("blur", () => finish(true), { once: true });
}

function openLink(link) {
  if (link.pending_count) upsertLink({ id: link.id, pending_count: 0 });
  const target = intentUrl(link.url);
  if (target.startsWith("intent:")) location.href = target;
  else window.open(link.url, "_blank", "noopener");
}

// ── Add / edit sheet ────────────────────────────────────────────────
$("#fab").onclick = () => openLinkSheet(null);

function openLinkSheet(link) {
  state.editing = link;
  $("#link-title").textContent = link ? "Edit link" : "Add link";
  $("#f-name").value = link?.name || "";
  $("#f-url").value = link?.url || "";
  $("#btn-delete").hidden = !link;
  hint();
  openSheet("#sheet-link");
  setTimeout(() => (link ? $("#f-url") : $("#f-name")).focus(), 250);
}
function hint() {
  const a = appFor(normalizeUrl($("#f-url").value));
  $("#f-app-hint").textContent = a ? `Opens in ${a.app}` : "";
}
$("#f-url").oninput = hint;
$("#f-url").onblur = () => {
  if (!$("#f-name").value.trim() && $("#f-url").value.trim()) $("#f-name").value = hostOf(normalizeUrl($("#f-url").value));
};

$("#form-link").onsubmit = async (e) => {
  e.preventDefault();
  const url = normalizeUrl($("#f-url").value);
  try { new URL(url); } catch { return toast("That URL doesn't look right"); }
  const patch = { name: $("#f-name").value.trim(), url };
  if (state.editing) patch.id = state.editing.id;
  else patch.position = state.links.length;
  const saved = await upsertLink(patch);
  if (saved) { closeSheets(); if (!state.editing) toast("Added — tap the bell to schedule it"); }
};

$("#btn-delete").onclick = async () => {
  const l = state.editing;
  if (!l || !confirm(`Delete “${l.name}”?`)) return;
  const { error } = await sb.from("orbit_links").delete().eq("id", l.id);
  if (error) return toast(error.message);
  state.links = state.links.filter((x) => x.id !== l.id);
  persist(); render(); closeSheets();
};

// ── Schedule sheet ──────────────────────────────────────────────────
const UNIT = { minute: "minute", hourly: "hour", daily: "day", weekly: "week", monthly: "month", yearly: "year" };
const SHOW = {
  minute: ["every"], hourly: ["every", "minute"], daily: ["every", "time"],
  weekly: ["every", "weekdays", "time"], monthly: ["every", "day", "time"], yearly: ["month", "day", "time"],
};

function openSchedSheet(link) {
  const now = DateTime.now().setZone(TZ);
  const s = link.schedule || {};
  state.sched = {
    link,
    enabled: s.enabled ?? true,
    freq: s.freq || "daily",
    every: s.every || 1,
    minute: s.minute ?? 0,
    weekdays: s.weekdays?.length ? [...s.weekdays] : [now.weekday],
    day: s.day || now.day,
    month: s.month || now.month,
    at_time: s.at_time || "09:00",
    message: s.message || "",
    quiet: s.quiet || null,
    anchor: s.anchor,
  };
  $("#s-for").textContent = link.name;
  syncSchedForm();
  openSheet("#sheet-sched");
}

function syncSchedForm() {
  const s = state.sched;
  $("#s-enabled").checked = s.enabled;
  $$("#s-freq button").forEach((b) => b.classList.toggle("on", b.dataset.f === s.freq));
  $("#s-every").value = s.every;
  $("#s-unit").textContent = UNIT[s.freq] + (s.every > 1 ? "s" : "");
  $("#s-minute").value = s.minute;
  $("#s-day").value = s.day;
  $("#s-month").value = s.month;
  $("#s-time").value = s.at_time;
  $("#s-msg").value = s.message;
  $("#s-q1").value = s.quiet?.start || "";
  $("#s-q2").value = s.quiet?.end || "";
  $$("#s-weekdays button").forEach((b) => b.classList.toggle("on", s.weekdays.includes(+b.dataset.d)));
  const show = SHOW[s.freq];
  for (const f of ["every", "minute", "weekdays", "month", "day", "time"]) $(".f-" + f).hidden = !show.includes(f);
  $(".fields").style.opacity = s.enabled ? 1 : 0.4;
  preview();
}

function readSchedForm() {
  const s = state.sched;
  s.enabled = $("#s-enabled").checked;
  s.every = Math.max(1, Math.min(999, parseInt($("#s-every").value) || 1));
  s.minute = Math.max(0, Math.min(59, parseInt($("#s-minute").value) || 0));
  s.day = Math.max(1, Math.min(31, parseInt($("#s-day").value) || 1));
  s.month = parseInt($("#s-month").value) || 1;
  s.at_time = $("#s-time").value || "09:00";
  s.message = $("#s-msg").value;
  const q1 = $("#s-q1").value, q2 = $("#s-q2").value;
  s.quiet = q1 && q2 ? { start: q1, end: q2 } : null;
}

function buildSchedule(anchorNow) {
  const s = state.sched;
  return {
    enabled: s.enabled, freq: s.freq, every: s.freq === "yearly" ? 1 : s.every,
    minute: s.minute, weekdays: s.weekdays, day: s.day, month: s.month, at_time: s.at_time,
    message: (s.message || "").trim(), quiet: s.quiet, tz: TZ,
    anchor: anchorNow ? new Date().toISOString() : s.anchor || new Date().toISOString(),
  };
}

function preview() {
  const sch = buildSchedule(true);
  const out = [];
  if (sch.enabled) {
    let t = new Date();
    for (let i = 0; i < 5; i++) {
      const n = nextRun(sch, t, DateTime);
      if (!n) break;
      out.push(DateTime.fromJSDate(n).setZone(TZ).toFormat("ccc dd LLL yyyy · HH:mm"));
      t = n;
    }
  }
  $("#s-preview").innerHTML = out.length ? out.map((x) => `<li>${x}</li>`).join("") : "<li>Off</li>";
  if (sch.enabled && sch.freq === "minute" && sch.every < 5)
    $("#s-preview").insertAdjacentHTML("beforeend", `<li class="muted">Heads-up: that's ${60 / sch.every} alerts an hour.</li>`);
}

$("#s-freq").onclick = (e) => {
  const b = e.target.closest("button"); if (!b) return;
  readSchedForm(); state.sched.freq = b.dataset.f; syncSchedForm();
};
$("#s-weekdays").onclick = (e) => {
  const b = e.target.closest("button"); if (!b) return;
  const d = +b.dataset.d, w = state.sched.weekdays;
  const i = w.indexOf(d);
  if (i >= 0) { if (w.length > 1) w.splice(i, 1); } else w.push(d);
  w.sort(); syncSchedForm();
};
$$(".stepper button").forEach((b) => (b.onclick = () => {
  readSchedForm(); state.sched.every = Math.max(1, state.sched.every + +b.dataset.step); syncSchedForm();
}));
$("#form-sched").addEventListener("input", () => { readSchedForm(); syncSchedForm(); });

$("#form-sched").onsubmit = async (e) => {
  e.preventDefault();
  readSchedForm();
  const schedule = buildSchedule(true);
  const next = nextRun(schedule, new Date(), DateTime);
  const saved = await upsertLink({ id: state.sched.link.id, schedule, next_run_at: next ? next.toISOString() : null });
  if (!saved) return;
  closeSheets();
  if (schedule.enabled) {
    toast(`Next: ${DateTime.fromJSDate(next).setZone(TZ).toFormat("ccc dd LLL, HH:mm")}`);
    if (Notification.permission !== "granted" || !(await currentSub())) setTimeout(() => togglePush(true), 600);
  } else toast("Reminder off");
};

$("#btn-test").onclick = async () => {
  if (!(await currentSub())) { await togglePush(true); if (!(await currentSub())) return; }
  const { data } = await sb.auth.getSession();
  const r = await fetch(`${CFG.SUPABASE_URL}/functions/v1/send-due?test=${state.sched.link.id}`, {
    method: "POST", headers: { Authorization: `Bearer ${data.session.access_token}`, apikey: CFG.SUPABASE_ANON_KEY },
  }).catch(() => null);
  toast(r?.ok ? "Test sent — check your notifications" : "Test failed — is the send-due function deployed?");
};

// ── Push ────────────────────────────────────────────────────────────
async function currentSub() {
  const reg = state.swReg || (await navigator.serviceWorker?.ready);
  return reg ? reg.pushManager.getSubscription() : null;
}

async function refreshPushUi() {
  const sub = await currentSub().catch(() => null);
  const on = !!sub && Notification.permission === "granted";
  $("#btn-push").classList.toggle("on", on);
  $("#push-label").textContent = on ? "Alerts on" : Notification.permission === "denied" ? "Alerts blocked" : "Enable alerts";
  $("#m-dev-state").textContent = on ? "receiving alerts (tap to stop)" : "not receiving alerts (tap to enable)";
}
$("#btn-push").onclick = () => togglePush();

async function togglePush(forceOn = false) {
  if (!("PushManager" in window)) return toast("Push isn't supported here. Install Orbit to your home screen first.");
  const reg = state.swReg || (await navigator.serviceWorker.ready);
  const existing = await reg.pushManager.getSubscription();
  if (existing && !forceOn) {
    await sb.from("orbit_push_subs").delete().eq("endpoint", existing.endpoint);
    await existing.unsubscribe();
    toast("Alerts off on this device");
    return refreshPushUi();
  }
  const perm = await Notification.requestPermission();
  if (perm !== "granted") { toast("Allow notifications in Android settings → Apps → Orbit"); return refreshPushUi(); }
  const sub = existing || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToU8(CFG.VAPID_PUBLIC_KEY) });
  const j = sub.toJSON();
  const { error } = await sb.from("orbit_push_subs").upsert(
    { endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, device: deviceName() },
    { onConflict: "endpoint" }
  );
  toast(error ? error.message : "Alerts on for this device");
  refreshPushUi();
}

function deviceName() {
  const ua = navigator.userAgent;
  const m = ua.match(/Android [\d.]+; ([^)]+)\)/);
  return (m ? m[1] : /Windows/.test(ua) ? "Windows" : /Mac/.test(ua) ? "Mac" : "Device").slice(0, 60);
}
function b64ToU8(b64) {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

// When a notification is tapped while the app is open, the SW tells us
navigator.serviceWorker?.addEventListener("message", (e) => {
  const l = state.links.find((x) => x.id === e.data?.linkId);
  if (e.data?.type === "opened" && l) { l.pending_count = 0; render(); }
  if (e.data?.type === "reset" && l) upsertLink({ id: l.id, pending_count: 0 });
  if (e.data?.type === "resubscribe" && Notification.permission === "granted") togglePush(true);
});

// ── Sheets & toast ──────────────────────────────────────────────────
function openSheet(sel) { closeSheets(); $(sel).hidden = false; }
function closeSheets() { $$(".sheet-wrap").forEach((s) => (s.hidden = true)); }
document.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) closeSheets(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheets(); });

let toastT;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.classList.add("show");
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), 2800);
}
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

// Shortcut from the manifest: ?action=add
if (new URLSearchParams(location.search).get("action") === "add") setTimeout(() => state.user && openLinkSheet(null), 500);
