import { describe, expect, it } from "vitest";
import { classifyActiveAccount } from "../src/commands/whoami.js";

const base = {
  overrideVar: undefined,
  exportedToken: undefined,
  linkName: null,
  linkIsKnown: false,
  matchedProfile: null,
} as const;

describe("classifyActiveAccount", () => {
  it("reports an override env var before anything else", () => {
    expect(
      classifyActiveAccount({
        ...base,
        overrideVar: "ANTHROPIC_API_KEY",
        exportedToken: "sk-ant-oat01-x",
        linkName: "work",
        linkIsKnown: true,
        matchedProfile: "work",
      }),
    ).toEqual({ kind: "override", envVar: "ANTHROPIC_API_KEY" });
  });

  it("resolves an exported token to its profile, flagging the matching link", () => {
    expect(
      classifyActiveAccount({
        ...base,
        exportedToken: "sk-ant-oat01-x",
        linkName: "work",
        linkIsKnown: true,
        matchedProfile: "work",
      }),
    ).toEqual({ kind: "active", profile: "work", viaLink: true, linkMismatch: null });
  });

  it("marks an exported token active even without a directory link", () => {
    expect(
      classifyActiveAccount({ ...base, exportedToken: "tok", matchedProfile: "personal" }),
    ).toEqual({ kind: "active", profile: "personal", viaLink: false, linkMismatch: null });
  });

  it("surfaces a link/token mismatch (stale direnv)", () => {
    expect(
      classifyActiveAccount({
        ...base,
        exportedToken: "tok",
        linkName: "work",
        linkIsKnown: true,
        matchedProfile: "personal",
      }),
    ).toEqual({ kind: "active", profile: "personal", viaLink: false, linkMismatch: "work" });
  });

  it("calls an unrecognized exported token foreign", () => {
    expect(classifyActiveAccount({ ...base, exportedToken: "manual-token" })).toEqual({
      kind: "foreign",
    });
  });

  it("treats an empty exported token as no token", () => {
    expect(
      classifyActiveAccount({ ...base, exportedToken: "", linkName: "work", linkIsKnown: true }),
    ).toEqual({ kind: "link-inactive", profile: "work" });
  });

  it("reports a configured-but-inactive link when no token is exported", () => {
    expect(
      classifyActiveAccount({ ...base, linkName: "work", linkIsKnown: true }),
    ).toEqual({ kind: "link-inactive", profile: "work" });
  });

  it("falls back to /login when there is no token and no known link", () => {
    expect(classifyActiveAccount(base)).toEqual({ kind: "none" });
    // A link naming an unknown profile is not an active default either.
    expect(
      classifyActiveAccount({ ...base, linkName: "ghost", linkIsKnown: false }),
    ).toEqual({ kind: "none" });
  });
});
