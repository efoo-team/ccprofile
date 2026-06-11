import { parseArgs } from "node:util";
import { loadConfig } from "../lib/config.js";
import { Keychain, assertDarwin } from "../lib/keychain.js";

export async function tokenCommand(argv: string[]): Promise<number> {
  const { positionals } = parseArgs({ args: argv, allowPositionals: true, options: {} });
  const name = positionals[0];
  if (!name) {
    console.error("Usage: ccprofile token <profile>");
    return 1;
  }

  const config = loadConfig();
  const profile = config.profiles[name];
  if (!profile) {
    console.error(`Profile "${name}" does not exist.`);
    return 1;
  }

  assertDarwin();
  const keychain = new Keychain();
  const token = await keychain.getToken(profile.keychain.service, profile.keychain.account);
  if (token === null) {
    console.error(`No Keychain entry for profile "${name}". Re-run: ccprofile add ${name} --force`);
    return 1;
  }
  process.stdout.write(`${token}\n`);
  return 0;
}
