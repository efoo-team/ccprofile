import { spawn } from "node:child_process";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Runner = (
  cmd: string,
  args: string[],
  opts?: { stdinData?: string },
) => Promise<ExecResult>;

export const defaultRunner: Runner = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    if (opts?.stdinData !== undefined) {
      child.stdin.write(opts.stdinData);
    }
    child.stdin.end();
  });

// The `security -i` batch parser and the generated .envrc both consume these
// values unquoted, so the charset must stay shell- and parser-safe.
const SAFE_VALUE_RE = /^[A-Za-z0-9._-]+$/;

function assertSafe(label: string, value: string): void {
  if (!SAFE_VALUE_RE.test(value)) {
    throw new Error(
      `${label} contains unsupported characters (allowed: letters, digits, ".", "_", "-").`,
    );
  }
}

export function assertDarwin(): void {
  if (process.platform !== "darwin") {
    throw new Error(
      "ccprofile currently supports macOS only (tokens are stored in the macOS Keychain).",
    );
  }
}

export class Keychain {
  constructor(private readonly run: Runner = defaultRunner) {}

  /**
   * Stores the token via `security -i` (commands over stdin) so the secret
   * never appears in the process argument list visible to `ps`.
   * Write is verified with a read-back because `security -i` exit codes do
   * not reliably reflect per-command failures.
   */
  async setToken(service: string, account: string, token: string): Promise<void> {
    assertSafe("service", service);
    assertSafe("account", account);
    assertSafe("token", token);
    await this.run("security", ["-i"], {
      stdinData: `add-generic-password -U -s ${service} -a ${account} -w ${token}\n`,
    });
    const readBack = await this.getToken(service, account);
    if (readBack !== token) {
      throw new Error(
        `Failed to store the token in the Keychain (service=${service}, account=${account}).`,
      );
    }
  }

  async getToken(service: string, account: string): Promise<string | null> {
    assertSafe("service", service);
    assertSafe("account", account);
    const result = await this.run("security", [
      "find-generic-password",
      "-w",
      "-s",
      service,
      "-a",
      account,
    ]);
    if (result.code !== 0) return null;
    return result.stdout.replace(/\n$/, "");
  }

  /** Presence check without reading the secret value. */
  async hasEntry(service: string, account: string): Promise<boolean> {
    assertSafe("service", service);
    assertSafe("account", account);
    const result = await this.run("security", [
      "find-generic-password",
      "-s",
      service,
      "-a",
      account,
    ]);
    return result.code === 0;
  }

  async deleteToken(service: string, account: string): Promise<boolean> {
    assertSafe("service", service);
    assertSafe("account", account);
    const result = await this.run("security", [
      "delete-generic-password",
      "-s",
      service,
      "-a",
      account,
    ]);
    return result.code === 0;
  }
}
