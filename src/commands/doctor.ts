import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { daysRemaining, loadConfig, type ProfileEntry } from "../lib/config.js";
import { parseLinkedProfile } from "../lib/envrc.js";
import { Keychain } from "../lib/keychain.js";
import { probeToken } from "../lib/probe.js";
import {
  DEFAULT_PROBE_MODEL,
  FALLBACK_PROBE_MODEL,
  OVERRIDING_ENV_VARS,
  probeUsage,
} from "../lib/usage.js";
import { bold, dim, fail, green, ok, red, stripAnsi, warn, yellow } from "../lib/format.js";

export async function doctorCommand(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      offline: { type: "boolean", default: false },
      model: { type: "string" },
    },
  });
  const dir = resolve(positionals[0] ?? process.cwd());
  let problems = 0;
  let warnings = 0;

  if (process.platform !== "darwin") {
    console.log(fail("Not macOS: ccprofile's Keychain backend is unavailable on this platform."));
    return 1;
  }

  const claude = spawnSync("claude", ["--version"], { stdio: "pipe" });
  const claudeAvailable = !claude.error && claude.status === 0;
  const direnv = spawnSync("direnv", ["version"], { stdio: "pipe" });
  const direnvAvailable = !direnv.error && direnv.status === 0;
  if (claudeAvailable && direnvAvailable) {
    const claudeVersion = claude.stdout.toString().trim().split(" ")[0] ?? "";
    console.log(ok(`macOS Keychain · Claude Code ${claudeVersion} · direnv ${direnv.stdout.toString().trim()}`));
  } else {
    console.log(ok("Platform: macOS (Keychain backend available)"));
    if (claudeAvailable) {
      console.log(ok(`Claude Code: ${claude.stdout.toString().trim()}`));
    } else {
      console.log(warn("`claude` CLI not found. `ccprofile add` cannot launch setup-token for you."));
      warnings += 1;
    }
    if (direnvAvailable) {
      console.log(ok(`direnv: ${direnv.stdout.toString().trim()}`));
    } else {
      console.log(fail("direnv not found. Linked directories will not activate tokens automatically."));
      console.log("  Install: brew install direnv  /  fish hook: direnv hook fish | source");
      problems += 1;
    }
  }

  for (const envVar of OVERRIDING_ENV_VARS) {
    if (process.env[envVar] !== undefined) {
      console.log(fail(`${envVar} is set: it overrides ANTHROPIC_AUTH_TOKEN and bypasses ccprofile routing.`));
      problems += 1;
    }
  }

  const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  const settingsPath = join(claudeConfigDir, "settings.json");
  if (existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
      if (settings.apiKeyHelper !== undefined) {
        console.log(warn(`apiKeyHelper is configured in ${settingsPath}; linked ccprofile directories use ANTHROPIC_AUTH_TOKEN, which takes precedence.`));
        warnings += 1;
      }
    } catch {
      console.log(warn(`Could not parse ${settingsPath}.`));
      warnings += 1;
    }
  }

  const config = loadConfig();
  const keychain = new Keychain();
  const profiles = Object.entries(config.profiles);
  if (profiles.length > 0) {
    const ctx: ProfileCheckContext = {
      keychain,
      expiryWarningDays: config.settings.expiryWarningDays,
      offline: values.offline,
      claudeAvailable,
      probeModel: values.model ?? DEFAULT_PROBE_MODEL,
    };
    // All profiles are checked concurrently (each profile's own steps stay
    // sequential so the fable→haiku cascade works); rows print in config
    // order as they resolve, making wall time the slowest profile, not the sum.
    const running = profiles.map(([name, profile]) => checkProfile(name, profile, ctx));

    const widths = columnWidths(profiles.map(([name]) => name));
    console.log();
    console.log(dim(renderCells(HEADER, widths)));
    const spinner = startSpinner(
      values.offline || !claudeAvailable
        ? "checking profiles…"
        : `probing ${profiles.length} profile(s) — one tiny real request each…`,
    );
    for (const pending of running) {
      const row = await pending;
      spinner.clear();
      console.log(renderCells([bold(row.name), row.token, row.expires, row.fable, row.others, row.note], widths));
      for (const detail of row.details) {
        console.log(`  ${dim("↳")} ${detail}`);
      }
      problems += row.problems;
      warnings += row.warnings;
    }
    spinner.stop();
  }

  const envrcPath = join(dir, ".envrc");
  if (existsSync(envrcPath)) {
    console.log();
    const linked = parseLinkedProfile(readFileSync(envrcPath, "utf8"));
    if (linked === null) {
      console.log(ok(`${envrcPath} exists but has no ccprofile block (not managed here).`));
    } else if (config.profiles[linked]) {
      if (dir !== resolve(process.cwd())) {
        console.log(ok(`${bold(dir)} → profile "${linked}"`));
      } else {
        const linkedProfile = config.profiles[linked];
        const exportedToken = process.env.ANTHROPIC_AUTH_TOKEN;
        if (exportedToken === undefined) {
          console.log(fail(`This directory → profile "${linked}", but ANTHROPIC_AUTH_TOKEN is not exported in this shell. Run: direnv reload`));
          problems += 1;
        } else {
          const linkedToken = await keychain.getToken(
            linkedProfile.keychain.service,
            linkedProfile.keychain.account,
          );
          if (linkedToken !== null && exportedToken !== linkedToken) {
            console.log(fail(`This directory → profile "${linked}", but this shell exports a different ANTHROPIC_AUTH_TOKEN. Run: direnv reload, then restart Claude Code.`));
            problems += 1;
          } else if (linkedToken !== null) {
            console.log(ok(`This directory → profile "${linked}" (ANTHROPIC_AUTH_TOKEN exported)`));
          } else {
            console.log(ok(`This directory → profile "${linked}"`));
          }
        }
      }
    } else {
      console.log(fail(`${envrcPath} references unknown profile "${linked}". Run: ccprofile link <profile> ${dir}`));
      problems += 1;
    }
  }

  console.log();
  if (problems > 0) {
    console.log(fail(`${problems} problem(s), ${warnings} warning(s).`));
    return 1;
  }
  console.log(ok(`No problems found (${warnings} warning(s)).`));
  return 0;
}

