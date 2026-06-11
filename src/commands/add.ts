import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import {
  KEYCHAIN_SERVICE,
  computeExpiresAt,
  loadConfig,
  saveConfig,
  validateProfileName,
} from "../lib/config.js";
import { Keychain, assertDarwin } from "../lib/keychain.js";
import { askHidden, confirm } from "../lib/prompt.js";
import { bold, cyan, dim, ok, warn } from "../lib/format.js";

const TOKEN_PREFIX = "sk-ant-";

export async function addCommand(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      email: { type: "string" },
      "expires-at": { type: "string" },
      token: { type: "string" },
      force: { type: "boolean", default: false },
      "no-setup": { type: "boolean", default: false },
    },
  });

  const name = positionals[0];
  if (!name) {
    console.error("Usage: ccprofile add <name> [--email <email>] [--expires-at <ISO date>]");
    return 1;
  }
  validateProfileName(name);
  assertDarwin();

  const config = loadConfig();
  if (config.profiles[name] && !values.force) {
    console.error(
      `Profile "${name}" already exists. Use --force to overwrite its token and metadata.`,
    );
    return 1;
  }

  let token = values.token;
  if (!token) {
    console.log(
      `A long-lived OAuth token is issued by ${bold("claude setup-token")} (requires a Claude subscription).`,
    );
    if (!values["no-setup"] && process.stdin.isTTY) {
      if (await confirm("Run `claude setup-token` now?")) {
        const result = spawnSync("claude", ["setup-token"], { stdio: "inherit" });
        if (result.error) {
          console.error(
            "Could not launch `claude`. Install Claude Code first, or run `claude setup-token` manually.",
          );
          return 1;
        }
      }
    }
    token = await askHidden("Paste the token (input is hidden): ");
  }

  if (token === "") {
    console.error("No token provided. Aborting.");
    return 1;
  }
  if (!token.startsWith(TOKEN_PREFIX)) {
    console.log(
      warn(`The token does not start with "${TOKEN_PREFIX}", which is unexpected.`),
    );
    if (process.stdin.isTTY && !(await confirm("Store it anyway?", false))) {
      return 1;
    }
  }

  const keychain = new Keychain();
  await keychain.setToken(KEYCHAIN_SERVICE, name, token);

  const now = new Date();
  const expiresAt = values["expires-at"]
    ? new Date(values["expires-at"]).toISOString()
    : computeExpiresAt(now);

  config.profiles[name] = {
    ...(values.email ? { email: values.email } : {}),
    createdAt: now.toISOString(),
    expiresAt,
    keychain: { service: KEYCHAIN_SERVICE, account: name },
  };
  saveConfig(config);

  console.log(ok(`Profile ${bold(name)} saved (Keychain: ${KEYCHAIN_SERVICE}/${name}).`));
  console.log(dim(`Token recorded as expiring at ${expiresAt} (setup-token issues 1-year tokens).`));
  console.log(`\nNext: route a project directory to this account:\n  ${cyan(`ccprofile link ${name} <project-dir>`)}`);
  return 0;
}
