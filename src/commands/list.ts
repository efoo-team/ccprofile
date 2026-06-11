import { parseArgs } from "node:util";
import { daysRemaining, loadConfig } from "../lib/config.js";
import { Keychain, assertDarwin } from "../lib/keychain.js";
import { bold, describeExpiry, dim, red, table } from "../lib/format.js";

export async function listCommand(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { json: { type: "boolean", default: false } },
  });

  const config = loadConfig();
  const names = Object.keys(config.profiles).sort();

  if (values.json) {
    const out = names.map((name) => {
      const p = config.profiles[name]!;
      return {
        name,
        email: p.email ?? null,
        createdAt: p.createdAt,
        expiresAt: p.expiresAt,
        daysRemaining: daysRemaining(p.expiresAt),
        keychain: p.keychain,
      };
    });
    console.log(JSON.stringify(out, null, 2));
    return 0;
  }

  if (names.length === 0) {
    console.log(`No profiles yet. Create one with ${bold("ccprofile add <name>")}.`);
    return 0;
  }

  assertDarwin();
  const keychain = new Keychain();
  const rows: string[][] = [
    [bold("NAME"), bold("EMAIL"), bold("TOKEN"), bold("EXPIRY")],
  ];
  for (const name of names) {
    const p = config.profiles[name]!;
    const present = await keychain.hasEntry(p.keychain.service, p.keychain.account);
    rows.push([
      name,
      p.email ?? dim("-"),
      present ? "stored" : red("missing"),
      describeExpiry(daysRemaining(p.expiresAt), config.settings.expiryWarningDays),
    ]);
  }
  console.log(table(rows));
  return 0;
}
