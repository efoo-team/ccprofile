import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig, type Config } from "../lib/config.js";
import { parseLinkedProfile } from "../lib/envrc.js";
import { assertDarwin, Keychain } from "../lib/keychain.js";
import { OVERRIDING_ENV_VARS } from "../lib/usage.js";
import { bold, cyan, dim, fail, ok, warn } from "../lib/format.js";

/**
 * `ccprofile which` answers one question fast: which account will Claude Code
 * use in this shell, right now? Unlike `doctor` it runs no inference probes and
 * no liveness checks — just the local signals (env vars, the exported token,
 * and the current directory's link) — so it returns effectively instantly.
 */
export async function whichCommand(argv: string[]): Promise<number> {
  parseArgs({ args: argv, allowPositionals: true, options: {} });
  assertDarwin();

  const config = loadConfig();
  const overrideVar = OVERRIDING_ENV_VARS.find((v) => process.env[v] !== undefined);
  const exportedToken = process.env.ANTHROPIC_AUTH_TOKEN;
  const linkName = readCwdLink();
  const linkIsKnown = linkName !== null && config.profiles[linkName] !== undefined;

  // The Keychain read is the only I/O with a cost, and only when a token is
  // actually exported — resolving it back to a profile name.
  let matchedProfile: string | null = null;
  if (overrideVar === undefined && exportedToken !== undefined && exportedToken !== "") {
    matchedProfile = await findProfileByToken(config, exportedToken);
  }

  const result = classifyActiveAccount({
    overrideVar,
    exportedToken,
    linkName,
    linkIsKnown,
    matchedProfile,
  });
  return printResult(result, config);
}

export type ActiveAccount =
  /** An override env var (e.g. ANTHROPIC_API_KEY) bypasses ccprofile entirely. */
  | { kind: "override"; envVar: string }
  /** A profile's token is exported and live in this shell. */
  | { kind: "active"; profile: string; viaLink: boolean; linkMismatch: string | null }
  /** A token is exported but belongs to no ccprofile profile. */
  | { kind: "foreign" }
  /** This directory links a profile, but no token is exported in this shell. */
  | { kind: "link-inactive"; profile: string }
  /** No token and no link: Claude Code falls back to the /login session. */
  | { kind: "none" };

interface ClassifyInput {
  overrideVar: string | undefined;
  exportedToken: string | undefined;
  linkName: string | null;
  linkIsKnown: boolean;
  matchedProfile: string | null;
}

/**
 * Pure resolution of "who am I running as" from the local signals, mirroring
 * Claude Code's own precedence: an override env var wins; otherwise the
 * exported ANTHROPIC_AUTH_TOKEN decides; with no token, a directory link is
 * merely configured (not active) and bare shells use /login.
 */
export function classifyActiveAccount(input: ClassifyInput): ActiveAccount {
  if (input.overrideVar !== undefined) {
    return { kind: "override", envVar: input.overrideVar };
  }
  if (input.exportedToken === undefined || input.exportedToken === "") {
    if (input.linkName !== null && input.linkIsKnown) {
      return { kind: "link-inactive", profile: input.linkName };
    }
    return { kind: "none" };
  }
  if (input.matchedProfile === null) {
    return { kind: "foreign" };
  }
  return {
    kind: "active",
    profile: input.matchedProfile,
    viaLink: input.linkName === input.matchedProfile,
    linkMismatch:
      input.linkName !== null && input.linkName !== input.matchedProfile ? input.linkName : null,
  };
}

function printResult(result: ActiveAccount, config: Config): number {
  switch (result.kind) {
    case "override":
      console.log(
        fail(`${result.envVar} is set — Claude Code ignores ccprofile routing and uses it instead.`),
      );
      return 1;
    case "active": {
      const email = config.profiles[result.profile]?.email;
      console.log(`${cyan(bold(result.profile))}${email ? `  ${dim(`(${email})`)}` : ""}`);
      const sources = result.viaLink
        ? [".envrc link", "ANTHROPIC_AUTH_TOKEN exported"]
        : ["ANTHROPIC_AUTH_TOKEN exported"];
      console.log(dim(`  source: ${sources.join(" · ")}`));
      if (result.linkMismatch !== null) {
        console.log(
          warn(
            `  This directory links "${result.linkMismatch}", but the exported token is "${result.profile}". Run: direnv reload`,
          ),
        );
      }
      return 0;
    }
    case "foreign":
      console.log(
        warn("An ANTHROPIC_AUTH_TOKEN is exported, but it matches no ccprofile profile."),
      );
      console.log(dim("  It was likely set manually or by another tool."));
      return 0;
    case "link-inactive":
      console.log(
        warn(`This directory links profile ${bold(result.profile)}, but no token is exported here.`),
      );
      console.log(dim("  Run: direnv reload  (or re-enter the directory) to activate it."));
      return 1;
    case "none":
      console.log(
        ok(dim("No ccprofile account active — Claude Code uses your /login (subscription) session.")),
      );
      return 0;
  }
}

function readCwdLink(): string | null {
  const envrcPath = join(resolve(process.cwd()), ".envrc");
  if (!existsSync(envrcPath)) return null;
  try {
    return parseLinkedProfile(readFileSync(envrcPath, "utf8"));
  } catch {
    return null;
  }
}

/** Finds the profile whose stored Keychain token equals the exported one. */
async function findProfileByToken(config: Config, token: string): Promise<string | null> {
  const keychain = new Keychain();
  for (const [name, profile] of Object.entries(config.profiles)) {
    const stored = await keychain.getToken(profile.keychain.service, profile.keychain.account);
    if (stored !== null && stored === token) return name;
  }
  return null;
}
