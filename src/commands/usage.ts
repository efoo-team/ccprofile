import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { assertDarwin } from "../lib/keychain.js";
import {
  chromeUserAgent,
  chromeUserDataDir,
  parseProfiles,
  readSessionCookies,
  safeStorageKey,
  type ChromeProfile,
} from "../lib/chrome.js";
import {
  fetchAccountUsage,
  NOT_SIGNED_IN,
  type AccountUsage,
  type UsageReport,
  type UsageWindow,
} from "../lib/claudeai.js";
import { loadConfig, type Config } from "../lib/config.js";
import { bold, cyan, dim, fail, green, red, table, yellow } from "../lib/format.js";

interface ProfileResult {
  profile: ChromeProfile;
  usage: AccountUsage;
}

type RowStatus = "ok" | "error" | "no_match" | "no_email";

interface UsageRow {
  profile: string | null;
  email: string | null;
  source: ProfileResult | null;
  status: RowStatus;
  detail: string | null;
}

interface UsageRows {
  registered: UsageRow[];
  other: UsageRow[];
}

export async function usageCommand(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { json: { type: "boolean", default: false } },
  });

  assertDarwin();
  // Registered profiles are the primary list, so a broken config must not
  // silently turn this into a Chrome-only list.
  const config = loadConfig();

  const userDataDir = chromeUserDataDir();
  const localStatePath = join(userDataDir, "Local State");
  let results: ProfileResult[] = [];
  let preparationError: string | null = null;
  if (!existsSync(localStatePath)) {
    preparationError = "Google Chrome data not found; usage requires Chrome session cookies";
  } else {
    try {
      const profiles = parseProfiles(readFileSync(localStatePath, "utf8")).filter((p) =>
        existsSync(join(userDataDir, p.dir, "Cookies")),
      );
      // No cookie stores means no matches, without requiring a Keychain key.
      if (profiles.length > 0) {
        const key = await safeStorageKey();
        const userAgent = chromeUserAgent(userDataDir);
        const spinner = values.json
          ? { stop: () => {} }
          : startSpinner(`querying claude.ai for ${profiles.length} Chrome profile(s)…`);
        try {
          results = await Promise.all(
            profiles.map((profile) => loadUsage(profile, userDataDir, key, userAgent)),
          );
        } finally {
          spinner.stop();
        }
      }
    } catch (error) {
      preparationError = error instanceof Error ? error.message : String(error);
    }
  }

  const rows = buildRows(config, results, preparationError);
  const exitCode = preparationError !== null || hasRealFailure(results) ? 1 : 0;

  if (values.json) {
    console.log(JSON.stringify([...rows.registered, ...rows.other].map(toJson), null, 2));
  } else {
    render(rows);
  }
  if (preparationError !== null && rows.registered.length === 0) {
    console.error(fail(preparationError));
  }
  return exitCode;
}

/** Resolve verified API emails; Chrome's own account/name never proves identity. */
function buildRows(config: Config, results: ProfileResult[], preparationError: string | null): UsageRows {
  const names = Object.keys(config.profiles).sort();
  const registeredEmails = new Set(
    names.flatMap((name) => {
      const email = config.profiles[name]!.email;
      return email ? [email.toLowerCase()] : [];
    }),
  );
  const selected = new Set<ProfileResult>();
  const registered = names.map((name): UsageRow => {
    const email = config.profiles[name]!.email || null;
    const base = { profile: name, email, source: null };
    if (preparationError !== null) {
      return { ...base, status: "error", detail: preparationError };
    }
    if (email === null) {
      return { ...base, status: "no_email", detail: "registered email is missing" };
    }
    const matches = results.filter((result) => result.usage.email?.toLowerCase() === email.toLowerCase());
    // Prefer a usable session. Reuse it for every registered name with the
    // same email; duplicates must never overwrite one another's profile row.
    const source = matches.find((result) => result.usage.ok) ?? matches[0];
    if (source === undefined) {
      return { ...base, status: "no_match", detail: "matching Chrome session not detected" };
    }
    selected.add(source);
    return {
      profile: name,
      email: source.usage.email ?? email,
      source,
      status: source.usage.ok ? "ok" : "error",
      detail: source.usage.ok ? null : source.usage.detail,
    };
  });
  const other = results.filter((result) => {
    if (selected.has(result)) return false;
    if (!result.usage.ok) return result.usage.detail !== NOT_SIGNED_IN;
    // Successful duplicates are already represented by a registered row;
    // keep unused failures visible, and retain unregistered successes.
    return result.usage.email === null || !registeredEmails.has(result.usage.email.toLowerCase());
  }).map((source): UsageRow => ({
    profile: null,
    email: source.usage.email ?? null,
    source,
    status: source.usage.ok ? "ok" : "error",
    detail: source.usage.ok ? null : source.usage.detail,
  }));
  return { registered, other };
}

/**
 * A profile that was never signed in is expected and not a failure; anything
 * else (expired session, Cloudflare block, decrypt/read error) is, so the
 * command exits non-zero for scripts even though the table still prints.
 */
