// Orbit service worker — offline shell, push display, per-link grouping, tap-to-open.
const VERSION = "orbit-v1";
const SHELL = ["./", "index.html", "styles.css", "app.js", "config.js", "schedule-core.js", "applink.js",
  "open.html", "manifest.webmanifest", "icons/icon-192.png", "icons/badge-96.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Network-first for our own files (so updates land), cache fallback when offline.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request).then((r) => {
      const copy = r.clone();
      caches.open(VERSION).then((c) => c.put(e.request, copy));
      return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match("index.html")))
  );
});

// ── Push ─────────────────────────────────────────────────────────────
// One notification per link (tag = link id). A new reminder for the same link
// REPLACES the old one and shows the running count, so the shade never fills
// up with duplicates: "Weekly report · 3 reminders".
self.addEventListener("push", (e) => {
  let p = {};
  try { p = e.data ? e.data.json() : {}; } catch { p = { title: "Orbit", body: e.data && e.data.text() }; }
  const count = p.count || 1;
  const title = count > 1 ? `${p.name} · ${count}` : p.name || "Orbit";
  const body = [p.message, count > 1 ? `${count} reminders waiting · tap to open` : `Tap to open ${p.host || ""}`]
    .filter(Boolean).join("\n");

  e.waitUntil((async () => {
    await self.registration.showNotification(title, {
      body,
      tag: "orbit-" + (p.linkId || "general"),
      renotify: true,               // buzz again even though it replaces the old one
      icon: "icons/icon-192.png",
      badge: "icons/badge-96.png",
      timestamp: p.ts || Date.now(),
      data: { url: p.url, linkId: p.linkId },
      actions: [{ action: "open", title: "Open" }, { action: "dismiss", title: "Dismiss" }],
    });
    if (self.navigator.setAppBadge) {
      const all = await self.registration.getNotifications();
      self.navigator.setAppBadge(all.length).catch(() => {});
    }
  })());
});

self.addEventListener("notificationclick", (e) => {
  const n = e.notification;
  const { url, linkId } = n.data || {};
  n.close();
  e.waitUntil((async () => {
    const rest = await self.registration.getNotifications();
    if (self.navigator.setAppBadge) (rest.length ? self.navigator.setAppBadge(rest.length) : self.navigator.clearAppBadge()).catch(() => {});
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    wins.forEach((w) => w.postMessage({ type: "opened", linkId }));
    // open.html marks the reminders as seen and hands the URL to the right Android app
    const target = new URL(`open.html?id=${encodeURIComponent(linkId || "")}&dismiss=${e.action === "dismiss" ? 1 : 0}&u=${encodeURIComponent(url || "")}`, self.registration.scope).href;
    if (e.action === "dismiss") {
      // Reset the count without opening anything visible: reuse an open window if there is one
      if (wins[0]) return wins[0].postMessage({ type: "reset", linkId });
      return self.clients.openWindow(target);
    }
    return self.clients.openWindow(target);
  })());
});

// If the browser rotates the push subscription, tell any open page to re-register it.
self.addEventListener("pushsubscriptionchange", (e) => {
  e.waitUntil(self.clients.matchAll({ type: "window" }).then((ws) => ws.forEach((w) => w.postMessage({ type: "resubscribe" }))));
});
