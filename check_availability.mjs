#!/usr/bin/env node
// Check booking availability, either once for a range of dates (fetched in
// parallel) or by repeatedly polling a single date until it has a spot.
//
// Requires Node.js 18.3+ (built-in fetch and util.parseArgs). No npm dependencies.

import { parseArgs } from "node:util";
import { spawn } from "node:child_process";

const API_URL = "https://q.wildlifesanctuaryfca16.com/api/v1/bookings/availability";

const USAGE = `Usage:
  check_availability --from DATE [--to DATE]       check a range once
  check_availability START END                     same, positional form
  check_availability --watch DATE [--interval 60s] poll one date until available

Range options:
  --from DATE          first date (yyyy-mm-dd)
  --to DATE            last date (default: same as --from)
  --concurrency N      max requests in flight at once (default 5, env CONCURRENCY)

Watch options:
  --watch DATE         date to keep checking (yyyy-mm-dd)
  --interval TIME      time between checks: 30, 30s, 5m, 1h (default 60s)
  --on-available CMD   shell command to run when a spot opens; gets DATE,
                       AVAILABLE and CAPACITY as environment variables

Common options:
  --retries N          extra attempts per request on failure (default 2, env RETRIES)
  --timeout-ms N       per-request timeout (default 15000, env TIMEOUT_MS)
  -h, --help           show this help`;

const die = (msg) => {
  console.error(msg);
  process.exit(1);
};

let opts;
try {
  opts = parseArgs({
    allowPositionals: true,
    options: {
      from: { type: "string" },
      to: { type: "string" },
      watch: { type: "string" },
      interval: { type: "string", default: "60s" },
      "on-available": { type: "string" },
      concurrency: { type: "string", default: process.env.CONCURRENCY ?? "5" },
      retries: { type: "string", default: process.env.RETRIES ?? "2" },
      "timeout-ms": { type: "string", default: process.env.TIMEOUT_MS ?? "15000" },
      help: { type: "boolean", short: "h" },
    },
  });
} catch (err) {
  die(`Error: ${err.message}\n\n${USAGE}`);
}
const { values: flags, positionals } = opts;

if (flags.help) {
  console.log(USAGE);
  process.exit(0);
}

const toInt = (name, s, min) => {
  const n = Number(s);
  if (!Number.isInteger(n) || n < min) die(`Error: --${name} must be an integer >= ${min}.`);
  return n;
};
const CONCURRENCY = toInt("concurrency", flags.concurrency, 1);
const RETRIES = toInt("retries", flags.retries, 0);
const TIMEOUT_MS = toInt("timeout-ms", flags["timeout-ms"], 1);

// Parse yyyy-mm-dd as a UTC date, rejecting things like 2027-02-30
function parseDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s ? d : null;
}

const requireDate = (s) => parseDate(s) ?? die(`Error: invalid date '${s}' (expected yyyy-mm-dd).`);

// "90" / "90s" / "5m" / "1h" -> milliseconds
function parseInterval(s) {
  const m = /^(\d+(?:\.\d+)?)(s|m|h)?$/.exec(s);
  if (!m) die(`Error: invalid --interval '${s}' (e.g. 30, 30s, 5m, 1h).`);
  const ms = Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[m[2] ?? "s"];
  if (ms < 5000) die("Error: --interval must be at least 5s.");
  return ms;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchDate(date) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${API_URL}?date=${date}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (body?.success !== true) throw new Error("success != true");
      const capacity = body.data?.capacity ?? 0;
      const available = body.data?.available ?? 0;
      return { date, ok: true, capacity, available };
    } catch (err) {
      if (attempt >= RETRIES) return { date, ok: false, error: err.message };
      await sleep(500 * 2 ** attempt); // back off before retrying
    }
  }
}

const hasSpot = (r) => r.ok && Number.isInteger(r.available) && r.available > 0;

// Run fn over items with at most `limit` promises in flight; results keep input order
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const row = (a, b, c, d) => `${a.padEnd(12)} ${String(b).padStart(8)} ${String(c).padStart(10)}  ${d}`;

