import { parseArgs } from "node:util";
import { loadConfig, saveConfig } from "../lib/config.js";
import { Keychain, assertDarwin } from "../lib/keychain.js";
import { bold, ok, warn } from "../lib/format.js";
import { confirm } from "../lib/prompt.js";

export async function removeCommand(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { force: { type: "boolean", default: false } },
  });

  const name = positionals[0];
  if (!name) {
    console.error("Usage: ccprofile remove <name> [--force]");
    return 1;
  }

  const config = loadConfig();
  const profile = config.profiles[name];
  if (!profile) {
    console.error(`Profile "${name}" does not exist.`);
    return 1;
  }

  if (!values.force && process.stdin.isTTY) {
    const yes = await confirm(
      `Delete profile ${bold(name)} and its Keychain token?`,
      false,
    );
    if (!yes) return 1;
  }

  assertDarwin();
  const keychain = new Keychain();
  const deleted = await keychain.deleteToken(
    profile.keychain.service,
    profile.keychain.account,
  );
  if (!deleted) {
    console.log(warn("Keychain entry was not found (already removed?). Continuing."));
  }

  delete config.profiles[name];
  saveConfig(config);
  console.log(ok(`Profile ${bold(name)} removed.`));
  console.log(
    "Note: any .envrc still referencing this profile will now export an empty token; run `ccprofile unlink <dir>` there.",
  );
  return 0;
}
