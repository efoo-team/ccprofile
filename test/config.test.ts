import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  computeExpiresAt,
  daysRemaining,
  defaultConfig,
  loadConfig,
  saveConfig,
  validateProfileName,
} from "../src/lib/config.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccprofile-test-"));
  process.env.CCPROFILE_DIR = dir;
});

afterEach(() => {
  delete process.env.CCPROFILE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("returns the default config when no file exists", () => {
    expect(loadConfig()).toEqual(defaultConfig());
  });

  it("round-trips profiles through save/load", () => {
    const config = defaultConfig();
    config.profiles.work = {
      email: "a@example.com",
      createdAt: "2026-06-11T00:00:00.000Z",
      expiresAt: "2027-06-11T00:00:00.000Z",
      keychain: { service: "ccprofile", account: "work" },
    };
    saveConfig(config);
    expect(loadConfig()).toEqual(config);
  });
});

describe("validateProfileName", () => {
  it("accepts kebab/lower names", () => {
    expect(() => validateProfileName("work")).not.toThrow();
    expect(() => validateProfileName("team-a.prod_2")).not.toThrow();
  });

  it("rejects names that would break the keychain/envrc charset", () => {
    expect(() => validateProfileName("Work")).toThrow();
    expect(() => validateProfileName("a b")).toThrow();
    expect(() => validateProfileName("-lead")).toThrow();
    expect(() => validateProfileName("日本語")).toThrow();
  });
});

describe("expiry helpers", () => {
  it("computes +365 days by default", () => {
    const from = new Date("2026-06-11T00:00:00.000Z");
    expect(computeExpiresAt(from)).toBe("2027-06-11T00:00:00.000Z");
  });

  it("computes remaining days relative to now", () => {
    const now = new Date("2026-06-11T00:00:00.000Z");
    expect(daysRemaining("2026-06-21T00:00:00.000Z", now)).toBe(10);
    expect(daysRemaining("2026-06-01T00:00:00.000Z", now)).toBe(-10);
  });
});
