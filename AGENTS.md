# AGENTS.md — guide for AI agents working on this repository

This file is for AI coding agents (Claude Code, Codex, etc.) maintaining ccprofile.
README.md is the user-facing document; this one records the design decisions,
invariants, and external facts you must not re-litigate or accidentally break.

## What this tool is

ccprofile routes Claude Code sessions to different accounts **per directory**,
using three existing mechanisms instead of inventing new ones:

1. `claude setup-token` issues a long-lived, inference-only OAuth token per account.
2. The token is stored in the **macOS Keychain** under ccprofile's own namespace
   (service `ccprofile`, account = profile name).
3. `ccprofile link` writes a **self-contained managed block** into the target
   directory's `.envrc`; **direnv** exports `ANTHROPIC_AUTH_TOKEN` on entry.

Claude Code's documented auth precedence makes this work: `ANTHROPIC_AUTH_TOKEN`
(#2) outranks the stored `/login` credentials (#6), and everywhere without the
env var falls back to the normal login. See
<https://code.claude.com/docs/en/authentication#authentication-precedence>.

## Design invariants — do not break these

- **Declarative, never switch-style.** ccprofile must never mutate global state
  to change accounts (no writes to Claude Code's own Keychain entry
  `Claude Code-credentials`, ever). Parallel sessions with different accounts
  are the core use case; per-process env vars are the only safe carrier.
  Background: Claude Code shares one Keychain entry across all
  `CLAUDE_CONFIG_DIR` profiles (anthropics/claude-code#20553), and swap-style
  tools corrupt it under parallel use via in-session token refresh.
- **The `.envrc` block stays self-contained and node-free.** direnv evaluates
  `.envrc` on every directory entry; the hot path must call `security` directly.
  Never generate a block that invokes `ccprofile`, `node`, or `npx`.
- **The managed-block markers are a compatibility contract.** Existing user
  `.envrc` files contain `# >>> ccprofile managed >>>` / `# <<< ccprofile managed <<<`.
  Changing the markers breaks upsert/remove for every existing user.
- **Secrets live only in the Keychain.** Never write tokens to
  `~/.ccprofile/config.json` (metadata only: email label, dates, keychain ref),
  log output, or process argv. Keychain writes go through `security -i` with the
  command on **stdin** (argv leaks via `ps`), followed by a read-back verification.
- **The safe-charset rule is shared.** `SAFE_VALUE_RE` in `src/lib/keychain.ts`
  ([A-Za-z0-9._-]) is what makes unquoted interpolation into both the
  `security -i` batch parser and the generated `.envrc` safe. If you widen it,
  you must add real escaping in both places.
- **Zero runtime dependencies.** The CLI must start fast under `npx`. Build is
  plain `tsc` (ESM, Node >= 20); arg parsing is `node:util` `parseArgs`.

## External facts the code depends on (verified June 2026)

- `claude setup-token` requires a Pro/Max/Team/Enterprise subscription, prints a
  ~1-year token, and **does not save it anywhere** — ccprofile captures it.
- setup-token tokens are **inference-only by deliberate design** ("for security
  reasons", per Claude Code `/doctor`). Consequences:
  - No `user:profile` scope → the OAuth profile endpoint
    (`api.anthropic.com/api/oauth/profile`) returns `permission_error`.
    A "whoami" feature is **structurally impossible**; do not attempt one.
  - The usage endpoint (`api.anthropic.com/api/oauth/usage`, what `/usage`
    reads) is gated by the same `user:profile` scope: HTTP 403
    `permission_error` (verified 2026-07-04). Reading remaining quota without
    spending is **structurally impossible** — that is why doctor's usage probe
    performs a real minimal inference instead.
  - `src/lib/probe.ts` exploits this: `permission_error` mentioning "scope"
    proves the token authenticated → **alive**; `authentication_error`/401 →
    revoked. An HTTP 200 + email branch exists for graceful handling but is not
    expected to fire (it would require Anthropic reversing a security decision).
  - Related: anthropics/claude-code#11985 (open) is about *login* tokens losing
    the scope — a different problem; do not conflate.
- Tokens can be revoked before the recorded expiry (password change, logout-all).
  Recorded `expiresAt` is a hint; the doctor probe is the truth.
- fable has a separate usage budget (~50% of the plan, same 5h/1-week windows),
  and fable usage also counts against the shared haiku/sonnet/opus pool
  (owner-provided fact, July 2026). doctor's probe order exploits the nesting:
  fable OK ⇒ everything OK; fable limited → probe haiku to tell "fable budget
  exhausted" from "subscription window exhausted".
- The usage probe (`src/lib/usage.ts`) is **default-on and deliberately spends
  a tiny amount of quota**; it may also start an idle profile's 5-hour window.
  Both are accepted — the owner wants idle windows restarted as early as
  possible, so do not "optimize" this into an opt-in. `--offline` is the
  opt-out; `--model` pins the probe model. Never add `--fallback-model` to the
  probe invocation (it would silently succeed on another model and mask the
  limit). Claude Code's error strings are not a stable API: classification
  matches loosely and falls back to "unknown" (a warning), never a guess.
  doctor checks all profiles concurrently (wall time = slowest profile);
  each profile buffers its lines and blocks print in config order, and
  per-profile steps stay sequential (the haiku cascade depends on the fable
  result). checkProfile must never reject — a rejection before its print
  turn would be an unhandled promise rejection.
- Linked directories authenticate Claude Code with `ANTHROPIC_AUTH_TOKEN`.
  The generated block must keep exporting that variable.
- Remote Control is unavailable in linked directories because Claude Code
  treats `ANTHROPIC_AUTH_TOKEN` sessions as API-key authentication, while
  Remote Control requires claude.ai subscription authentication.
- Auth overrides: `CLAUDE_CODE_USE_{BEDROCK,VERTEX,FOUNDRY}` outrank
  `ANTHROPIC_AUTH_TOKEN`. `doctor` must keep checking them.

## Architecture map

```
src/index.ts            entry; lazy-imports commands; hidden `_profiles` helper
                        (prints profile names for shell completion; config-only)
src/commands/*.ts       one file per subcommand (add/list/link/unlink/token/
                        remove/doctor/completion)
src/lib/config.ts       ~/.ccprofile/config.json IO (CCPROFILE_DIR overrides for
                        tests), profile-name validation, expiry math
src/lib/keychain.ts     `security` wrapper; injectable Runner for tests
src/lib/envrc.ts        managed-block render/upsert/remove/parse (pure functions)
src/lib/probe.ts        server liveness probe (injectable fetch)
src/lib/usage.ts        usage-limit probe: one real `claude -p` ping (injectable runner)
src/lib/prompt.ts       hidden token paste, confirmations
src/lib/format.ts       ANSI + table helpers (no deps; respects NO_COLOR)
test/*.test.ts          vitest; keychain/probe are tested with injected fakes —
                        unit tests must not touch the real Keychain or network
```

## Workflow

```sh
pnpm install
pnpm build        # tsc → dist/   (bin: dist/index.js, shebang in src/index.ts)
pnpm test         # vitest
pnpm typecheck    # tsc --noEmit
node dist/index.js <cmd>          # run locally
npm install -g .                  # reinstall the global command after changes
```

When changing code, tests, package metadata, CI, or release configuration, run
`pnpm typecheck`, `pnpm test`, and `pnpm build` before reporting completion.

Manual smoke tests that touch the real Keychain should use a throwaway profile
name, an isolated `CCPROFILE_DIR=$(mktemp -d)`, and must clean up via
`ccprofile remove <name> --force`.

## Publishing

- Package name is `@efoo/ccprofile` (bin `ccprofile`). The unscoped name
  `ccprofile` is **not publishable**: npm blocks punctuation-only variants of
  the existing `cc-profile` package (an unrelated Claude Code tracing tool).
- Scoped packages need `npm publish --access public`.
- Releases are automated by `.github/workflows/release.yml` on pushes to
  `main`. semantic-release derives the version from Conventional Commits,
  creates the GitHub release/tag, and publishes to npm.
- Do not manually bump `package.json` for normal releases. Use commit types:
  `fix:` / `perf:` for patch, `feat:` for minor, and `!` or
  `BREAKING CHANGE:` only when a major release is intended.
- npm auth uses trusted publishing (OIDC), not a long-lived `NPM_TOKEN`.
  The npm package must be configured with trusted publisher
  `efoo-team/ccprofile`, workflow `.github/workflows/release.yml`, no
  environment.

## Possible future work (deliberate non-goals today)

- Linux/Windows backend (file-based secret store behind the `Keychain` interface).
- `CLAUDE_CONFIG_DIR` integration for per-account history isolation (compliance
  use cases). Settings sharing would then need symlinks; note the upstream bug
  where plugins hardcode `~/.claude`.
- Metadata-only edit command (today `add --force` re-registers the token too).
