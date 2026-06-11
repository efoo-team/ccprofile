const BEGIN = "# >>> ccprofile managed >>>";
const END = "# <<< ccprofile managed <<<";

const BLOCK_RE = new RegExp(
  `${escapeRe(BEGIN)}[\\s\\S]*?${escapeRe(END)}\\n?`,
);

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The generated block is self-contained on purpose: direnv evaluates .envrc
 * on every directory entry, so it must not depend on node/npx being invoked.
 */
export function renderBlock(profile: string, service: string, account: string): string {
  return [
    BEGIN,
    `# profile: ${profile}`,
    `export CLAUDE_CODE_OAUTH_TOKEN="$(security find-generic-password -w -s '${service}' -a '${account}' 2>/dev/null)"`,
    END,
    "",
  ].join("\n");
}

export function upsertBlock(content: string, block: string): string {
  if (BLOCK_RE.test(content)) {
    return content.replace(BLOCK_RE, block);
  }
  if (content.trim() === "") return block;
  const sep = content.endsWith("\n") ? "\n" : "\n\n";
  return `${content}${sep}${block}`;
}

export function removeBlock(content: string): { content: string; removed: boolean } {
  if (!BLOCK_RE.test(content)) {
    return { content, removed: false };
  }
  const next = content.replace(BLOCK_RE, "").replace(/\n{3,}/g, "\n\n");
  return { content: next, removed: true };
}

export function parseLinkedProfile(content: string): string | null {
  const match = BLOCK_RE.exec(content);
  if (!match) return null;
  const inner = /^# profile: (.+)$/m.exec(match[0]);
  return inner?.[1]?.trim() ?? null;
}
