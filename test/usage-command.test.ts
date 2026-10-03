import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountUsage } from "../src/lib/claudeai.js";

const mocks = vi.hoisted(() => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  parseProfiles: vi.fn(),
  readSessionCookies: vi.fn(),
  safeStorageKey: vi.fn(),
  fetchAccountUsage: vi.fn(),
  loadConfig: vi.fn(),
}));

vi.mock("node:fs", () => ({ existsSync: mocks.existsSync, readFileSync: mocks.readFileSync }));
vi.mock("../src/lib/keychain.js", () => ({ assertDarwin: vi.fn() }));
vi.mock("../src/lib/chrome.js", () => ({
  chromeUserDataDir: () => "/test/chrome",
  chromeUserAgent: () => "test-Chrome-UA",
  parseProfiles: mocks.parseProfiles,
  readSessionCookies: mocks.readSessionCookies,
  safeStorageKey: mocks.safeStorageKey,
}));
vi.mock("../src/lib/claudeai.js", () => ({
  NOT_SIGNED_IN: "not signed in to claude.ai",
  fetchAccountUsage: mocks.fetchAccountUsage,
}));
vi.mock("../src/lib/config.js", () => ({ loadConfig: mocks.loadConfig }));

import { usageCommand } from "../src/commands/usage.js";

const success = (email: string, resetsAt: string): AccountUsage => ({
  ok: true,
  email,
  report: {
    session: { percent: 62, resetsAt: null, severity: "normal" },
    weeklyAll: { percent: 53, resetsAt: new Date(resetsAt), severity: "warning" },
    fable: null,
  },
});

