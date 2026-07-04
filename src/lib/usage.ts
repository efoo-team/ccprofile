import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

/**
 * Usage-limit probe: runs one minimal real inference through `claude -p`.
 *
 * A zero-cost alternative does not exist: the server's usage endpoint
 * (api.anthropic.com/api/oauth/usage) requires the user:profile scope that
 * setup-token tokens deliberately lack (verified 2026-07-04: HTTP 403
 * permission_error). Actually answering an inference request is therefore the
 * only signal for "is this profile's usage window exhausted right now".
 *
 * The probe deliberately spends a tiny amount of quota and may start an idle
 * profile's 5-hour window. Both are accepted: the window restarting as early
 * as possible is desired behavior (the countdown runs while the profile sits
 * idle instead of starting on first real use).
 */

export type UsageProbeResult =
  | { status: "usable" }
  | { status: "limited"; detail: string; resetsAt?: Date }
  | { status: "invalid"; detail: string }
  | { status: "unknown"; detail: string };

export interface ProbeExec {
  /** Process exit code; null when the process was killed (timeout). */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Set when the process could not be spawned at all (e.g. ENOENT). */
  spawnError?: string;
}

export type ProbeRunner = (
  cmd: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv; cwd: string; timeoutMs: number },
) => Promise<ProbeExec>;

/**
 * fable has its own budget (~50% of the plan, 5h/1-week windows) separate
 * from the pool shared by haiku/sonnet/opus, and fable usage also counts
 * against the shared pool. Probing fable first therefore answers for
 * everything: fable OK ⇒ all models OK; fable limited ⇒ probe the cheapest
 * shared-pool model to tell "fable-only exhausted" from "window exhausted".
 */
export const DEFAULT_PROBE_MODEL = "fable";
export const FALLBACK_PROBE_MODEL = "haiku";

const PROBE_TIMEOUT_MS = 120_000;

/**
 * Env vars that outrank ANTHROPIC_AUTH_TOKEN in Claude Code's documented
 * authentication precedence. doctor flags them; the probe strips them so the
 * spawned `claude -p` authenticates as the profile under test.
 */
export const OVERRIDING_ENV_VARS = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
];

export const defaultProbeRunner: ProbeRunner = (cmd, args, opts) =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, {
      env: opts.env,
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, timedOut, spawnError: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });

/**
 * Everything here trims the request to near-zero cost and isolates it from
 * the invoking user's Claude Code customizations: a one-word turn with a
 * replacement system prompt, no tools, no MCP servers, no settings (hooks,
 * plugins, apiKeyHelper), no session file, run from tmpdir so no project
 * CLAUDE.md is discovered. --fallback-model must never be added: it would
 * silently succeed on another model and mask the limit being probed for.
 */
function probeArgs(model: string): string[] {
  return [
    "--print", "ping",
    "--model", model,
    "--effort", "low",
    "--system-prompt", 'Reply with exactly "ok".',
    "--tools", "",
    "--setting-sources", "",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--output-format", "json",
  ];
}

function probeEnv(token: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ANTHROPIC_AUTH_TOKEN: token };
  delete env.ANTHROPIC_API_KEY;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.ANTHROPIC_MODEL;
  for (const name of OVERRIDING_ENV_VARS) delete env[name];
  return env;
}

// Claude Code's error strings are not a stable API; match loosely and fall
// back to "unknown" rather than misclassifying. Checked against the legacy
// print-mode message ("Claude AI usage limit reached|<epoch>"), the current
// prose ("You've reached your usage limit..."), and API rate_limit_error.
const LIMIT_RE =
  /usage limit|rate.?limit|limit (?:reached|exceeded|resets|will reset)|exceeded.*limit|out of (?:usage|credits)|hit your.*limit|\b429\b/i;
const AUTH_RE =
  /authentication_error|invalid (?:bearer|oauth|api key)|oauth token|\b401\b|\/login\b/i;

/** Legacy print-mode limit messages carry a reset time as "|<unix epoch>". */
function parseResetEpoch(text: string): Date | undefined {
  const digits = /\|(\d{10,13})\b/.exec(text)?.[1];
  if (digits === undefined) return undefined;
  const n = Number(digits);
  return new Date(digits.length >= 13 ? n : n * 1000);
}

function summarize(text: string): string {
  const line = text
    .replaceAll(/\u001B\[[0-9;]*m/g, "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return (line ?? "").slice(0, 200);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * `--output-format json` emits a single result object in some Claude Code
 * versions and an array of messages (init/assistant/result) in others
 * (observed with 2.1.201). The result message carries `is_error`, the final
 * text, and — on API rejections — a structured `api_error_status` (e.g. 429),
 * which beats string matching.
 */
function extractResultMessage(stdout: string): {
  isError?: boolean;
  resultText?: string;
  apiErrorStatus?: number;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    // Startup failures print plain text before any JSON is emitted.
    return {};
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const message =
    items.find((i): i is Record<string, unknown> => isRecord(i) && i.type === "result") ??
    items.find((i): i is Record<string, unknown> => isRecord(i) && "is_error" in i);
  if (message === undefined) return {};
  return {
    isError: typeof message.is_error === "boolean" ? message.is_error : undefined,
    resultText: typeof message.result === "string" ? message.result : undefined,
    apiErrorStatus:
      typeof message.api_error_status === "number" ? message.api_error_status : undefined,
  };
}

export function classifyProbeOutput(exec: ProbeExec): UsageProbeResult {
  if (exec.spawnError !== undefined) {
    return { status: "unknown", detail: exec.spawnError };
  }
  if (exec.timedOut) {
    return { status: "unknown", detail: `probe timed out after ${PROBE_TIMEOUT_MS / 1000}s` };
  }

  const { isError, resultText, apiErrorStatus } = extractResultMessage(exec.stdout);
  if (exec.code === 0 && isError !== true) return { status: "usable" };

  const combined = [resultText ?? exec.stdout, exec.stderr].join("\n");
  const detail = summarize(combined) || `claude exited with code ${exec.code}`;
  if (apiErrorStatus === 429 || LIMIT_RE.test(combined)) {
    return { status: "limited", detail, resetsAt: parseResetEpoch(combined) };
  }
  if (apiErrorStatus === 401 || AUTH_RE.test(combined)) {
    return { status: "invalid", detail };
  }
  return { status: "unknown", detail };
}

export async function probeUsage(
  token: string,
  model: string,
  run: ProbeRunner = defaultProbeRunner,
): Promise<UsageProbeResult> {
  const exec = await run("claude", probeArgs(model), {
    env: probeEnv(token),
    cwd: tmpdir(),
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  return classifyProbeOutput(exec);
}
