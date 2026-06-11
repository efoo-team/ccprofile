import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../lib/config.js";
import { renderBlock, upsertBlock } from "../lib/envrc.js";
import { bold, cyan, dim, ok, warn } from "../lib/format.js";

export async function linkCommand(argv: string[]): Promise<number> {
  const { positionals } = parseArgs({ args: argv, allowPositionals: true, options: {} });

  const name = positionals[0];
  if (!name) {
    console.error("Usage: ccprofile link <profile> [dir]");
    return 1;
  }
  const dir = resolve(positionals[1] ?? process.cwd());

  const config = loadConfig();
  const profile = config.profiles[name];
  if (!profile) {
    console.error(`Profile "${name}" does not exist. Create it with: ccprofile add ${name}`);
    return 1;
  }
  if (!existsSync(dir)) {
    console.error(`Directory does not exist: ${dir}`);
    return 1;
  }

  const envrcPath = join(dir, ".envrc");
  const current = existsSync(envrcPath) ? readFileSync(envrcPath, "utf8") : "";
  const block = renderBlock(name, profile.keychain.service, profile.keychain.account);
  writeFileSync(envrcPath, upsertBlock(current, block));

  console.log(ok(`${bold(dir)} now routes Claude Code to profile ${bold(name)}${profile.email ? dim(` (${profile.email})`) : ""}.`));

  const allow = spawnSync("direnv", ["allow", dir], { stdio: "pipe" });
  if (allow.error) {
    console.log(warn("direnv is not installed; the .envrc was written but will not load automatically."));
    console.log(`  Install it with ${cyan("brew install direnv")} and add the shell hook (fish: ${cyan("direnv hook fish | source")}).`);
  } else if (allow.status !== 0) {
    console.log(warn(`\`direnv allow\` failed: ${allow.stderr.toString().trim()}`));
    return 1;
  } else {
    console.log(ok("direnv allow completed. Entering the directory activates the token."));
  }
  console.log(dim(`Tip: add .envrc to the project's .gitignore (paths are machine-local).`));
  return 0;
}
