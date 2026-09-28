// @ts-nocheck
// Orbit · send-due
// Called every minute by pg_cron (header x-orbit-cron) — fires every reminder that is due.
// Also called by the app's "Send test" button (user JWT, ?test=<linkId>).
//
// Secrets (Supabase → Edge Functions → Secrets):
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:you@example.com), ORBIT_CRON_SECRET
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.

import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";
import { DateTime } from "npm:luxon@3";

const env = (k: string) => Deno.env.get(k) ?? "";
webpush.setVapidDetails(env("VAPID_SUBJECT") || "mailto:admin@example.com", env("VAPID_PUBLIC_KEY"), env("VAPID_PRIVATE_KEY"));
const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-orbit-cron",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });

type Link = {
  id: string; user_id: string; name: string; url: string;
  schedule: Record<string, unknown> | null; next_run_at: string | null; pending_count: number;
};

function hostOf(u: string) { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } }

async function pushToUser(userId: string, payloads: object[]) {
  const { data: subs } = await db.from("orbit_push_subs").select("*").eq("user_id", userId);
  let sent = 0;
  for (const s of subs ?? []) {
    for (const p of payloads) {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify(p),
          { TTL: 60 * 60 * 24, urgency: "high", topic: String((p as { linkId: string }).linkId).replace(/-/g, "").slice(0, 32) },
        );
        sent++;
      } catch (err) {
        const code = (err as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) { await db.from("orbit_push_subs").delete().eq("id", s.id); break; }
        console.error("push failed", code, (err as Error).message);
      }
    }
    await db.from("orbit_push_subs").update({ last_ok_at: new Date().toISOString() }).eq("id", s.id);
  }
  return sent;
}

function payload(l: Link, count: number) {
  return {
    linkId: l.id, name: l.name, url: l.url, host: hostOf(l.url), count,
    message: (l.schedule?.message as string) || "", ts: Date.now(),
  };
}

// ── Scheduling engine (same code the app uses for its preview) ──────
// Shared scheduling engine — used by the app (preview) AND the server (authoritative).
// Inlined copy of /schedule-core.js — keep the two in sync.
//
// schedule = {
//   enabled: true,
//   freq: "minute" | "hourly" | "daily" | "weekly" | "monthly" | "yearly",
//   every: 1,            // every N units
//   at_time: "09:00",    // daily / weekly / monthly / yearly
//   minute: 0,           // hourly: minute past the hour
//   weekdays: [1..7],    // weekly: ISO weekdays (1 = Mon)
//   day: 1,              // monthly / yearly: day of month (clamped to month length)
//   month: 1,            // yearly: 1-12
//   tz: "Asia/Kolkata",
//   anchor: ISO string,  // when the schedule was saved — the base for "every N"
//   quiet: { start: "23:00", end: "07:00" } | null,  // optional: skip during these hours
//   message: "optional note shown in the notification"
// }

const FREQS = ["minute", "hourly", "daily", "weekly", "monthly", "yearly"];

function hm(s) {
  const [h, m] = String(s || "09:00").split(":").map(Number);
  return { hour: h || 0, minute: m || 0 };
}

function inQuiet(dt, quiet) {
  if (!quiet || !quiet.start || !quiet.end) return false;
  const cur = dt.hour * 60 + dt.minute;
  const a = hm(quiet.start), b = hm(quiet.end);
  const s = a.hour * 60 + a.minute, e = b.hour * 60 + b.minute;
  if (s === e) return false;
  return s < e ? cur >= s && cur < e : cur >= s || cur < e;
}

/**
 * Returns the next fire time strictly after `from` as a JS Date, or null.
 * `DateTime` is Luxon's DateTime class (passed in so this file has no imports).
 */