describe("usageCommand", () => {
  let output: string[];

  beforeEach(() => {
    vi.resetAllMocks();
    output = [];
    vi.spyOn(console, "log").mockImplementation((text: unknown) => output.push(String(text)));
    mocks.existsSync.mockReturnValue(true);
    mocks.readFileSync.mockReturnValue("{}");
    mocks.safeStorageKey.mockResolvedValue(Buffer.alloc(16));
    mocks.readSessionCookies.mockResolvedValue({ sessionKey: "test-session" });
    mocks.loadConfig.mockReturnValue({
      profiles: {
        near: { email: "near@example.com" },
        far: { email: "far@example.com" },
        failed: { email: "failed@example.com" },
      },
    });
  });

  function profiles(names: string[]): void {
    mocks.parseProfiles.mockReturnValue(names.map((name, index) => ({ dir: `Profile ${index}`, name })));
  }

  it("shows HTTP failures in the table while preserving successful usage and weekly-reset order", async () => {
    profiles(["Far Chrome", "Denied Chrome", "Near Chrome", "Unused Chrome"]);
    mocks.fetchAccountUsage
      .mockResolvedValueOnce(success("far@example.com", "2026-10-10T10:00:00Z"))
      .mockResolvedValueOnce({ ok: false, status: 403, detail: "HTTP 403: access denied by claude.ai", email: "failed@example.com" })
      .mockResolvedValueOnce(success("near@example.com", "2026-10-03T10:00:00Z"))
      .mockResolvedValueOnce({ ok: false, status: 0, detail: "not signed in to claude.ai" });

    expect(await usageCommand([])).toBe(1);
    expect(output).toHaveLength(1);
    const lines = output[0]!.split("\n");
    expect(lines[0]).toContain("STATUS");
    expect(lines[1]).toMatch(/near\s+near@example.com\s+Near Chrome\s+62%/);
    expect(lines[1]).toContain("OK");
    expect(lines[2]).toContain("far@example.com");
    expect(lines[3]).toMatch(/failed\s+failed@example.com\s+Denied Chrome\s+-\s+-\s+-\s+ERROR HTTP 403/);
    expect(output[0]).not.toContain("Unused Chrome");
    expect(output[0]).not.toContain("test-session");
  });

  it("prints the error table when all sessions are denied, without claiming no one is signed in", async () => {
    profiles(["Denied Chrome"]);
    mocks.fetchAccountUsage.mockResolvedValue({ ok: false, status: 403, detail: "HTTP 403: access denied by claude.ai" });
    expect(await usageCommand([])).toBe(1);
    expect(output[0]).toContain("failed@example.com");
    expect(output[0]).toContain("NO MATCH: matching Chrome session not detected");
    expect(output[1]).toContain("Other Chrome results");
    expect(output[2]).toContain("Denied Chrome");
    expect(output[2]).toContain("ERROR HTTP 403");
    expect(output[0]).not.toContain("No claude.ai sessions");
  });

  it("keeps cookie-read and network failures visible", async () => {
    profiles(["Broken DB Chrome", "Timeout Chrome"]);
    mocks.readSessionCookies
      .mockRejectedValueOnce(new Error("sqlite3 failed to read Chrome cookies"))
      .mockResolvedValueOnce({ sessionKey: "test-session" });
    mocks.fetchAccountUsage.mockResolvedValue({ ok: false, status: 0, detail: "request timed out" });
    expect(await usageCommand([])).toBe(1);
    expect(output[2]).toMatch(/Broken DB Chrome.*ERROR sqlite3 failed/);
    expect(output[2]).toMatch(/Timeout Chrome.*ERROR request timed out/);
  });

  it("shows registered profiles with no matched session, without claiming they are logged out", async () => {
    profiles(["Unused Chrome"]);
    mocks.fetchAccountUsage.mockResolvedValue({ ok: false, status: 0, detail: "not signed in to claude.ai" });
    expect(await usageCommand([])).toBe(0);
    expect(output[0]).toContain("failed@example.com");
    expect(output[0]).toContain("far@example.com");
    expect(output[0]).toContain("near@example.com");
    expect(output[0]).toContain("NO MATCH: matching Chrome session not detected");
    expect(output[0]).not.toContain("not signed in");
    expect(output[0]).not.toContain("Unused Chrome");
    expect(output[0]).not.toContain("ERROR");
  });

  it("preserves JSON keys while ordering registered rows by name and exposing explicit statuses", async () => {
    profiles(["Denied Chrome", "Near Chrome", "Unused Chrome"]);
    mocks.fetchAccountUsage
      .mockResolvedValueOnce({ ok: false, status: 403, detail: "HTTP 403: access denied by claude.ai", email: "failed@example.com" })
      .mockResolvedValueOnce(success("near@example.com", "2026-10-03T10:00:00Z"))
      .mockResolvedValueOnce({ ok: false, status: 0, detail: "not signed in to claude.ai" });
    expect(await usageCommand(["--json"])).toBe(1);
    const rows = JSON.parse(output[0]!) as Record<string, unknown>[];
    expect(rows[0]).toEqual({
      profile: "failed", chromeProfile: "Denied Chrome", chromeDir: "Profile 0",
      email: "failed@example.com", error: "HTTP 403: access denied by claude.ai", usage: null, status: "error",
    });
    expect(rows[1]).toEqual({ profile: "far", email: "far@example.com", chromeProfile: null, chromeDir: null, error: null, usage: null, status: "no_match" });
    expect(rows[2]).toMatchObject({ profile: "near", email: "near@example.com", error: null, status: "ok" });
    expect(rows).toHaveLength(3);
    expect(output.join("\n")).not.toContain("test-session");
  });

  it("exits successfully for successful table and JSON responses", async () => {
    profiles(["Near Chrome"]);
    mocks.fetchAccountUsage.mockResolvedValue(success("near@example.com", "2026-10-03T10:00:00Z"));
    expect(await usageCommand([])).toBe(0);
    expect(await usageCommand(["--json"])).toBe(0);
  });

  it("keeps all 13 registered profile names, including registrations without an email", async () => {
    const registered = Object.fromEntries(Array.from({ length: 13 }, (_, index) => [
      `account-${String(index).padStart(2, "0")}`, index === 0 ? {} : { email: `account-${index}@example.com` },
    ]));
    mocks.loadConfig.mockReturnValue({ profiles: registered });
    profiles(["One Chrome"]);
    mocks.fetchAccountUsage.mockResolvedValue(success("account-1@example.com", "2026-10-03T10:00:00Z"));
    expect(await usageCommand(["--json"])).toBe(0);
    const rows = JSON.parse(output[0]!) as Record<string, unknown>[];
    expect(rows.map((row) => row.profile)).toEqual(Object.keys(registered).sort());
    expect(rows[0]).toMatchObject({ status: "no_email", email: null, chromeProfile: null, error: null, usage: null });
    expect(rows[1]).toMatchObject({ status: "ok", profile: "account-01" });
    expect(rows.slice(2).every((row) => row.status === "no_match")).toBe(true);

    output.length = 0;
    await usageCommand([]);
    expect(output[0]).toContain("NO EMAIL: registered email is missing");
    expect(output[0]!.split("\n")).toHaveLength(14);
  });

  it("keeps duplicate-email registrations separate and prefers a successful Chrome session", async () => {
    mocks.loadConfig.mockReturnValue({ profiles: {
      work: { email: "SAME@example.com" }, personal: { email: "same@example.com" },
    } });
    profiles(["Expired Chrome", "Working Chrome", "Duplicate Working Chrome"]);
    mocks.fetchAccountUsage
      .mockResolvedValueOnce({ ok: false, status: 401, detail: "HTTP 401: session expired", email: "same@example.com" })
      .mockResolvedValueOnce(success("Same@Example.com", "2026-10-03T10:00:00Z"))
      .mockResolvedValueOnce(success("same@example.com", "2026-10-03T10:00:00Z"));
    expect(await usageCommand(["--json"])).toBe(1);
    const rows = JSON.parse(output[0]!) as Record<string, unknown>[];
    expect(rows).toHaveLength(3);
    expect(rows.slice(0, 2).map((row) => row.profile)).toEqual(["personal", "work"]);
    for (const row of rows.slice(0, 2)) expect(row).toMatchObject({ status: "ok", chromeProfile: "Working Chrome" });
    expect(rows[2]).toMatchObject({ profile: null, status: "error", chromeProfile: "Expired Chrome" });
    expect(rows.some((row) => row.chromeProfile === "Duplicate Working Chrome")).toBe(false);
  });

  it("uses the first identified failure when no matching Chrome session succeeds", async () => {
    mocks.loadConfig.mockReturnValue({ profiles: { failed: { email: "failed@example.com" } } });
    profiles(["First Chrome", "Second Chrome"]);
    mocks.fetchAccountUsage
      .mockResolvedValueOnce({ ok: false, status: 403, detail: "HTTP 403: access denied by claude.ai", email: "failed@example.com" })
      .mockResolvedValueOnce({ ok: false, status: 429, detail: "HTTP 429: rate limited", email: "failed@example.com" });
    expect(await usageCommand(["--json"])).toBe(1);
    const rows = JSON.parse(output[0]!) as Record<string, unknown>[];
    expect(rows[0]).toMatchObject({ profile: "failed", status: "error", chromeProfile: "First Chrome" });
    expect(rows[1]).toMatchObject({ profile: null, status: "error", chromeProfile: "Second Chrome" });
  });

  it("retains unregistered successes and unknown-identity failures as other Chrome results", async () => {
    profiles(["Unregistered Chrome", "Unknown Chrome"]);
    mocks.fetchAccountUsage
      .mockResolvedValueOnce(success("unregistered@example.com", "2026-10-03T10:00:00Z"))
      .mockResolvedValueOnce({ ok: false, status: 403, detail: "HTTP 403: access denied by claude.ai" });
    expect(await usageCommand(["--json"])).toBe(1);
    const rows = JSON.parse(output[0]!) as Record<string, unknown>[];
    expect(rows.slice(0, 3).every((row) => row.status === "no_match")).toBe(true);
    expect(rows[3]).toMatchObject({ profile: null, email: "unregistered@example.com", status: "ok" });
    expect(rows[4]).toMatchObject({ profile: null, email: null, status: "error", error: "HTTP 403: access denied by claude.ai" });
  });

  it("keeps every registered row when Chrome data is absent", async () => {
    mocks.existsSync.mockReturnValue(false);
    expect(await usageCommand(["--json"])).toBe(1);
    const rows = JSON.parse(output[0]!) as Record<string, unknown>[];
    expect(rows.map((row) => row.profile)).toEqual(["failed", "far", "near"]);
    expect(rows.every((row) => row.status === "error" && row.usage === null)).toBe(true);
    expect(rows[0]?.error).toContain("Chrome data not found");
    expect(mocks.safeStorageKey).not.toHaveBeenCalled();
    expect(mocks.fetchAccountUsage).not.toHaveBeenCalled();
  });

  it("keeps every registered row when the Chrome encryption key cannot be read", async () => {
    profiles(["Any Chrome"]);
    mocks.safeStorageKey.mockRejectedValue(new Error("Could not read the Chrome Safe Storage key"));
    expect(await usageCommand([])).toBe(1);
    expect(output[0]!.split("\n")).toHaveLength(4);
    expect(output[0]).toMatch(/failed.*ERROR Could not read/);
    expect(output[0]).toMatch(/far.*ERROR Could not read/);
    expect(output[0]).toMatch(/near.*ERROR Could not read/);
    expect(mocks.fetchAccountUsage).not.toHaveBeenCalled();
  });

  it("shows no-match rows when there are no readable Chrome cookie stores", async () => {
    profiles(["Chrome Without DB"]);
    mocks.existsSync.mockImplementation((path: string) => path.endsWith("Local State"));
    expect(await usageCommand(["--json"])).toBe(0);
    const rows = JSON.parse(output[0]!) as Record<string, unknown>[];
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.status === "no_match")).toBe(true);
    expect(mocks.safeStorageKey).not.toHaveBeenCalled();
  });

  it("does not hide an invalid registration config", async () => {
    mocks.loadConfig.mockImplementation(() => { throw new Error("Unsupported config version"); });
    await expect(usageCommand([])).rejects.toThrow("Unsupported config version");
    expect(mocks.fetchAccountUsage).not.toHaveBeenCalled();
    expect(output).toHaveLength(0);
  });

  it("orders successful accounts with no weekly window before unmatched registrations", async () => {
    mocks.loadConfig.mockReturnValue({ profiles: {
      aaa: { email: "missing@example.com" }, zzz: { email: "known@example.com" },
    } });
    profiles(["Known Chrome"]);
    mocks.fetchAccountUsage.mockResolvedValue({
      ok: true, email: "known@example.com", report: { session: null, weeklyAll: null, fable: null },
    });
    expect(await usageCommand([])).toBe(0);
    const lines = output[0]!.split("\n");
    expect(lines[1]).toMatch(/^zzz\s+known@example.com.*OK$/);
    expect(lines[2]).toMatch(/^aaa\s+missing@example.com.*NO MATCH/);
  });
});
