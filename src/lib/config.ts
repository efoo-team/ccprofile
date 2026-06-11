import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const KEYCHAIN_SERVICE = "ccprofile";
export const DEFAULT_EXPIRY_DAYS = 365;
export const DEFAULT_EXPIRY_WARNING_DAYS = 30;

export interface KeychainRef {
  service: string;
  account: string;
}

export interface ProfileEntry {
  email?: string;
  createdAt: string;
  expiresAt: string;
  keychain: KeychainRef;
  notes?: string;
}

export interface Config {
  version: 1;
  settings: {
    expiryWarningDays: number;
  };
  profiles: Record<string, ProfileEntry>;
}

export function defaultConfig(): Config {
  return {
    version: 1,
    settings: { expiryWarningDays: DEFAULT_EXPIRY_WARNING_DAYS },
    profiles: {},
  };
}

export function configDir(): string {
  return process.env.CCPROFILE_DIR ?? join(homedir(), ".ccprofile");
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

export function loadConfig(): Config {
  let raw: string;
  try {
    raw = readFileSync(configPath(), "utf8");
  } catch {
    return defaultConfig();
  }
  const parsed = JSON.parse(raw) as Config;
  if (parsed.version !== 1) {
    throw new Error(
      `Unsupported config version ${String(parsed.version)} in ${configPath()}`,
    );
  }
  return {
    ...defaultConfig(),
    ...parsed,
    settings: { ...defaultConfig().settings, ...parsed.settings },
    profiles: parsed.profiles ?? {},
  };
}

export function saveConfig(config: Config): void {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  writeFileSync(configPath(), `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
}

const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

export function validateProfileName(name: string): void {
  if (!PROFILE_NAME_RE.test(name)) {
    throw new Error(
      `Invalid profile name "${name}". Use lowercase letters, digits, ".", "_" or "-" (must start with a letter or digit).`,
    );
  }
}

export function computeExpiresAt(from: Date, days: number = DEFAULT_EXPIRY_DAYS): string {
  const d = new Date(from.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

export function daysRemaining(expiresAt: string, now: Date = new Date()): number {
  const ms = new Date(expiresAt).getTime() - now.getTime();
  return Math.floor(ms / 86_400_000);
}