function nextRun(schedule, from, DateTime) {
  if (!schedule || !schedule.enabled) return null;
  const zone = schedule.tz || "UTC";
  const n = Math.max(1, Math.floor(Number(schedule.every) || 1));
  const t = DateTime.fromJSDate(from).setZone(zone);
  const anchor = (schedule.anchor ? DateTime.fromISO(schedule.anchor) : t).setZone(zone).startOf("minute");
  const { hour, minute } = hm(schedule.at_time);

  let cand; // cand(k) -> DateTime, increasing in k
  let unit;
  switch (schedule.freq) {
    case "minute":
      unit = "minutes";
      cand = (k) => anchor.plus({ minutes: k * n });
      break;
    case "hourly": {
      unit = "hours";
      const base = anchor.startOf("hour").set({ minute: Number(schedule.minute) || 0 });
      cand = (k) => base.plus({ hours: k * n });
      break;
    }
    case "daily": {
      unit = "days";
      const base = anchor.startOf("day").set({ hour, minute });
      cand = (k) => base.plus({ days: k * n });
      break;
    }
    case "weekly": {
      // every N weeks, on the chosen weekdays
      const days = (schedule.weekdays && schedule.weekdays.length ? schedule.weekdays : [anchor.weekday])
        .map(Number).filter((d) => d >= 1 && d <= 7).sort();
      const week0 = anchor.startOf("week");
      const weeksSince = Math.max(0, Math.floor(t.diff(week0, "weeks").weeks));
      let w = Math.max(0, Math.floor(weeksSince / n) * n - n);
      for (let guard = 0; guard < 600; guard++, w += n) {
        const wk = week0.plus({ weeks: w });
        for (const d of days) {
          const c = wk.plus({ days: d - 1 }).set({ hour, minute });
          if (c > t && !inQuiet(c, schedule.quiet)) return c.toJSDate();
        }
      }
      return null;
    }
    case "monthly": {
      unit = "months";
      const m0 = anchor.startOf("month");
      const d = Number(schedule.day) || 1;
      cand = (k) => {
        const m = m0.plus({ months: k * n });
        return m.set({ day: Math.min(d, m.daysInMonth), hour, minute });
      };
      break;
    }
    case "yearly": {
      unit = "years";
      const y0 = anchor.startOf("year");
      const mo = Math.min(12, Math.max(1, Number(schedule.month) || 1));
      const d = Number(schedule.day) || 1;
      cand = (k) => {
        const y = y0.plus({ years: k * n }).set({ month: mo });
        return y.set({ day: Math.min(d, y.daysInMonth), hour, minute });
      };
      break;
    }
    default:
      return null;
  }

  // Jump close to `t`, then walk forward to the first candidate after it.
  const elapsed = t.diff(anchor.startOf(unit === "minutes" ? "minute" : unit.slice(0, -1)), unit).get(unit);
  let k = Math.max(0, Math.floor(elapsed / n) - 1);
  for (let guard = 0; guard < 5000; guard++, k++) {
    const c = cand(k);
    if (c > t && !inQuiet(c, schedule.quiet)) return c.toJSDate();
  }
  return null;
}

/** Human summary, e.g. "Every 2 days at 09:00" */
function describe(s) {
  if (!s || !s.enabled) return "No reminder";
  const n = Math.max(1, Number(s.every) || 1);
  const pl = (w) => (n === 1 ? `Every ${w}` : `Every ${n} ${w}s`);
  const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const WD = ["","Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
  switch (s.freq) {
    case "minute": return pl("minute");
    case "hourly": return `${pl("hour")} at :${String(s.minute ?? 0).padStart(2, "0")}`;
    case "daily": return `${n === 1 ? "Daily" : pl("day")} at ${s.at_time}`;
    case "weekly": return `${n === 1 ? "Weekly" : pl("week")} · ${(s.weekdays || []).map((d) => WD[d]).join(", ")} ${s.at_time}`;
    case "monthly": return `${n === 1 ? "Monthly" : pl("month")} on day ${s.day} at ${s.at_time}`;
    case "yearly": return `${n === 1 ? "Yearly" : pl("year")} · ${s.day} ${MONTHS[(s.month || 1) - 1]} ${s.at_time}`;
  }
  return "";
}


Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);

  // ── Test from the app ────────────────────────────────────────────
  const testId = url.searchParams.get("test");
  if (testId) {
    const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const { data: u } = await db.auth.getUser(token);
    if (!u?.user) return json({ error: "unauthorized" }, 401);
    const { data: link } = await db.from("orbit_links").select("*").eq("id", testId).eq("user_id", u.user.id).single();
    if (!link) return json({ error: "not found" }, 404);
    const sent = await pushToUser(u.user.id, [{ ...payload(link, 1), message: "Test reminder ✓" }]);
    return json({ sent });
  }

  // ── Cron tick ────────────────────────────────────────────────────
  if (req.headers.get("x-orbit-cron") !== env("ORBIT_CRON_SECRET") || !env("ORBIT_CRON_SECRET")) {
    return json({ error: "forbidden" }, 403);
  }

  const now = new Date();
  const { data: due, error } = await db.from("orbit_links").select("*")
    .not("next_run_at", "is", null).lte("next_run_at", now.toISOString()).limit(500);
  if (error) return json({ error: error.message }, 500);

  const byUser = new Map<string, object[]>();
  for (const l of (due ?? []) as Link[]) {
    const next = l.schedule?.enabled ? nextRun(l.schedule, now, DateTime) : null;
    const count = (l.pending_count || 0) + 1;
    // Claim the row atomically (only succeeds if nobody else already moved next_run_at)
    const { data: claimed } = await db.from("orbit_links")
      .update({ next_run_at: next ? next.toISOString() : null, pending_count: count, last_sent_at: now.toISOString() })
      .eq("id", l.id).eq("next_run_at", l.next_run_at!).select("id");
    if (!claimed?.length || !l.schedule?.enabled) continue;
    if (!byUser.has(l.user_id)) byUser.set(l.user_id, []);
    byUser.get(l.user_id)!.push(payload(l, count));
  }

  let sent = 0;
  for (const [uid, list] of byUser) sent += await pushToUser(uid, list);
  return json({ due: due?.length ?? 0, sent });
});