const HEADER = ["PROFILE", "TOKEN", "EXPIRES", "FABLE", "OTHERS", "NOTE"];

// The cell vocabulary is fixed, so column widths are known before any check
// resolves — rows can stream in as profiles finish, without a barrier.
const TOKEN_CELLS = {
  stored: green("✓ stored"),
  live: green("✓ live"),
  missing: red("✗ missing"),
  revoked: red("✗ revoked"),
  mismatch: red("✗ mismatch"),
  unknown: yellow("? unknown"),
} as const;
const PROBE_CELLS = {
  ok: green("✓ ok"),
  limit: yellow("⚠ limit"),
  rejected: red("✗"),
  unknown: yellow("?"),
  none: dim("-"),
} as const;

function columnWidths(names: string[]): number[] {
  const vocab = (cells: Record<string, string>): number[] =>
    Object.values(cells).map((c) => stripAnsi(c).length);
  return [
    Math.max("PROFILE".length, ...names.map((n) => n.length)),
    Math.max("TOKEN".length, ...vocab(TOKEN_CELLS)),
    "EXPIRES".length,
    Math.max("FABLE".length, ...vocab(PROBE_CELLS)),
    Math.max("OTHERS".length, ...vocab(PROBE_CELLS)),
    0, // NOTE is last and stays unpadded
  ];
}

function renderCells(cells: string[], widths: number[]): string {
  return cells
    .map((cell, i) => {
      const width = widths[i] ?? 0;
      return cell + " ".repeat(Math.max(0, width - stripAnsi(cell).length));
    })
    .join("  ")
    .trimEnd();
}

function expiresCell(days: number, warningDays: number): string {
  const text = `${days}d`;
  if (days < 0) return red(text);
  if (days <= warningDays) return yellow(text);
  return text;
}

/**
 * Minimal dependency-free progress indicator for the parallel probe wait.
 * Renders only on a TTY (piped/CI output stays clean). clear() erases the
 * spinner line so a result row can print; the interval repaints it below.
 */
function startSpinner(text: string): { clear(): void; stop(): void } {
  if (!process.stdout.isTTY) {
    return { clear: () => {}, stop: () => {} };
  }
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const paint = (): void => {
    process.stdout.write(`\r\u001B[2K${dim(`${frames[i % frames.length] ?? ""} ${text}`)}`);
    i += 1;
  };
  paint();
  const timer = setInterval(paint, 100);
  const clear = (): void => {
    process.stdout.write("\r\u001B[2K");
  };
  return {
    clear,
    stop: (): void => {
      clearInterval(timer);
      clear();
    },
  };
}

interface ProfileRow {
  name: string;
  token: string;
  expires: string;
  fable: string;
  others: string;
  note: string;
  details: string[];
  problems: number;
  warnings: number;
}

interface ProfileCheckContext {
  keychain: Keychain;
  expiryWarningDays: number;
  offline: boolean;
  claudeAvailable: boolean;
  probeModel: string;
}

/**
 * Runs every check for one profile and returns a table row instead of
 * printing, so all profiles can run concurrently without interleaving
 * output. Detail lines carry remediation/diagnostic text that does not fit
 * a cell. Must never reject: doctor prints rows in config order while later
 * profiles are still running, so a rejection before its turn would be an
 * unhandled promise rejection.
 */
