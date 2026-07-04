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
import { loadConfig } from "../lib/config.js";
import { bold, cyan, dim, fail, red, table, warn, yellow } from "../lib/format.js";

interface ProfileResult {
  profile: ChromeProfile;
  usage: AccountUsage;
}

/** A profile whose usage was fetched successfully (email + report available). */
type SignedInResult = ProfileResult & { usage: Extract<AccountUsage, { ok: true }> };

/**
 * Maps a claude.ai account email to the ccprofile name registered for it, so a
 * signed-in Chrome account that matches a stored profile is labelled with that
 * profile's name. Matching is case-insensitive.
 */
function profileNamesByEmail(): Map<string, string> {
  const byEmail = new Map<string, string>();
  try {
    for (const [name, entry] of Object.entries(loadConfig().profiles)) {
      if (entry.email) byEmail.set(entry.email.toLowerCase(), name);
    }
  } catch {
    // A malformed/unsupported config.json shouldn't sink the usage table;
    // profile labelling is auxiliary, so degrade to unlabelled accounts.
  }
  return byEmail;
}

function matchedProfileName(email: string | null, byEmail: Map<string, string>): string | null {
  if (email === null) return null;
  return byEmail.get(email.toLowerCase()) ?? null;
}

export async function usageCommand(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { json: { type: "boolean", default: false } },
  });

  assertDarwin();

  const userDataDir = chromeUserDataDir();
  const localStatePath = join(userDataDir, "Local State");
  if (!existsSync(localStatePath)) {
    console.error(
      fail(
        "Google Chrome data not found. `ccprofile usage` reads claude.ai session cookies from Chrome.",
      ),
    );
    return 1;
  }

  let key: Buffer;
  try {
    key = await safeStorageKey();
  } catch (error) {
    console.error(fail(error instanceof Error ? error.message : String(error)));
    return 1;
  }

  const userAgent = chromeUserAgent(userDataDir);
  const profiles = parseProfiles(readFileSync(localStatePath, "utf8")).filter((p) =>
    existsSync(join(userDataDir, p.dir, "Cookies")),
  );

  const spinner = values.json
    ? { stop: () => {} }
    : startSpinner(`querying claude.ai for ${profiles.length} Chrome profile(s)…`);
  const results = await Promise.all(
    profiles.map((profile) => loadUsage(profile, userDataDir, key, userAgent)),
  );
  spinner.stop();

  const byEmail = profileNamesByEmail();

  if (values.json) {
    console.log(JSON.stringify(results.map((r) => toJson(r, byEmail)), null, 2));
    return hasRealFailure(results) ? 1 : 0;
  }

  return render(results, byEmail);
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

function render(results: ProfileResult[], byEmail: Map<string, string>): number {
  const signedIn: SignedInResult[] = [];
  const problems: string[] = [];
  for (const { profile, usage } of results) {
    if (usage.ok) {
      signedIn.push({ profile, usage });
    } else if (usage.detail !== NOT_SIGNED_IN) {
      // A missing session is expected for stray Chrome profiles; only real
      // failures (expired session, Cloudflare block) are worth surfacing.
      problems.push(warn(`${profile.name}: ${usage.detail}`));
    }
  }

  const header = ["PROFILE", "ACCOUNT", "CHROME", "5-HOUR", "WEEK · ALL", "FABLE · WEEK"].map(bold);
  const rows: string[][] = [header];
  for (const { profile, usage } of sortByWeeklyReset(signedIn)) {
    const name = matchedProfileName(usage.email, byEmail);
    rows.push([
      name === null ? dim("-") : cyan(name),
      usage.email ?? dim("(unknown)"),
      dim(profile.name),
      windowCell(usage.report.session),
      windowCell(usage.report.weeklyAll),
      windowCell(usage.report.fable),
    ]);
  }

  if (rows.length === 1 && problems.length === 0) {
    console.log(
      dim("No claude.ai sessions found in Chrome. Sign in at https://claude.ai and retry."),
    );
    return 0;
  }

  if (rows.length > 1) console.log(table(rows));
  for (const problem of problems) console.log(problem);
  return problems.length > 0 ? 1 : 0;
}

/**
 * Orders accounts by how soon their weekly (all-models) limit resets — the
 * nearest reset first, the furthest last. Accounts with no weekly window sort
 * to the end so a resolved figure never sits below a blank one.
 */
function sortByWeeklyReset(results: SignedInResult[]): SignedInResult[] {
  const resetKey = (r: SignedInResult): number =>
    r.usage.report.weeklyAll?.resetsAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
  return [...results].sort((a, b) => resetKey(a) - resetKey(b));
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

function toJson(result: ProfileResult, byEmail: Map<string, string>): Record<string, unknown> {
  const { profile, usage } = result;
  const email = usage.ok ? usage.email : null;
  return {
    profile: matchedProfileName(email, byEmail),
    chromeProfile: profile.name,
    chromeDir: profile.dir,
    email,
    error: usage.ok ? null : usage.detail,
    usage: usage.ok ? serializeReport(usage.report) : null,
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
