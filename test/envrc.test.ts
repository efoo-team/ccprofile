import { describe, expect, it } from "vitest";
import {
  parseLinkedProfile,
  removeBlock,
  renderBlock,
  upsertBlock,
} from "../src/lib/envrc.js";

const block = renderBlock("work", "ccprofile", "work");

describe("renderBlock", () => {
  it("generates a self-contained export reading from the Keychain", () => {
    expect(block).toContain("# >>> ccprofile managed >>>");
    expect(block).toContain("# profile: work");
    expect(block).toContain(
      `_ccprofile_token="$(security find-generic-password -w -s 'ccprofile' -a 'work' 2>/dev/null)"`,
    );
    expect(block).toContain(`export ANTHROPIC_AUTH_TOKEN="$_ccprofile_token"`);
    expect(block).toContain("unset _ccprofile_token");
    expect(block).toContain("# <<< ccprofile managed <<<");
    expect(block.endsWith("\n")).toBe(true);
  });
});

describe("upsertBlock", () => {
  it("returns just the block for empty content", () => {
    expect(upsertBlock("", block)).toBe(block);
  });

  it("appends after existing user content with a separator", () => {
    const result = upsertBlock("export FOO=bar\n", block);
    expect(result.startsWith("export FOO=bar\n")).toBe(true);
    expect(result).toContain("# profile: work");
  });

  it("replaces an existing managed block instead of duplicating it", () => {
    const withOld = upsertBlock("export FOO=bar\n", renderBlock("personal", "ccprofile", "personal"));
    const result = upsertBlock(withOld, block);
    expect(result).toContain("# profile: work");
    expect(result).not.toContain("# profile: personal");
    expect(result.match(/>>> ccprofile managed >>>/g)).toHaveLength(1);
  });
});

describe("removeBlock", () => {
  it("removes the managed block and reports removal", () => {
    const content = upsertBlock("export FOO=bar\n", block);
    const { content: next, removed } = removeBlock(content);
    expect(removed).toBe(true);
    expect(next).not.toContain("ccprofile managed");
    expect(next).toContain("export FOO=bar");
  });

  it("reports removed=false when no block exists", () => {
    const { removed } = removeBlock("export FOO=bar\n");
    expect(removed).toBe(false);
  });
});

describe("parseLinkedProfile", () => {
  it("extracts the profile name from a managed block", () => {
    expect(parseLinkedProfile(upsertBlock("", block))).toBe("work");
  });

  it("returns null when no block exists", () => {
    expect(parseLinkedProfile("export FOO=bar\n")).toBeNull();
  });
});