function hasRealFailure(results: ProfileResult[]): boolean {
  return results.some((r) => !r.usage.ok && r.usage.detail !== NOT_SIGNED_IN);
}

/** Decrypts one profile's cookies and fetches its usage; never throws. */
async function loadUsage(
  profile: ChromeProfile,
  userDataDir: string,
  key: Buffer,
  userAgent: string,
): Promise<ProfileResult> {
  try {
    const cookies = await readSessionCookies(join(userDataDir, profile.dir, "Cookies"), key);
    return { profile, usage: await fetchAccountUsage(cookies, userAgent) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { profile, usage: { ok: false, status: 0, detail } };
  }
}

function render(rows: UsageRows): void {
  const header = ["PROFILE", "ACCOUNT", "CHROME", "5-HOUR", "WEEK · ALL", "FABLE · WEEK", "STATUS"].map(bold);
  if (rows.registered.length > 0) {
    console.log(table([header, ...sortByWeeklyReset(rows.registered).map(tableRow)]));
  } else {
    console.log(dim("No profiles yet. Create one with `ccprofile add <name>`."));
  }
  if (rows.other.length > 0) {
    console.log(`\n${bold("Other Chrome results (not assigned to a registered profile)")}`);
    console.log(table([header, ...sortByWeeklyReset(rows.other).map(tableRow)]));
  }
}

function tableRow(row: UsageRow): string[] {
  const usage = row.source?.usage;
  const report = usage?.ok ? usage.report : null;
  const status = row.status === "ok" ? green("OK")
    : row.status === "error" ? red(`ERROR ${row.detail}`)
    : yellow(`${row.status === "no_email" ? "NO EMAIL" : "NO MATCH"}: ${row.detail}`);
  return [
    row.profile === null ? dim("-") : cyan(row.profile),
    row.email ?? dim("(unknown)"),
    row.source === null ? dim("-") : dim(row.source.profile.name),
    windowCell(report?.session ?? null),
    windowCell(report?.weeklyAll ?? null),
    windowCell(report?.fable ?? null),
    status,
  ];
}

/**
 * Orders accounts by how soon their weekly (all-models) limit resets — the
 * nearest reset first, the furthest last. Accounts with no weekly window sort
 * to the end so a resolved figure never sits below a blank one.
 */
function sortByWeeklyReset(results: UsageRow[]): UsageRow[] {
  const resetKey = (r: UsageRow): number => {
    const usage = r.source?.usage;
    return usage?.ok ? usage.report.weeklyAll?.resetsAt?.getTime() ?? Number.MAX_SAFE_INTEGER
      : Number.MAX_SAFE_INTEGER;
  };
  return [...results].sort((a, b) => {
    if (a.status === "ok" && b.status !== "ok") return -1;
    if (a.status !== "ok" && b.status === "ok") return 1;
    return resetKey(a) - resetKey(b);
  });
}

function windowCell(window: UsageWindow | null): string {
  if (window === null) return dim("-");
  const reset = window.resetsAt === null ? "" : `  ${dim(formatReset(window.resetsAt))}`;
  return `${percent(window)}${reset}`;
}

function percent(window: UsageWindow): string {
  // Right-align to 3 digits so the reset time lines up down the column.
  const text = `${String(window.percent).padStart(3, " ")}%`;
  if (window.severity === "critical" || window.percent >= 90) return red(text);
  if (window.severity === "warning" || window.percent >= 80) return yellow(text);
  return text;
}

/**
 * Local-time reset as `M/D HH:mm` (respects the machine's timezone). The date
 * is right-padded to a fixed width so the clock times align down the column.
 */
function formatReset(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const md = `${date.getMonth() + 1}/${date.getDate()}`.padStart(5, " ");
  return `${md} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function toJson(row: UsageRow): Record<string, unknown> {
  const usage = row.source?.usage;
  return {
    profile: row.profile,
    chromeProfile: row.source?.profile.name ?? null,
    chromeDir: row.source?.profile.dir ?? null,
    email: row.email,
    error: row.status === "error" ? row.detail : null,
    usage: usage?.ok ? serializeReport(usage.report) : null,
    status: row.status,
  };
}

function serializeReport(report: UsageReport): Record<string, unknown> {
  const win = (w: UsageWindow | null): Record<string, unknown> | null =>
    w === null
      ? null
      : { percent: w.percent, resetsAt: w.resetsAt?.toISOString() ?? null, severity: w.severity };
  return {
    session: win(report.session),
    weeklyAll: win(report.weeklyAll),
    fable: win(report.fable),
  };
}

/**
 * Minimal TTY-only spinner for the network wait; stays silent when output is
 * piped so scripted/`--json` runs keep clean output.
 */
function startSpinner(text: string): { stop(): void } {
  if (!process.stdout.isTTY) return { stop: () => {} };
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const paint = (): void => {
    process.stdout.write(`\r\u001B[2K${dim(`${frames[i % frames.length] ?? ""} ${text}`)}`);
    i += 1;
  };
  paint();
  const timer = setInterval(paint, 100);
  return {
    stop: (): void => {
      clearInterval(timer);
      process.stdout.write("\r\u001B[2K");
    },
  };
}
