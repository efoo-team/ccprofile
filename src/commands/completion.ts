import { parseArgs } from "node:util";

export const SUBCOMMANDS: Array<{ name: string; description: string }> = [
  { name: "add", description: "Register a profile (runs claude setup-token)" },
  { name: "list", description: "Show profiles, token presence, and expiry" },
  { name: "link", description: "Route a directory to a profile" },
  { name: "unlink", description: "Remove the managed .envrc block" },
  { name: "token", description: "Print the stored token" },
  { name: "remove", description: "Delete a profile and its Keychain entry" },
  { name: "doctor", description: "Diagnose configuration problems" },
  { name: "completion", description: "Print a shell completion script" },
  { name: "help", description: "Show help" },
];

const names = SUBCOMMANDS.map((s) => s.name).join(" ");

export function renderFishCompletion(): string {
  const subcommandLines = SUBCOMMANDS.map(
    (s) =>
      `complete -c ccprofile -n __fish_use_subcommand -a ${s.name} -d "${s.description}"`,
  ).join("\n");

  return `# ccprofile fish completion
# Install: ccprofile completion fish > ~/.config/fish/completions/ccprofile.fish

function __ccprofile_pos_eq
    test (count (commandline -opc)) -eq $argv[1]
end

complete -c ccprofile -f

${subcommandLines}

# Profile name arguments
complete -c ccprofile -n "__fish_seen_subcommand_from link" -n "__ccprofile_pos_eq 2" -a "(command ccprofile _profiles 2>/dev/null)"
complete -c ccprofile -n "__fish_seen_subcommand_from remove token" -n "__ccprofile_pos_eq 2" -a "(command ccprofile _profiles 2>/dev/null)"

# Directory arguments
complete -c ccprofile -n "__fish_seen_subcommand_from link" -n "__ccprofile_pos_eq 3" -F
complete -c ccprofile -n "__fish_seen_subcommand_from unlink doctor" -n "__ccprofile_pos_eq 2" -F

# completion <shell>
complete -c ccprofile -n "__fish_seen_subcommand_from completion" -n "__ccprofile_pos_eq 2" -a "fish zsh bash"

# Flags
complete -c ccprofile -n "__fish_seen_subcommand_from add" -l email -r -d "Account email (metadata)"
complete -c ccprofile -n "__fish_seen_subcommand_from add" -l expires-at -r -d "Override recorded expiry (ISO date)"
complete -c ccprofile -n "__fish_seen_subcommand_from add" -l token -r -d "Provide the token directly"
complete -c ccprofile -n "__fish_seen_subcommand_from add" -l force -d "Overwrite an existing profile"
complete -c ccprofile -n "__fish_seen_subcommand_from add" -l no-setup -d "Skip launching claude setup-token"
complete -c ccprofile -n "__fish_seen_subcommand_from list" -l json -d "JSON output"
complete -c ccprofile -n "__fish_seen_subcommand_from remove" -l force -d "Skip confirmation"
complete -c ccprofile -n __fish_use_subcommand -l help -d "Show help"
complete -c ccprofile -n __fish_use_subcommand -l version -d "Show version"
`;
}

export function renderZshCompletion(): string {
  const describeLines = SUBCOMMANDS.map(
    (s) => `    '${s.name}:${s.description}'`,
  ).join("\n");

  return `#compdef ccprofile
# ccprofile zsh completion
# Install: ccprofile completion zsh > "\${fpath[1]}/_ccprofile" (then restart zsh)

_ccprofile() {
  local -a subcmds
  subcmds=(
${describeLines}
  )
  if (( CURRENT == 2 )); then
    _describe 'command' subcmds
    return
  fi
  case "\${words[2]}" in
    link)
      if (( CURRENT == 3 )); then
        compadd -- \$(ccprofile _profiles 2>/dev/null)
      else
        _files -/
      fi
      ;;
    remove|token)
      (( CURRENT == 3 )) && compadd -- \$(ccprofile _profiles 2>/dev/null)
      ;;
    unlink|doctor)
      _files -/
      ;;
    completion)
      compadd fish zsh bash
      ;;
    add)
      compadd -- --email --expires-at --token --force --no-setup
      ;;
    list)
      compadd -- --json
      ;;
  esac
}

_ccprofile "\$@"
`;
}

export function renderBashCompletion(): string {
  return `# ccprofile bash completion
# Install: ccprofile completion bash > /usr/local/etc/bash_completion.d/ccprofile
#          (or: eval "\$(ccprofile completion bash)" in ~/.bashrc)

_ccprofile() {
  local cur sub
  cur="\${COMP_WORDS[COMP_CWORD]}"
  sub="\${COMP_WORDS[1]}"
  if [ "\$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( \$(compgen -W "${names}" -- "\$cur") )
    return
  fi
  case "\$sub" in
    link)
      if [ "\$COMP_CWORD" -eq 2 ]; then
        COMPREPLY=( \$(compgen -W "\$(ccprofile _profiles 2>/dev/null)" -- "\$cur") )
      else
        COMPREPLY=( \$(compgen -d -- "\$cur") )
      fi ;;
    remove|token)
      [ "\$COMP_CWORD" -eq 2 ] && COMPREPLY=( \$(compgen -W "\$(ccprofile _profiles 2>/dev/null)" -- "\$cur") ) ;;
    unlink|doctor)
      COMPREPLY=( \$(compgen -d -- "\$cur") ) ;;
    completion)
      COMPREPLY=( \$(compgen -W "fish zsh bash" -- "\$cur") ) ;;
    add)
      COMPREPLY=( \$(compgen -W "--email --expires-at --token --force --no-setup" -- "\$cur") ) ;;
    list)
      COMPREPLY=( \$(compgen -W "--json" -- "\$cur") ) ;;
  esac
}

complete -F _ccprofile ccprofile
`;
}

export async function completionCommand(argv: string[]): Promise<number> {
  const { positionals } = parseArgs({ args: argv, allowPositionals: true, options: {} });
  const shell = positionals[0];

  switch (shell) {
    case "fish":
      process.stdout.write(renderFishCompletion());
      return 0;
    case "zsh":
      process.stdout.write(renderZshCompletion());
      return 0;
    case "bash":
      process.stdout.write(renderBashCompletion());
      return 0;
    default:
      console.error("Usage: ccprofile completion <fish|zsh|bash>");
      console.error("\nInstall (fish):");
      console.error("  ccprofile completion fish > ~/.config/fish/completions/ccprofile.fish");
      return 1;
  }
}