async function checkRange(fromStr, toStr) {
  const start = requireDate(fromStr);
  const end = requireDate(toStr);
  if (start > end) die("Error: the start date must be on or before the end date.");

  const dates = [];
  for (const d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    dates.push(d.toISOString().slice(0, 10));
  }

  const results = await mapLimit(dates, CONCURRENCY, fetchDate);

  console.log(row("DATE", "CAPACITY", "AVAILABLE", "STATUS"));
  console.log(row("----------", "--------", "---------", "------"));

  const availableDates = [];
  const failedDates = [];
  for (const r of results) {
    if (!r.ok) {
      console.log(row(r.date, "-", "-", "ERROR"));
      failedDates.push(r.date);
      continue;
    }
    if (hasSpot(r)) availableDates.push(`${r.date} (${r.available} left)`);
    console.log(row(r.date, r.capacity, r.available, hasSpot(r) ? "AVAILABLE" : "full"));
  }

  console.log("\n===== Summary =====");
  if (availableDates.length > 0) {
    console.log(`Dates with availability (${availableDates.length}):`);
    for (const d of availableDates) console.log(`  - ${d}`);
  } else {
    console.log(`No available dates between ${fromStr} and ${toStr}.`);
  }

  if (failedDates.length > 0) {
    console.log(`\nRequests that failed (${failedDates.length}): ${failedDates.join(" ")}`);
  }
}

const clock = () => new Date().toTimeString().slice(0, 8);

const formatDuration = (ms) => {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return [h && `${h}h`, m && `${m}m`, (s % 60 || s === 0) && `${s % 60}s`].filter(Boolean).join(" ");
};

// On a TTY the status is one line redrawn in place; otherwise (logs, docker without -t)
// each check is printed as its own line.
const isTTY = process.stdout.isTTY;
const status = {
  set(text) {
    if (isTTY) process.stdout.write(`\r\x1b[2K${text}`);
  },
  log(text) {
    process.stdout.write(isTTY ? `\r\x1b[2K${text}\n` : `${text}\n`);
  },
};

function notify(r) {
  const message = `${r.date}: ${r.available} of ${r.capacity} spots available`;
  process.stdout.write("\x07"); // terminal bell

  // Desktop notification when running directly on macOS (not inside Docker)
  if (process.platform === "darwin") {
    const script = `display notification ${JSON.stringify(message)} with title "Booking available" sound name "Glass"`;
    spawn("osascript", ["-e", script], { stdio: "ignore" }).on("error", () => {});
  }

  const cmd = flags["on-available"];
  if (!cmd) return Promise.resolve();
  return new Promise((resolve) => {
    const child = spawn(cmd, {
      shell: true,
      stdio: "inherit",
      env: { ...process.env, DATE: r.date, AVAILABLE: String(r.available), CAPACITY: String(r.capacity) },
    });
    child.on("error", (err) => {
      console.error(`--on-available failed: ${err.message}`);
      resolve();
    });
    child.on("exit", (code) => {
      if (code) console.error(`--on-available exited with code ${code}`);
      resolve();
    });
  });
}

async function watchDate(date, intervalMs) {
  requireDate(date);
  const startedAt = Date.now();
  let checks = 0;
  let errors = 0;

  const stop = () => {
    status.log(`\nStopped after ${checks} checks (${formatDuration(Date.now() - startedAt)}); no spot found.`);
    process.exit(130);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  console.log(`Watching ${date} every ${formatDuration(intervalMs)}. Press Ctrl+C to stop.\n`);

  while (true) {
    checks++;
    status.set(`[${clock()}] check #${checks}: requesting ${date}...`);
    const r = await fetchDate(date);

    if (hasSpot(r)) {
      status.log(`[${clock()}] check #${checks}: ${r.available}/${r.capacity} AVAILABLE`);
      console.log(`\n>>> ${date} has ${r.available} spot(s) available! ` +
        `(found after ${checks} checks, ${formatDuration(Date.now() - startedAt)})`);
      await notify(r);
      process.exit(0);
    }

    if (!r.ok) errors++;
    const result = r.ok ? `full (${r.available}/${r.capacity})` : `ERROR: ${r.error}`;
    const summary = `[${clock()}] check #${checks}: ${result} | running ${formatDuration(Date.now() - startedAt)}` +
      (errors ? `, ${errors} errors` : "");

    if (!isTTY) {
      status.log(summary);
      await sleep(intervalMs);
      continue;
    }

    // Count down to the next check, redrawing once per second
    const nextAt = Date.now() + intervalMs;
    while (Date.now() < nextAt) {
      status.set(`${summary} | next in ${formatDuration(nextAt - Date.now())}`);
      await sleep(Math.min(1000, nextAt - Date.now()));
    }
  }
}

if (flags.watch) {
  if (flags.from || flags.to || positionals.length) die("Error: --watch cannot be combined with a date range.");
  await watchDate(flags.watch, parseInterval(flags.interval));
} else if (flags.from) {
  if (positionals.length) die("Error: use either --from/--to or positional dates, not both.");
  await checkRange(flags.from, flags.to ?? flags.from);
} else if (positionals.length === 2 && !flags.to) {
  await checkRange(positionals[0], positionals[1]);
} else {
  die(USAGE);
}
