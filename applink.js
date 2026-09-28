// Routes a URL to the right native Android app via an intent: URL.
// If the app isn't installed, Android falls back to the normal https link.

const RULES = [
  { test: /docs\.google\.com\/document/,     pkg: "com.google.android.apps.docs.editors.docs",   app: "Google Docs" },
  { test: /docs\.google\.com\/spreadsheets/, pkg: "com.google.android.apps.docs.editors.sheets", app: "Google Sheets" },
  { test: /docs\.google\.com\/presentation/, pkg: "com.google.android.apps.docs.editors.slides", app: "Google Slides" },
  { test: /docs\.google\.com\/forms|forms\.gle/, pkg: null, app: "Google Forms" },
  { test: /drive\.google\.com/,              pkg: "com.google.android.apps.docs",                app: "Google Drive" },
  { test: /(youtube\.com|youtu\.be)/,        pkg: "com.google.android.youtube",                  app: "YouTube" },
  { test: /(maps\.google\.|google\.[a-z.]+\/maps|maps\.app\.goo\.gl)/, pkg: "com.google.android.apps.maps", app: "Google Maps" },
  { test: /mail\.google\.com/,               pkg: "com.google.android.gm",                       app: "Gmail" },
  { test: /calendar\.google\.com/,           pkg: "com.google.android.calendar",                 app: "Google Calendar" },
  { test: /keep\.google\.com/,               pkg: "com.google.android.keep",                     app: "Google Keep" },
  { test: /photos\.google\.com|photos\.app\.goo\.gl/, pkg: "com.google.android.apps.photos",     app: "Google Photos" },
  { test: /meet\.google\.com/,               pkg: "com.google.android.apps.tachyon",             app: "Google Meet" },
  { test: /(wa\.me|api\.whatsapp\.com|chat\.whatsapp\.com)/, pkg: "com.whatsapp",                app: "WhatsApp" },
  { test: /(github\.com)/,                   pkg: "com.github.android",                          app: "GitHub" },
  { test: /(notion\.so|notion\.site)/,       pkg: "notion.id",                                   app: "Notion" },
  { test: /(linkedin\.com)/,                 pkg: "com.linkedin.android",                        app: "LinkedIn" },
  { test: /(instagram\.com)/,                pkg: "com.instagram.android",                       app: "Instagram" },
  { test: /(twitter\.com|x\.com)/,           pkg: "com.twitter.android",                         app: "X" },
  { test: /(open\.spotify\.com)/,            pkg: "com.spotify.music",                           app: "Spotify" },
  { test: /(sharepoint\.com|onedrive\.live\.com|1drv\.ms)/, pkg: null,                           app: "Microsoft 365" },
];

export function normalizeUrl(raw) {
  let u = String(raw || "").trim();
  if (!u) return "";
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = "https://" + u;
  return u;
}

export function appFor(url) {
  const r = RULES.find((r) => r.test.test(url));
  return r ? { app: r.app, pkg: r.pkg } : null;
}

/** Build an Android intent URL that opens `url` in the matching app, else the browser. */
export function intentUrl(url) {
  const r = appFor(url);
  const isAndroid = /Android/i.test(navigator.userAgent);
  if (!r || !r.pkg || !isAndroid || !/^https?:/i.test(url)) return url;
  const u = new URL(url);
  const scheme = u.protocol.replace(":", "");
  const rest = u.host + u.pathname + u.search; // a "#fragment" would break the intent syntax
  return `intent://${rest}#Intent;scheme=${scheme};package=${r.pkg};S.browser_fallback_url=${encodeURIComponent(url)};end`;
}

export function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}
