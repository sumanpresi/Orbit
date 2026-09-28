# Orbit — link reminders

Save any link, rename it inline, tap the bell beside its name, and choose when it should come back to you:
every N minutes, hourly, daily, weekly, monthly or yearly — with optional quiet hours and a note.
Push notifications arrive on your Galaxy Z Fold 8 (and any other device you enable),
one per link with a running count, and tapping one opens the link straight in its own app.

```
GitHub Pages (the app)  ──►  Supabase (your data + login, synced live)
                                   │  every minute, pg_cron → send-due function
                                   ▼
                           Web Push  ──►  Z Fold 8 / any device
```

Hosting: `https://sumanpresi.github.io/orbit/` · Backend: your existing **Notewire** Supabase project (all tables are prefixed `orbit_`, so nothing clashes).

---

## Step 1 — Supabase (≈10 min)

1. **Anon key**: Supabase → *Project Settings → API* → copy the `anon public` key into `config.js` (`SUPABASE_ANON_KEY`).
2. **Database**: *SQL Editor → New query* → paste all of `supabase/schema.sql` → **Run**.
   This creates the tables, security rules, live sync, and the once-a-minute scheduler.
3. **Edge function**: *Edge Functions → Deploy a new function → Via editor*
   - Name: `send-due`
   - Paste the whole of `supabase/functions/send-due/index.ts`, deploy.
   - Open the function's settings and **turn OFF JWT verification** ("Verify JWT" / "Enforce JWT") (the function checks its own secret).
4. **Secrets**: *Edge Functions → Secrets* → add the four values from `SECRETS-do-not-commit.txt`.
5. **Login redirect**: *Authentication → URL Configuration* → add `https://sumanpresi.github.io/orbit/` to **Redirect URLs**.
   Google sign-in is already enabled on this project for Notewire, so it works here too. Email magic-link works as a fallback.

## Step 2 — GitHub Pages (≈3 min)

1. Create a repo named **`orbit`** under `sumanpresi`.
2. Upload everything in this folder **except** `SECRETS-do-not-commit.txt`.
3. *Settings → Pages →* Source: **Deploy from a branch**, branch `main`, folder `/ (root)`.
4. Wait a minute, then open `https://sumanpresi.github.io/orbit/`.

## Step 3 — Install on the Z Fold 8

1. Open the URL in **Chrome** → ⋮ → **Add to home screen → Install**.
2. Open Orbit from the home screen, sign in with Google.
3. Tap **Enable alerts** (top right) → Allow.
4. Samsung-specific, so reminders are never delayed:
   *Settings → Apps → Orbit → Battery →* **Unrestricted**, and make sure *Notifications* are on.
5. Add a link → tap its bell → pick a schedule → **Send test**. You should get a notification within seconds.

Repeat step 3 on any other phone/tablet/PC and it will receive the same reminders; links sync live between them.

---

## How it behaves

| You asked for | How Orbit does it |
|---|---|
| Many links, editable names | Unlimited. Tap a name to rename it in place; ⋮ to edit the URL or delete. |
| Bell beside each name | Opens the schedule sheet: Minute / Hourly / Daily / Weekly / Monthly / Yearly, "every N", time, day, month, weekdays, quiet hours, note, and a live preview of the next 5 reminders. |
| Tap notification → default app | Docs, Sheets, Slides, Drive, YouTube, Maps, Gmail, Calendar, Keep, Photos, Meet, WhatsApp, GitHub, Notion, LinkedIn, Instagram, X and Spotify links hand off to their Android app; anything else opens normally (Android offers its app if one claims the link). |
| Grouped per URL, clutter-free | Each link owns **one** notification. A new reminder replaces it and updates the count — "Weekly report · 3" — instead of stacking. Cards show "3 unseen" until you open the link. |
| Sync across devices | Supabase login + realtime: edits appear on every signed-in device instantly. |

**Honest limits of web apps on Android**

- Android puts all of Orbit's notifications under the Orbit app icon; a web app can't create separate Android notification *channels* per link. The one-notification-per-link-with-count design is how Orbit keeps them sorted and uncluttered instead.
- Opening in the native app works through an Android "intent". Occasionally Chrome asks for one extra tap — Orbit then shows a big **Open in Docs** (etc.) button.
- The scheduler ticks once a minute, so reminders land within about a minute of the set time. "Every 1 minute" works but is noisy; the sheet warns you.
- Monthly on the 31st falls back to the last day in shorter months; 29 Feb falls back to 28 Feb in non-leap years.

## Files

```
index.html, styles.css, app.js   the app
schedule-core.js                 scheduling engine (an inlined copy lives in the edge function — keep in sync)
applink.js                       URL → native Android app routing
sw.js                            service worker: offline, push display, per-link grouping, tap handling
open.html                        notification landing page: marks as seen, hands off to the app
manifest.webmanifest, icons/     install metadata
config.js                        public settings (anon key, VAPID public key)
supabase/schema.sql              tables, security, realtime, cron
supabase/functions/send-due/     sends due reminders + "Send test"
```
