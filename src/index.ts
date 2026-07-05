#!/usr/bin/env node
import { createRequire } from "node:module";
import { bold, cyan } from "./lib/format.js";

const require = createRequire(import.meta.url);

const HELP = `${bold("ccprofile")} — per-directory Claude Code account routing

Tokens live in the macOS Keychain; profile metadata lives in ~/.ccprofile/config.json.
Linked directories get a self-contained .envrc that direnv loads on entry, so
parallel sessions with different accounts never share mutable auth state.

${bold("Usage")}
  ccprofile <command> [options]

${bold("Commands")}
  add <name>              Register a profile (runs ${cyan("claude setup-token")}, stores the token)
      --email <email>     Attach the account email as metadata
      --expires-at <iso>  Override the recorded expiry (default: +365 days)
      --token <token>     Provide the token directly (skips prompts)
      --force             Overwrite an existing profile
  list [--json]           Show profiles, token presence, and expiry
  link <name> [dir]       Route a directory to a profile (writes .envrc, direnv allow)
  unlink [dir]            Remove the managed block from a directory's .envrc
  whoami                  Show which account this shell/directory resolves to,
                          instantly (no probes)
  token <name>            Print the stored token (for scripting; handle with care)
  remove <name> [--force] Delete a profile and its Keychain entry
  doctor [dir]            Diagnose overriding env vars, expiry, token liveness,
      --offline           usage limits (real inference probe), and broken links
      --model <alias>     --offline skips probes; --model pins the probe model
                          (default: fable, then haiku to isolate fable limits)
  usage [--json]          Show claude.ai usage per account: 5-hour, weekly, and
                          Fable-weekly percent + reset. Reads Chrome session
                          cookies — no browser open or switch required
  completion <shell>      Print a completion script (fish, zsh, bash)

${bold("Typical flow")}
  ccprofile add work --email you@company.example
  ccprofile link work ~/src/my-project
  cd ~/src/my-project && claude   # runs as "work" via ANTHROPIC_AUTH_TOKEN
`;

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);

  switch (command) {
    case "add":
      return (await import("./commands/add.js")).addCommand(rest);
    case "list":
    case "ls":
      return (await import("./commands/list.js")).listCommand(rest);
    case "remove":
    case "rm":
      return (await import("./commands/remove.js")).removeCommand(rest);
    case "link":
      return (await import("./commands/link.js")).linkCommand(rest);
    case "unlink":
      return (await import("./commands/unlink.js")).unlinkCommand(rest);
    case "whoami":
      return (await import("./commands/whoami.js")).whoamiCommand(rest);
    case "token":
      return (await import("./commands/token.js")).tokenCommand(rest);
    case "doctor":
      return (await import("./commands/doctor.js")).doctorCommand(rest);
    case "usage":
      return (await import("./commands/usage.js")).usageCommand(rest);
    case "completion":
      return (await import("./commands/completion.js")).completionCommand(rest);
    // Hidden helper for shell completions: prints profile names, one per line.
    case "_profiles": {
      const { loadConfig } = await import("./lib/config.js");
      for (const name of Object.keys(loadConfig().profiles).sort()) {
        console.log(name);
      }
      return 0;
    }
    case "--version":
    case "-v": {
      const pkg = require("../package.json") as { version: string };
      console.log(pkg.version);
      return 0;
    }
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return command === undefined ? 1 : 0;
    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(HELP);
      return 1;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
