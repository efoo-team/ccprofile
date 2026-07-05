# ccprofile

Per-directory Claude Code account routing via `ANTHROPIC_AUTH_TOKEN`, direnv, and the macOS Keychain.

`ccprofile` lets you run **multiple Claude Code accounts in parallel** — one per terminal, one per project — with zero manual switching. It never touches Claude Code's own Keychain entry, so there is no global "active account" to corrupt.

## 🤖 Install with an AI agent

Paste this prompt into Claude Code, Cursor, or any coding agent:

```
Install and configure ccprofile by following the instructions here:
https://raw.githubusercontent.com/efoo-team/ccprofile/main/docs/install-for-agents.md
```

The agent will check prerequisites (direnv, hooks), install the CLI, ask
whether you want shell completion, and walk you through registering accounts —
only the browser OAuth step needs your hands.

## Why

Claude Code stores its OAuth credentials in a single macOS Keychain entry, shared across every `CLAUDE_CONFIG_DIR` profile ([#20553](https://github.com/anthropics/claude-code/issues/20553)). Switcher-style tools work around this by swapping that entry in place — which breaks down the moment two sessions with different accounts run at the same time (in-session token refresh writes the old account back).

`ccprofile` takes the declarative route instead:

- Each account's **long-lived OAuth token** (`claude setup-token`, valid ~1 year) is stored in the Keychain under ccprofile's own namespace — one entry per profile, no sharing, no swapping.
- `ccprofile link` writes a **self-contained `.envrc`** that exports the token as `ANTHROPIC_AUTH_TOKEN` straight from the Keychain. direnv activates it when you enter the directory. No node/npx in the hot path.
- `ANTHROPIC_AUTH_TOKEN` outranks the stored login in Claude Code's [documented auth precedence](https://code.claude.com/docs/en/authentication#authentication-precedence), so linked directories route to their account and everywhere else falls back to your normal `/login`.

Auth state lives in each process's environment — parallel sessions cannot interfere with each other by construction.

## Requirements

- macOS (tokens are stored in the Keychain)
- [Claude Code](https://code.claude.com) with a Pro / Max / Team / Enterprise subscription (`claude setup-token` requires one)
- [direnv](https://direnv.net) — `brew install direnv` + the shell hook (fish: `direnv hook fish | source`)
- Node.js >= 20 (only for running ccprofile itself)

## Install

```sh
npm install -g @efoo/ccprofile   # provides the `ccprofile` command
# or run ad hoc:
npx @efoo/ccprofile --help
```

## Quick start

```sh
# 1. Register an account (launches `claude setup-token`, stores the token in the Keychain)
ccprofile add work --email you@company.example

# 2. Route a project to it — run inside the project directory…
cd ~/src/my-project
ccprofile link work

#    …or point at a directory from anywhere:
ccprofile link work ~/src/my-project

# 3. Done — any claude launched in that directory (and below) runs as "work"
claude        # /status shows "Auth token: ANTHROPIC_AUTH_TOKEN"
```

Repeat with `ccprofile add personal` etc. Different terminals in different directories run different accounts concurrently.

### Checking status

```sh
ccprofile whoami   # which account does *this* shell/directory resolve to? (instant, no network)
ccprofile usage    # per-account plan utilization + reset times, straight from claude.ai
```

`ccprofile whoami` answers "who am I running as here?" from local signals only, in
Claude Code's own precedence order: a provider override
(`CLAUDE_CODE_USE_{BEDROCK,VERTEX,FOUNDRY}`) wins first if set, otherwise the
exported `ANTHROPIC_AUTH_TOKEN` matched against your registered profiles, then the
directory's `.envrc` link — so it returns immediately. `ccprofile usage` decrypts your Chrome claude.ai session cookies
to fetch the real 5-hour / weekly / Fable-weekly utilization for every signed-in
account, ordered by whichever weekly limit resets soonest — without opening or
switching the browser (you just need to be signed in to claude.ai in Chrome).

## Commands

| Command | Description |
| --- | --- |
| `ccprofile add <name>` | Register a profile. Flags: `--email`, `--expires-at <iso>`, `--token <token>`, `--force` |
| `ccprofile list [--json]` | Profiles with token presence and expiry countdown |
| `ccprofile link <name> [dir]` | Write the managed `.envrc` block and `direnv allow` |
| `ccprofile unlink [dir]` | Remove the managed block (deletes `.envrc` if nothing else remains) |
| `ccprofile whoami` | Show which account this shell/directory resolves to right now — instant, no probes |
| `ccprofile token <name>` | Print the stored token to stdout (for scripting — handle with care) |
| `ccprofile remove <name>` | Delete the profile and its Keychain entry |
| `ccprofile doctor [dir]` | Diagnose provider overrides, stale/missing active token env, expiry, token liveness, usage limits (a minimal real inference per profile — fable first, haiku fallback), broken links. `--model <alias>` pins the probe model; `--offline` skips all server probes |
| `ccprofile usage [--json]` | Per-account plan utilization (5-hour, weekly, and Fable-weekly) with reset times, read from claude.ai via your Chrome session — no browser open or switch needed |
| `ccprofile completion <shell>` | Print a completion script for fish, zsh, or bash |

## Shell completion

Subcommands, flags, and registered profile names are all tab-completable:

```sh
# fish
ccprofile completion fish > ~/.config/fish/completions/ccprofile.fish

# zsh (place _ccprofile somewhere in $fpath, then restart zsh)
ccprofile completion zsh > "${fpath[1]}/_ccprofile"

# bash
echo 'eval "$(ccprofile completion bash)"' >> ~/.bashrc
```

`ccprofile link <TAB>` completes profile names by calling the hidden `ccprofile _profiles` helper, which only reads `~/.ccprofile/config.json` (never the Keychain).

## How it works

```
~/.ccprofile/config.json     profile metadata: email, expiry, keychain ref (no secrets)
macOS Keychain               service "ccprofile", one entry per profile (the secrets)
<project>/.envrc             managed block, generated by `ccprofile link`:

  # >>> ccprofile managed >>>
  # profile: work
  _ccprofile_token="$(security find-generic-password -w -s 'ccprofile' -a 'work' 2>/dev/null)"
  export ANTHROPIC_AUTH_TOKEN="$_ccprofile_token"
  unset _ccprofile_token
  # <<< ccprofile managed <<<
```

Notes:

- Tokens are written to the Keychain via `security -i` (stdin), so secrets never appear in `ps` output.
- The `.envrc` block is **self-contained**: direnv re-evaluates it on every directory entry, and it must stay fast and dependency-free. ccprofile is only needed for CRUD operations.
- Add `.envrc` to your project's `.gitignore` — it is machine-local.

## Limitations — the price of parallel accounts

ccprofile is built on `claude setup-token`, whose long-lived tokens are **deliberately scoped to inference only** ("for security reasons", per Claude Code's own `/doctor`). Several conveniences of a normal `/login` session are therefore unavailable in linked directories:

- **No account identity introspection.** The token cannot answer "whose token is this?" — the OAuth profile endpoint rejects it (`user:profile` scope missing, see [#11985](https://github.com/anthropics/claude-code/issues/11985)). The `--email` you record is a self-declared label, not verified. (`ccprofile whoami` still names the *active* account, but locally — by matching the exported token against your registered profiles, never asking the server.)
  *Verify identity once, at registration time:* make sure the browser is logged into the intended claude.ai account before `claude setup-token`, then send a couple of prompts from a linked directory and confirm on claude.ai (web) that the intended account's usage moved.
- **`/status` → Usage tab shows no plan utilization** in token-authenticated sessions (same scope restriction — the usage endpoint also requires `user:profile`). Check usage on claude.ai, or run `ccprofile doctor`: it detects exhausted usage limits the only way these tokens allow, by sending one minimal real inference per profile (fable first; on a fable limit it retries with haiku to tell "fable's separate budget exhausted" from "subscription window exhausted"). The probe consumes a negligible amount of quota and starts the 5-hour window of an idle profile; use `--offline` if you don't want that. To read *real* remaining quota without spending any, run `ccprofile usage`, which pulls per-account utilization straight from claude.ai using your signed-in Chrome session (no token probe, no window started).
- **Remote Control is unavailable** in linked directories. Claude Code treats `ANTHROPIC_AUTH_TOKEN` sessions as API-key authentication, while Remote Control requires claude.ai subscription authentication.
- **Tokens last up to 1 year but can die earlier** (password change, logout-all). The recorded expiry is a hint, not a guarantee — `ccprofile doctor` probes the server and tells live tokens apart from revoked ones.
- **Routing only applies to shell-launched processes.** direnv activates the token when a hooked shell enters the directory; apps launched outside a hooked shell (GUI launchers) bypass it.
- **Cloud provider auth wins silently.** Bedrock/Vertex/Foundry env vars outrank `ANTHROPIC_AUTH_TOKEN`; `ccprofile doctor` flags them.
- **macOS only** for now (the token store is the macOS Keychain).

## Development

```sh
pnpm install
pnpm build       # tsc → dist/
pnpm test        # vitest
node dist/index.js --help
```

## Release

Releases are automated with GitHub Actions + semantic-release.

- Merging to `main` runs CI and then `semantic-release`.
- Versioning is derived from Conventional Commits:
  - `fix:` / `perf:` -> patch release
  - `feat:` -> minor release
  - `feat!:` or `BREAKING CHANGE:` -> major release
  - `docs:` / `test:` / `ci:` / `chore:` -> no npm release
- Do not manually edit `package.json` version for normal releases; semantic-release updates the published package version.
- npm publishing uses trusted publishing (OIDC). Configure npm package `@efoo/ccprofile` with GitHub trusted publisher:
  - repository: `efoo-team/ccprofile`
  - workflow: `.github/workflows/release.yml`
  - environment: none

## License

MIT
