import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { daysRemaining, loadConfig } from "../lib/config.js";
import { parseLinkedProfile } from "../lib/envrc.js";
import { Keychain } from "../lib/keychain.js";
import { probeToken } from "../lib/probe.js";
import { bold, fail, ok, warn } from "../lib/format.js";

/**
 * Env vars that outrank CLAUDE_CODE_OAUTH_TOKEN in Claude Code's documented
 * authentication precedence. If any is set, ccprofile routing is silently
 * bypassed — that is the failure mode this command exists to catch.
 */
const OVERRIDING_ENV_VARS = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
];

export async function doctorCommand(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { offline: { type: "boolean", default: false } },
  });
  const dir = resolve(positionals[0] ?? process.cwd());
  let problems = 0;
  let warnings = 0;

  if (process.platform !== "darwin") {
    console.log(fail("Not macOS: ccprofile's Keychain backend is unavailable on this platform."));
    return 1;
  }
  console.log(ok("Platform: macOS (Keychain backend available)"));

  const claude = spawnSync("claude", ["--version"], { stdio: "pipe" });
  if (claude.error || claude.status !== 0) {
    console.log(warn("`claude` CLI not found. `ccprofile add` cannot launch setup-token for you."));
    warnings += 1;
  } else {
    console.log(ok(`Claude Code: ${claude.stdout.toString().trim()}`));
  }

  const direnv = spawnSync("direnv", ["version"], { stdio: "pipe" });
  if (direnv.error || direnv.status !== 0) {
    console.log(fail("direnv not found. Linked directories will not activate tokens automatically."));
    console.log("  Install: brew install direnv  /  fish hook: direnv hook fish | source");
    problems += 1;
  } else {
    console.log(ok(`direnv: ${direnv.stdout.toString().trim()}`));
  }

  for (const envVar of OVERRIDING_ENV_VARS) {
    if (process.env[envVar] !== undefined) {
      console.log(fail(`${envVar} is set: it overrides CLAUDE_CODE_OAUTH_TOKEN and bypasses ccprofile routing.`));
      problems += 1;
    }
  }

  const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  const settingsPath = join(claudeConfigDir, "settings.json");
  if (existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
      if (settings.apiKeyHelper !== undefined) {
        console.log(fail(`apiKeyHelper is configured in ${settingsPath}: it overrides CLAUDE_CODE_OAUTH_TOKEN.`));
        problems += 1;
      }
    } catch {
      console.log(warn(`Could not parse ${settingsPath}.`));
      warnings += 1;
    }
  }

  const config = loadConfig();
  const keychain = new Keychain();
  for (const [name, profile] of Object.entries(config.profiles)) {
    const present = await keychain.hasEntry(profile.keychain.service, profile.keychain.account);
    if (!present) {
      console.log(fail(`Profile "${name}": Keychain entry missing. Re-run: ccprofile add ${name} --force`));
      problems += 1;
      continue;
    }
    const days = daysRemaining(profile.expiresAt);
    if (days < 0) {
      console.log(fail(`Profile "${name}": token recorded as expired ${-days}d ago. Re-issue with claude setup-token.`));
      problems += 1;
    } else if (days <= config.settings.expiryWarningDays) {
      console.log(warn(`Profile "${name}": token expires in ${days}d.`));
      warnings += 1;
    } else {
      console.log(ok(`Profile "${name}": token stored, expires in ${days}d.`));
    }

    if (values.offline) continue;
    const token = await keychain.getToken(profile.keychain.service, profile.keychain.account);
    if (token === null) continue;
    const live = await probeToken(token);
    if (live.status === "alive") {
      if (live.email !== undefined && profile.email !== undefined && live.email !== profile.email) {
        console.log(fail(`Profile "${name}": server says the token belongs to ${live.email}, but config records ${profile.email}.`));
        problems += 1;
      } else {
        console.log(ok(`Profile "${name}": token is live on the server${live.email ? ` (account: ${live.email})` : ""}.`));
      }
    } else if (live.status === "invalid") {
      console.log(fail(`Profile "${name}": token rejected by the server (revoked or expired early). Re-issue with: ccprofile add ${name} --force`));
      problems += 1;
    } else {
      console.log(warn(`Profile "${name}": liveness check inconclusive (${live.detail}). Use --offline to skip.`));
      warnings += 1;
    }
  }

  const envrcPath = join(dir, ".envrc");
  if (existsSync(envrcPath)) {
    const linked = parseLinkedProfile(readFileSync(envrcPath, "utf8"));
    if (linked === null) {
      console.log(ok(`${envrcPath} exists but has no ccprofile block (not managed here).`));
    } else if (config.profiles[linked]) {
      console.log(ok(`${bold(dir)} is linked to profile "${linked}".`));
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
