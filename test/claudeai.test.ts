import { describe, expect, it } from "vitest";
import {
  buildHeaders,
  fetchAccountUsage,
  parseUsage,
  type JsonFetcher,
} from "../src/lib/claudeai.js";

// Trimmed from a real /organizations/{id}/usage response.
const SAMPLE_USAGE = {
  five_hour: { utilization: 62, resets_at: "2026-07-04T18:59:59.536119+00:00" },
  seven_day: { utilization: 53, resets_at: "2026-07-10T10:59:59.536145+00:00" },
  seven_day_opus: null,
  limits: [
    {
      kind: "session",
      group: "session",
      percent: 62,
      severity: "normal",
      resets_at: "2026-07-04T18:59:59.536119+00:00",
      scope: null,
      is_active: false,
    },
    {
      kind: "weekly_all",
      group: "weekly",
      percent: 53,
      severity: "warning",
      resets_at: "2026-07-10T10:59:59.536145+00:00",
      scope: null,
      is_active: false,
    },
    {
      kind: "weekly_scoped",
      group: "weekly",
      percent: 65,
      severity: "critical",
      resets_at: "2026-07-10T10:59:59.536448+00:00",
      scope: { model: { id: null, display_name: "Fable" }, surface: null },
      is_active: true,
    },
  ],
};

describe("parseUsage", () => {
  it("reads all three windows from limits[]", () => {
    const report = parseUsage(SAMPLE_USAGE);
    expect(report.session).toEqual({
      percent: 62,
      resetsAt: new Date("2026-07-04T18:59:59.536119+00:00"),
      severity: "normal",
    });
    expect(report.weeklyAll?.percent).toBe(53);
    expect(report.weeklyAll?.severity).toBe("warning");
    expect(report.fable).toEqual({
      percent: 65,
      resetsAt: new Date("2026-07-10T10:59:59.536448+00:00"),
      severity: "critical",
    });
  });

  it("picks the Fable-scoped weekly limit, ignoring other scoped models", () => {
    const report = parseUsage({
      limits: [
        {
          kind: "weekly_scoped",
          percent: 10,
          severity: "normal",
          resets_at: null,
          scope: { model: { display_name: "Opus" } },
        },
        {
          kind: "weekly_scoped",
          percent: 65,
          severity: "normal",
          resets_at: null,
          scope: { model: { display_name: "Fable" } },
        },
      ],
    });
    expect(report.fable?.percent).toBe(65);
  });

  it("falls back to five_hour/seven_day when limits[] is absent", () => {
    const report = parseUsage({
      five_hour: { utilization: 20, resets_at: "2026-07-04T18:59:59Z" },
      seven_day: { utilization: 40, resets_at: "2026-07-10T10:59:59Z" },
    });
    expect(report.session?.percent).toBe(20);
    expect(report.session?.severity).toBe("unknown");
    expect(report.weeklyAll?.percent).toBe(40);
    expect(report.fable).toBeNull();
  });

  it("returns all-null for an empty or malformed payload", () => {
    expect(parseUsage({})).toEqual({ session: null, weeklyAll: null, fable: null });
    expect(parseUsage(null)).toEqual({ session: null, weeklyAll: null, fable: null });
  });
});

describe("buildHeaders", () => {
  it("sets the web-client platform header and cookie", () => {
    const headers = buildHeaders("sessionKey=abc", "UA/1.0");
    expect(headers.Cookie).toBe("sessionKey=abc");
    expect(headers["anthropic-client-platform"]).toBe("web_claude_ai");
    expect(headers["User-Agent"]).toBe("UA/1.0");
  });
});

describe("fetchAccountUsage", () => {
  const cookies = {
    sessionKey: "sk-ant-sid02-x",
    lastActiveOrg: "org-uuid",
    cf_clearance: "cf",
  };

  it("returns email and usage on success", async () => {
    const seen: string[] = [];
    const fetcher: JsonFetcher = async (url, headers) => {
      seen.push(url);
      expect(headers.Cookie).toContain("sessionKey=sk-ant-sid02-x");
      if (url.endsWith("/bootstrap")) {
        return { status: 200, body: { account: { email_address: "you@example.com" } } };
      }
      return { status: 200, body: SAMPLE_USAGE };
    };
    const result = await fetchAccountUsage(cookies, "UA/1.0", fetcher);
    expect(result).toMatchObject({ ok: true, email: "you@example.com" });
    if (result.ok) expect(result.report.fable?.percent).toBe(65);
    expect(seen[1]).toBe("https://claude.ai/api/organizations/org-uuid/usage");
  });

  it("reports a missing session without calling the network", async () => {
    let called = false;
    const fetcher: JsonFetcher = async () => {
      called = true;
      return { status: 200, body: {} };
    };
    const result = await fetchAccountUsage({ lastActiveOrg: "o" }, "UA", fetcher);
    expect(result).toEqual({ ok: false, status: 0, detail: "not signed in to claude.ai" });
    expect(called).toBe(false);
  });

  it("reports a missing org without calling the network", async () => {
    let called = false;
    const fetcher: JsonFetcher = async () => {
      called = true;
      return { status: 200, body: {} };
    };
    const result = await fetchAccountUsage({ sessionKey: "sk-ant-sid02-x" }, "UA", fetcher);
    expect(result).toEqual({ ok: false, status: 0, detail: "no active organization cookie" });
    expect(called).toBe(false);
  });

  it("surfaces a non-200 bootstrap as a failure", async () => {
    const fetcher: JsonFetcher = async () => ({ status: 403, body: null });
    const result = await fetchAccountUsage(cookies, "UA", fetcher);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(403);
  });

  it("surfaces a non-200 usage endpoint after a successful bootstrap", async () => {
    const fetcher: JsonFetcher = async (url) =>
      url.endsWith("/bootstrap")
        ? { status: 200, body: { account: { email_address: "you@example.com" } } }
        : { status: 500, body: null };
    const result = await fetchAccountUsage(cookies, "UA", fetcher);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(500);
  });

  it("converts a thrown fetch (e.g. timeout) into a failure instead of rejecting", async () => {
    const fetcher: JsonFetcher = async () => {
      throw new Error("The operation was aborted due to timeout");
    };
    const result = await fetchAccountUsage(cookies, "UA", fetcher);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.detail).toContain("timeout");
  });
});
