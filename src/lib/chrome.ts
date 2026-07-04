import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { defaultRunner, type Runner } from "./keychain.js";

/**
 * Reads claude.ai session cookies straight out of Chrome's cookie store so
 * `ccprofile usage` can query the web usage API without opening or switching
 * browsers. Everything shells out to macOS-bundled tooling (`security`,
 * `/usr/bin/sqlite3`) to keep the zero-runtime-dependency contract.
 */

export interface ChromeProfile {
  /** Directory name under the User Data dir, e.g. "Default", "Profile 3". */
  dir: string;
  /** Human-facing name from Local State (falls back to the directory name). */
  name: string;
}

/** claude.ai cookies needed to authenticate and clear the Cloudflare bot check. */
export const SESSION_COOKIE_NAMES = [
  "sessionKey",
  "lastActiveOrg",
  "cf_clearance",
  "__cf_bm",
] as const;

const SAFE_STORAGE_SERVICE = "Chrome Safe Storage";
// Chrome's fixed KDF parameters for the "v10" Keychain-wrapped cookie scheme.
const KDF_SALT = "saltysalt";
const KDF_ITERATIONS = 1003;
const KEY_LENGTH = 16;
// AES-128-CBC with an all-spaces IV; the encrypted blob is prefixed with "v10".
const COOKIE_IV = Buffer.alloc(16, 0x20);
const COOKIE_PREFIX = "v10";
// Chrome 130+ prepends a 32-byte SHA-256 of the cookie's host to the plaintext.
const DOMAIN_HASH_LENGTH = 32;

export function chromeUserDataDir(): string {
  return join(homedir(), "Library", "Application Support", "Google", "Chrome");
}

export function parseProfiles(localStateJson: string): ChromeProfile[] {
  const data = JSON.parse(localStateJson) as {
    profile?: { info_cache?: Record<string, { name?: string }> };
  };
  const cache = data.profile?.info_cache ?? {};
  return Object.entries(cache)
    .map(([dir, info]) => ({ dir, name: info.name?.trim() || dir }))
    .sort((a, b) => a.dir.localeCompare(b.dir, undefined, { numeric: true }));
}

/**
 * Builds a Chrome-matching User-Agent from the installed version. Cloudflare
 * ties cf_clearance to the exact UA, so the string must track the same Chrome
 * that solved the challenge — hence reading the local "Last Version" file
 * rather than hard-coding a version.
 */
export function buildUserAgent(version: string | null): string {
  const major = version?.split(".")[0]?.trim();
  const m = major !== undefined && /^\d+$/.test(major) ? major : "140";
  return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${m}.0.0.0 Safari/537.36`;
}

export function chromeUserAgent(userDataDir: string): string {
  let version: string | null = null;
  try {
    version = readFileSync(join(userDataDir, "Last Version"), "utf8");
  } catch {
    version = null;
  }
  return buildUserAgent(version);
}

export function deriveKey(password: string): Buffer {
  return pbkdf2Sync(password, KDF_SALT, KDF_ITERATIONS, KEY_LENGTH, "sha1");
}

/**
 * Fetches the Chrome cookie-encryption key from the login Keychain. The
 * service name contains a space, so this cannot reuse the Keychain class
 * (its assertSafe rejects spaces); a direct spawn with an argv array is safe.
 */
export async function safeStorageKey(run: Runner = defaultRunner): Promise<Buffer> {
  const result = await run("security", [
    "find-generic-password",
    "-w",
    "-s",
    SAFE_STORAGE_SERVICE,
  ]);
  if (result.code !== 0) {
    throw new Error(
      'Could not read the "Chrome Safe Storage" key from the Keychain. Is Google Chrome installed and set up?',
    );
  }
  return deriveKey(result.stdout.trim());
}

export function decryptCookieValue(encHex: string, key: Buffer): string | null {
  if (encHex.length === 0) return null;
  const buf = Buffer.from(encHex, "hex");
  if (buf.subarray(0, 3).toString("latin1") !== COOKIE_PREFIX) {
    // v20 (app-bound) cookies use a different key path we do not support.
    return null;
  }
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, COOKIE_IV);
    const plain = Buffer.concat([decipher.update(buf.subarray(3)), decipher.final()]);
    return decodePlaintext(plain);
  } catch {
    return null;
  }
}

/**
 * Newer Chrome builds prefix the value with a 32-byte host hash; older ones
 * store the bare value. The hash is binary, so a plaintext that is not clean
 * printable text is treated as prefixed and the leading 32 bytes are dropped.
 */
function decodePlaintext(plain: Buffer): string {
  if (isPrintable(plain)) return plain.toString("utf8");
  return plain.subarray(DOMAIN_HASH_LENGTH).toString("utf8");
}

function isPrintable(buf: Buffer): boolean {
  for (const b of buf) {
    if (b < 0x20 || b > 0x7e) return false;
  }
  return true;
}

interface RawCookie {
  name: string;
  enc: string;
}

/**
 * Copies the (Chrome-locked) cookie DB to a temp file and reads the claude.ai
 * rows as hex via the macOS-bundled sqlite3, avoiding a native SQLite binding.
 */
export async function readRawClaudeCookies(
  cookiesDbPath: string,
  run: Runner = defaultRunner,
): Promise<RawCookie[]> {
  const dir = mkdtempSync(join(tmpdir(), "ccprofile-cookies-"));
  const copy = join(dir, "Cookies");
  try {
    copyFileSync(cookiesDbPath, copy);
    // Chrome keeps the store in WAL mode; without the sidecars, recently
    // refreshed cookies (notably the short-lived Cloudflare ones) stay
    // invisible until Chrome checkpoints.
    for (const suffix of ["-wal", "-shm"]) {
      const sidecar = `${cookiesDbPath}${suffix}`;
      if (existsSync(sidecar)) copyFileSync(sidecar, `${copy}${suffix}`);
    }
    const result = await run("/usr/bin/sqlite3", [
      "-json",
      copy,
      "SELECT name, hex(encrypted_value) AS enc FROM cookies " +
        "WHERE host_key = 'claude.ai' OR host_key LIKE '%.claude.ai'",
    ]);
    if (result.code !== 0) return [];
    const out = result.stdout.trim();
    if (out === "") return [];
    return JSON.parse(out) as RawCookie[];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function readSessionCookies(
  cookiesDbPath: string,
  key: Buffer,
  run: Runner = defaultRunner,
): Promise<Record<string, string>> {
  const raw = await readRawClaudeCookies(cookiesDbPath, run);
  const wanted = new Set<string>(SESSION_COOKIE_NAMES);
  const cookies: Record<string, string> = {};
  for (const { name, enc } of raw) {
    if (!wanted.has(name)) continue;
    const value = decryptCookieValue(enc, key);
    if (value !== null) cookies[name] = value;
  }
  return cookies;
}
