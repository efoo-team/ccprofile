import { describe, expect, it } from "vitest";
import {
  SUBCOMMANDS,
  renderBashCompletion,
  renderFishCompletion,
  renderZshCompletion,
} from "../src/commands/completion.js";

const allNames = SUBCOMMANDS.map((s) => s.name);

describe("renderFishCompletion", () => {
  const script = renderFishCompletion();

  it("offers every subcommand at the first position", () => {
    for (const name of allNames) {
      expect(script).toContain(
        `complete -c ccprofile -n __fish_use_subcommand -a ${name}`,
      );
    }
  });

  it("completes profile names dynamically via the hidden helper", () => {
    expect(script).toContain("ccprofile _profiles");
    expect(script).toContain('__fish_seen_subcommand_from link');
    expect(script).toContain('__fish_seen_subcommand_from remove token');
  });

  it("falls back to file completion for directory arguments", () => {
    expect(script).toContain('__fish_seen_subcommand_from unlink doctor" -n "__ccprofile_pos_eq 2" -F');
  });
});

describe("renderZshCompletion", () => {
  const script = renderZshCompletion();

  it("starts with the compdef header", () => {
    expect(script.startsWith("#compdef ccprofile")).toBe(true);
  });

  it("lists every subcommand with a description", () => {
    for (const { name, description } of SUBCOMMANDS) {
      expect(script).toContain(`'${name}:${description}'`);
    }
  });

  it("escapes shell variables (no TS interpolation leaked)", () => {
    expect(script).toContain("${words[2]}");
    expect(script).not.toContain("undefined");
  });
});

describe("renderBashCompletion", () => {
  const script = renderBashCompletion();

  it("offers every subcommand at the first position", () => {
    for (const name of allNames) {
      expect(script).toContain(name);
    }
    expect(script).toContain(`compgen -W "${allNames.join(" ")}"`);
  });

  it("registers the completion function", () => {
    expect(script).toContain("complete -F _ccprofile ccprofile");
    expect(script).toContain("${COMP_WORDS[COMP_CWORD]}");
  });
});
