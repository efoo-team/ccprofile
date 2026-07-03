# ccprofile — installation guide for AI agents

You are an AI coding agent installing **ccprofile** for your user. Follow the
steps in order. Steps marked **[ASK USER]** need a human decision or a human
action — ask, and wait for the answer. Never perform browser logins yourself,
and never ask the user to paste secret tokens into the chat.

**Language:** talk to the user in the language they are most comfortable with —
match the language they have been using in the conversation (or their system
locale if unclear). This guide being in English does not mean the conversation
should be. Keep commands, file paths, and error messages verbatim.

## What you are installing

ccprofile lets the user run **multiple Claude Code accounts in parallel**, one
per project directory. It stores one long-lived OAuth token per account in the
macOS Keychain and writes a self-contained `.envrc` per project; direnv exports
`ANTHROPIC_AUTH_TOKEN` on directory entry, which outranks the normal
`/login` in Claude Code's auth precedence. Directories without a link fall back
to the user's normal login. There is no global "active account" — nothing to
switch, nothing to corrupt.

## 1. Preflight checks

Run and verify:

```sh
uname -s            # must be Darwin (macOS only — Keychain backend)
node --version      # must be >= 20
claude --version    # Claude Code must be installed
direnv version     # required for automatic activation
```

- If `direnv` is missing: **[ASK USER]** whether to install it (`brew install direnv`).
- Check the direnv hook for the user's shell (`echo $SHELL`):
  - fish: look for `direnv hook fish` in `~/.config/fish/config.fish` or `~/.config/fish/conf.d/*.fish`
  - zsh: `eval "$(direnv hook zsh)"` in `~/.zshrc`
  - bash: `eval "$(direnv hook bash)"` in `~/.bashrc`
- If the hook is missing, show the user the exact line you intend to append and
  **[ASK USER]** for consent before editing their shell config.

## 2. Install

```sh
npm install -g @efoo/ccprofile
ccprofile --version    # verify
```

Use the global install, not npx: shell completion and the `.envrc` helper
lookup both expect a `ccprofile` command on PATH.

## 3. [ASK USER] Shell completion (optional)

Ask the user: *"Set up tab completion for ccprofile (subcommands and profile
names)?"* If yes, run the line matching their shell:

```sh
# fish
ccprofile completion fish > ~/.config/fish/completions/ccprofile.fish
# zsh
ccprofile completion zsh > "${fpath[1]}/_ccprofile"
# bash
echo 'eval "$(ccprofile completion bash)"' >> ~/.bashrc
```

## 4. Register account profiles — the human must do this part

Token issuance uses `claude setup-token`, which requires an interactive
**browser OAuth flow** and a hidden token paste. You cannot do this; the user
must run it in their own terminal:

```sh
ccprofile add work --email user@example.com
```

Before they run it, tell the user these two things — they matter:

1. **The browser decides the account.** The token belongs to whichever account
   is logged into claude.ai in their browser at that moment. They should log
   into the intended account first (repeat per profile, e.g. `work`, `personal`).
2. A Claude **Pro/Max/Team/Enterprise subscription** is required.

When they report back, verify with `ccprofile list` (expect `stored` and an
expiry around 364d for each profile).

## 5. Link project directories

**[ASK USER]** which directories should route to which profile, then for each:

```sh
ccprofile link <profile> <directory>
```

This writes a managed block into `<directory>/.envrc` and runs `direnv allow`.
Notes to pass on:

- The routing applies to the directory **and everything below it**.
- `.envrc` is machine-local — add it to the project's `.gitignore` if it isn't.

## 6. Verify

```sh
ccprofile doctor
```

Everything should be ✓ — doctor also probes the server to confirm each token
is live (not revoked). Then have the user confirm end-to-end: open a terminal,
`cd` into a linked directory (direnv should print `export +ANTHROPIC_AUTH_TOKEN`),
run `claude`, and check `/status` shows `Auth token: ANTHROPIC_AUTH_TOKEN`.

## Limitations you must tell the user about

These come from `claude setup-token` tokens being deliberately inference-only
(full list: README → Limitations):

- **Account identity cannot be introspected** from the token (no whoami). To be
  sure which account a profile is, verify once: send a couple of prompts from
  the linked directory and check on claude.ai (web) that the intended account's
  usage moved.
- The `/status` Usage tab shows no plan utilization in token sessions.
- Remote Control is unavailable in linked directories because Claude Code
  treats `ANTHROPIC_AUTH_TOKEN` sessions as API-key authentication.
- Tokens last up to 1 year but can be revoked earlier (password change,
  logout-all). `ccprofile doctor` detects this — suggest running it when
  authentication starts failing.
- direnv only affects shell-launched processes; GUI-launched apps bypass the
  routing.
- Bedrock / Vertex / Foundry provider env vars silently override the routing —
  `doctor` flags them.

## Command reference

| Command | Purpose |
| --- | --- |
| `ccprofile add <name> [--email <email>]` | Register a profile (human runs this) |
| `ccprofile list [--json]` | Profiles, token presence, expiry |
| `ccprofile link <name> [dir]` | Route a directory (default: cwd) |
| `ccprofile unlink [dir]` | Remove the routing |
| `ccprofile remove <name>` | Delete profile + Keychain token |
| `ccprofile doctor [dir] [--offline]` | Full diagnosis incl. server liveness probe |
| `ccprofile completion <fish\|zsh\|bash>` | Completion script |
