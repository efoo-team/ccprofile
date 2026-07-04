import { createCipheriv } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildUserAgent,
  decryptCookieValue,
  deriveKey,
  parseProfiles,
} from "../src/lib/chrome.js";

/** Mirror of Chrome's v10 wrapping, used to build fixtures the reader decrypts. */
function encryptV10(value: string, key: Buffer, withDomainHash: boolean): string {
  const iv = Buffer.alloc(16, 0x20);
  const prefix = withDomainHash ? [Buffer.alloc(32, 0)] : [];
  const plain = Buffer.concat([...prefix, Buffer.from(value, "utf8")]);
  const cipher = createCipheriv("aes-128-cbc", key, iv);
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([Buffer.from("v10"), enc]).toString("hex");
}

describe("parseProfiles", () => {
  it("maps profile directories to display names, sorted numerically", () => {
    const json = JSON.stringify({
      profile: {
        info_cache: {
          Default: { name: "Personal" },
          "Profile 12": { name: "Twelfth" },
          "Profile 2": { name: "Work" },
        },
      },
    });
    expect(parseProfiles(json)).toEqual([
      { dir: "Default", name: "Personal" },
      { dir: "Profile 2", name: "Work" },
      { dir: "Profile 12", name: "Twelfth" },
    ]);
  });

  it("falls back to the directory name when no display name is set", () => {
    const json = JSON.stringify({ profile: { info_cache: { "Profile 1": {} } } });
    expect(parseProfiles(json)).toEqual([{ dir: "Profile 1", name: "Profile 1" }]);
  });

  it("returns an empty list when info_cache is missing", () => {
    expect(parseProfiles("{}")).toEqual([]);
  });
});

describe("buildUserAgent", () => {
  it("uses the installed Chrome major version", () => {
    expect(buildUserAgent("149.0.7827.201")).toContain("Chrome/149.0.0.0");
  });

  it("falls back to a default major when the version is missing or malformed", () => {
    expect(buildUserAgent(null)).toMatch(/Chrome\/\d+\.0\.0\.0/);
    expect(buildUserAgent("not-a-version")).toMatch(/Chrome\/\d+\.0\.0\.0/);
  });
});

describe("decryptCookieValue", () => {
  const key = deriveKey("test-safe-storage-password");

  it("derives a 16-byte AES-128 key", () => {
    expect(key.length).toBe(16);
  });

  it("decrypts a bare v10 value (older Chrome format)", () => {
    const hex = encryptV10("sk-ant-sid02-example", key, false);
    expect(decryptCookieValue(hex, key)).toBe("sk-ant-sid02-example");
  });

  it("strips the 32-byte domain hash (Chrome 130+ format)", () => {
    const hex = encryptV10("e10f591e-ff34-4007-a54f-96d5e0abcdef", key, true);
    expect(decryptCookieValue(hex, key)).toBe("e10f591e-ff34-4007-a54f-96d5e0abcdef");
  });

  it("returns null for a non-v10 (app-bound) prefix", () => {
    const buf = Buffer.concat([Buffer.from("v20"), Buffer.alloc(16, 1)]);
    expect(decryptCookieValue(buf.toString("hex"), key)).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(decryptCookieValue("", key)).toBeNull();
  });
});
