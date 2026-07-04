/**
 * Minimal client for the claude.ai web API. ccprofile's own setup-token
 * cannot read usage (the api.anthropic.com/api/oauth/usage endpoint requires a
 * scope setup-tokens lack — see src/lib/usage.ts), so `ccprofile usage` speaks
 * to the same endpoints the web app uses, authenticated with the browser's
 * session cookies.
 */

export type Severity = "normal" | "warning" | "critical" | "unknown";

export interface UsageWindow {
  /** 0–100 utilization of this limit window. */
  percent: number;
  resetsAt: Date | null;
  severity: Severity;
}

export interface UsageReport {
  /** 5-hour rolling session window. */
  session: UsageWindow | null;
  /** Weekly window across all models. */
  weeklyAll: UsageWindow | null;
  /** Weekly window scoped to the Fable model (its own separate budget). */
  fable: UsageWindow | null;
}

export interface FetchResult {
  status: number;
  body: unknown;
}

export type JsonFetcher = (
  url: string,
  headers: Record<string, string>,
) => Promise<FetchResult>;

/** Per-request ceiling so one stalled account cannot hang the whole command. */
const REQUEST_TIMEOUT_MS = 15_000;

export const defaultJsonFetcher: JsonFetcher = async (url, headers) => {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: res.status, body };
};

export function buildHeaders(cookieHeader: string, userAgent: string): Record<string, string> {
  return {
    Cookie: cookieHeader,
    "User-Agent": userAgent,
    "anthropic-client-platform": "web_claude_ai",
    Referer: "https://claude.ai/",
    Accept: "*/*",
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function toDate(v: unknown): Date | null {
  if (typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toSeverity(v: unknown): Severity {
  return v === "normal" || v === "warning" || v === "critical" ? v : "unknown";
}

function toPercent(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** A `limits[]` entry carries percent/severity/resets_at directly. */
function windowFromLimit(limit: Record<string, unknown>): UsageWindow {
  return {
    percent: toPercent(limit.percent),
    resetsAt: toDate(limit.resets_at),
    severity: toSeverity(limit.severity),
  };
}

/** The top-level five_hour/seven_day objects use `utilization` and lack severity. */
function windowFromTopLevel(obj: unknown): UsageWindow | null {
  if (!isRecord(obj)) return null;
  return {
    percent: toPercent(obj.utilization),
    resetsAt: toDate(obj.resets_at),
    severity: "unknown",
  };
}

function isFableScoped(limit: Record<string, unknown>): boolean {
  if (limit.kind !== "weekly_scoped") return false;
  const scope = limit.scope;
  if (!isRecord(scope)) return false;
  const model = scope.model;
  return isRecord(model) && model.display_name === "Fable";
}

/**
 * Normalizes an /organizations/{id}/usage response. The Fable window only ever
 * appears inside `limits[]` (the top-level seven_day_* fields are null), so
 * limits[] is the primary source; five_hour/seven_day are fallbacks for the
 * session and weekly-all windows when limits[] is absent.
 */
export function parseUsage(json: unknown): UsageReport {
  const root = isRecord(json) ? json : {};
  const limits = Array.isArray(root.limits) ? root.limits.filter(isRecord) : [];
  const byKind = (kind: string): Record<string, unknown> | undefined =>
    limits.find((l) => l.kind === kind);

  const session = byKind("session");
  const weeklyAll = byKind("weekly_all");
  const fable = limits.find(isFableScoped);

  return {
    session: session ? windowFromLimit(session) : windowFromTopLevel(root.five_hour),
    weeklyAll: weeklyAll ? windowFromLimit(weeklyAll) : windowFromTopLevel(root.seven_day),
    fable: fable ? windowFromLimit(fable) : null,
  };
}

function extractEmail(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const account = body.account;
  if (!isRecord(account)) return null;
  return typeof account.email_address === "string" ? account.email_address : null;
}

/** Detail set when a profile simply has no claude.ai session (not an error). */
export const NOT_SIGNED_IN = "not signed in to claude.ai";

export type AccountUsage =
  | { ok: true; email: string | null; report: UsageReport }
  | { ok: false; status: number; detail: string };

function describeStatus(status: number): string {
  if (status === 401) return "session expired — sign in again in Chrome";
  if (status === 403) return "blocked (session expired or Cloudflare challenge)";
  if (status === 429) return "rate limited by claude.ai";
  return `claude.ai returned HTTP ${status}`;
}

/**
 * Resolves one account's email and usage from its cookies. Uses lastActiveOrg
 * (the org the browser last viewed) for the usage URL so the numbers match
 * what the web UI shows. Never throws — network/HTTP failures come back as
 * `{ ok: false }` so callers can render one bad profile without aborting.
 */
export async function fetchAccountUsage(
  cookies: Record<string, string>,
  userAgent: string,
  fetcher: JsonFetcher = defaultJsonFetcher,
): Promise<AccountUsage> {
  if (cookies.sessionKey === undefined) {
    return { ok: false, status: 0, detail: NOT_SIGNED_IN };
  }
  const org = cookies.lastActiveOrg;
  if (org === undefined) {
    return { ok: false, status: 0, detail: "no active organization cookie" };
  }
  const cookieHeader = Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
  const headers = buildHeaders(cookieHeader, userAgent);

  try {
    const boot = await fetcher("https://claude.ai/api/bootstrap", headers);
    if (boot.status !== 200) {
      return { ok: false, status: boot.status, detail: describeStatus(boot.status) };
    }
    const email = extractEmail(boot.body);
    const usage = await fetcher(
      `https://claude.ai/api/organizations/${encodeURIComponent(org)}/usage`,
      headers,
    );
    if (usage.status !== 200) {
      return { ok: false, status: usage.status, detail: describeStatus(usage.status) };
    }
    return { ok: true, email, report: parseUsage(usage.body) };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