async function checkProfile(
  name: string,
  profile: ProfileEntry,
  ctx: ProfileCheckContext,
): Promise<ProfileRow> {
  const row: ProfileRow = {
    name,
    token: PROBE_CELLS.none,
    expires: PROBE_CELLS.none,
    fable: PROBE_CELLS.none,
    others: PROBE_CELLS.none,
    note: "",
    details: [],
    problems: 0,
    warnings: 0,
  };
  try {
    const present = await ctx.keychain.hasEntry(profile.keychain.service, profile.keychain.account);
    if (!present) {
      row.token = TOKEN_CELLS.missing;
      row.problems += 1;
      row.details.push(`Keychain entry missing. Re-run: ccprofile add ${name} --force`);
      return row;
    }
    row.token = TOKEN_CELLS.stored;
    const days = daysRemaining(profile.expiresAt);
    row.expires = expiresCell(days, ctx.expiryWarningDays);
    if (days < 0) {
      row.problems += 1;
      row.details.push(`Token recorded as expired ${-days}d ago. Re-issue with claude setup-token.`);
    } else if (days <= ctx.expiryWarningDays) {
      row.warnings += 1;
    }

    if (ctx.offline) return row;
    const token = await ctx.keychain.getToken(profile.keychain.service, profile.keychain.account);
    if (token === null) return row;
    const live = await probeToken(token);
    if (live.status === "alive") {
      if (live.email !== undefined && profile.email !== undefined && live.email !== profile.email) {
        row.token = TOKEN_CELLS.mismatch;
        row.problems += 1;
        row.details.push(`Server says the token belongs to ${live.email}, but config records ${profile.email}.`);
      } else {
        row.token = TOKEN_CELLS.live;
      }
      if (ctx.claudeAvailable) {
        await appendUsageProbe(row, token, ctx.probeModel);
      }
    } else if (live.status === "invalid") {
      row.token = TOKEN_CELLS.revoked;
      row.problems += 1;
      row.details.push(`Token rejected by the server (revoked or expired early). Re-issue with: ccprofile add ${name} --force`);
    } else {
      row.token = TOKEN_CELLS.unknown;
      row.warnings += 1;
      row.details.push(`Liveness check inconclusive (${live.detail}). Use --offline to skip.`);
    }
  } catch (error) {
    row.problems += 1;
    row.details.push(`Check failed (${error instanceof Error ? error.message : String(error)}).`);
  }
  return row;
}

/**
 * Fills the FABLE/OTHERS cells via real inference. fable is probed first by
 * default; on a fable limit, a haiku probe distinguishes "fable's separate
 * budget is exhausted" from "the whole subscription window is exhausted".
 * The two probes stay sequential within a profile (the cascade depends on
 * the first result); concurrency happens across profiles. Limits count as
 * warnings, not problems: doctor's exit code reflects configuration health,
 * and a rate-limited profile is configured correctly.
 */
async function appendUsageProbe(row: ProfileRow, token: string, model: string): Promise<void> {
  const pinnedIsFable = /fable/i.test(model);
  const setProbedCell = (cell: string): void => {
    if (pinnedIsFable) row.fable = cell;
    else row.others = cell;
  };
  const usage = await probeUsage(token, model);
  if (usage.status === "usable") {
    if (pinnedIsFable) {
      row.fable = PROBE_CELLS.ok;
      // fable draws from the shared pool too, so fable OK implies the rest.
      row.others = PROBE_CELLS.ok;
    } else {
      row.others = PROBE_CELLS.ok;
      row.note = `probed ${model}`;
    }
    return;
  }
  if (usage.status === "limited") {
    row.warnings += 1;
    const resets = usage.resetsAt === undefined ? "" : ` (resets ${usage.resetsAt.toLocaleString()})`;
    if (!pinnedIsFable) {
      row.others = PROBE_CELLS.limit;
      row.note = `${model} usage limit reached${resets}`;
      return;
    }
    row.fable = PROBE_CELLS.limit;
    const fallback = await probeUsage(token, FALLBACK_PROBE_MODEL);
    if (fallback.status === "usable") {
      row.others = PROBE_CELLS.ok;
      row.note = `${FALLBACK_PROBE_MODEL}/sonnet/opus available${resets}`;
    } else if (fallback.status === "limited") {
      row.others = PROBE_CELLS.limit;
      row.note =
        fallback.resetsAt === undefined
          ? `subscription window exhausted${resets}`
          : `subscription window exhausted (resets ${fallback.resetsAt.toLocaleString()})`;
    } else {
      row.others = PROBE_CELLS.unknown;
      row.note = `${FALLBACK_PROBE_MODEL} probe inconclusive`;
      row.details.push(`${FALLBACK_PROBE_MODEL} probe: ${fallback.detail}`);
    }
    return;
  }
  if (usage.status === "invalid") {
    setProbedCell(PROBE_CELLS.rejected);
    row.problems += 1;
    row.details.push(`Inference probe rejected the token (${usage.detail}). Re-issue with: ccprofile add ${row.name} --force`);
    return;
  }
  setProbedCell(PROBE_CELLS.unknown);
  row.warnings += 1;
  row.note = "usage probe inconclusive";
  row.details.push(`Usage probe (${model}): ${usage.detail}`);
}
