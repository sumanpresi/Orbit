// Shared scheduling engine — used by the app (preview) AND the server (authoritative).
// An inlined copy lives in supabase/functions/send-due/index.ts — keep them in sync.
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

export const FREQS = ["minute", "hourly", "daily", "weekly", "monthly", "yearly"];

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
export function nextRun(schedule, from, DateTime) {
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
export function describe(s) {
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
