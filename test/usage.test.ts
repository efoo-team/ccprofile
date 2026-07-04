import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyProbeOutput,
  probeUsage,
  type ProbeExec,
  type ProbeRunner,
} from "../src/lib/usage.js";

function exec(partial: Partial<ProbeExec>): ProbeExec {
  return { code: 0, stdout: "", stderr: "", timedOut: false, ...partial };
}

describe("classifyProbeOutput", () => {
  it("treats exit 0 with a JSON result as usable", () => {
    const result = classifyProbeOutput(
      exec({
        code: 0,
        stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" }),
      }),
    );
    expect(result).toEqual({ status: "usable" });
  });

  it("treats exit 0 with non-JSON output as usable", () => {
    expect(classifyProbeOutput(exec({ code: 0, stdout: "ok" })).status).toBe("usable");
  });

  it("classifies the legacy pipe-delimited limit message and extracts the reset time", () => {
    const result = classifyProbeOutput(
      exec({
        code: 1,
        stdout: JSON.stringify({ is_error: true, result: "Claude AI usage limit reached|1751600000" }),
      }),
    );
    expect(result.status).toBe("limited");
    if (result.status === "limited") {
      expect(result.resetsAt).toEqual(new Date(1751600000 * 1000));
    }
  });

  it("classifies prose limit messages without a reset epoch", () => {
    const result = classifyProbeOutput(
      exec({
        code: 1,
        stdout: JSON.stringify({
          is_error: true,
          result: "You've reached your usage limit. Your limit will reset at 2pm (Asia/Tokyo).",
        }),
      }),
    );
    expect(result.status).toBe("limited");
    if (result.status === "limited") expect(result.resetsAt).toBeUndefined();
  });

  it("classifies a rate_limit_error on stderr as limited even without JSON output", () => {
    const result = classifyProbeOutput(
      exec({
        code: 1,
        stderr:
          'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of requests has exceeded your limit"}}',
      }),
    );
    expect(result.status).toBe("limited");
  });

  it("classifies a limit reported with is_error true even when exit code is 0", () => {
    const result = classifyProbeOutput(
      exec({ code: 0, stdout: JSON.stringify({ is_error: true, result: "5-hour limit reached" }) }),
    );
    expect(result.status).toBe("limited");
  });

  it("classifies authentication failures as invalid", () => {
    const result = classifyProbeOutput(
      exec({
        code: 1,
        stdout: JSON.stringify({
          is_error: true,
          result: "Invalid OAuth token. The provided token was not found or is malformed.",
        }),
      }),
    );
    expect(result.status).toBe("invalid");
  });

  it("strips ANSI codes from the reported detail", () => {
    const result = classifyProbeOutput(
      exec({ code: 1, stderr: "\u001B[31mError:\u001B[0m rate limit reached" }),
    );
    expect(result).toEqual({ status: "limited", detail: "Error: rate limit reached", resetsAt: undefined });
  });

  it("handles the message-array json format and classifies api_error_status 429 as limited", () => {
    // Real shape observed with Claude Code 2.1.201.
    const stdout = JSON.stringify([
      { type: "system", subtype: "init", session_id: "x" },
      { type: "assistant", error: "rate_limit" },
      {
        type: "result",
        subtype: "success",
        is_error: true,
        api_error_status: 429,
        result:
          "API Error: Request rejected (429) · This request would exceed your account's rate limit. Please try again later.",
      },
    ]);
    const result = classifyProbeOutput(exec({ code: 1, stdout }));
    expect(result.status).toBe("limited");
    if (result.status === "limited") {
      expect(result.detail).toContain("429");
    }
  });

  it("handles the message-array json format for successful runs", () => {
    const stdout = JSON.stringify([
      { type: "system", subtype: "init" },
      { type: "result", subtype: "success", is_error: false, result: "ok" },
    ]);
    expect(classifyProbeOutput(exec({ code: 0, stdout }))).toEqual({ status: "usable" });
  });

  it("classifies api_error_status 401 as invalid even without a recognizable message", () => {
    const stdout = JSON.stringify([
      { type: "result", is_error: true, api_error_status: 401, result: "API Error: Request rejected" },
    ]);
    expect(classifyProbeOutput(exec({ code: 1, stdout })).status).toBe("invalid");
  });

  it("returns unknown for a spawn failure", () => {
    const result = classifyProbeOutput(exec({ code: null, spawnError: "spawn claude ENOENT" }));
    expect(result).toEqual({ status: "unknown", detail: "spawn claude ENOENT" });
  });

  it("returns unknown on timeout", () => {
    const result = classifyProbeOutput(exec({ code: null, timedOut: true }));
    expect(result.status).toBe("unknown");
    if (result.status === "unknown") expect(result.detail).toContain("timed out");
  });

  it("returns unknown for unrecognized errors", () => {
    const result = classifyProbeOutput(exec({ code: 1, stderr: "something exploded" }));
    expect(result).toEqual({ status: "unknown", detail: "something exploded" });
  });
});

describe("probeUsage", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("spawns claude with the model pinned and strips conflicting auth env vars", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "should-be-removed");
    vi.stubEnv("CLAUDE_CODE_USE_BEDROCK", "1");
    let seenCmd = "";
    let seenArgs: string[] = [];
    let seenEnv: NodeJS.ProcessEnv = {};
    const runner: ProbeRunner = async (cmd, args, opts) => {
      seenCmd = cmd;
      seenArgs = args;
      seenEnv = opts.env;
      return exec({ code: 0, stdout: JSON.stringify({ is_error: false, result: "ok" }) });
    };

    const result = await probeUsage("sk-ant-oat01-x", "sonnet", runner);

    expect(result).toEqual({ status: "usable" });
    expect(seenCmd).toBe("claude");
    const joined = seenArgs.join(" ");
    expect(joined).toContain("--print ping");
    expect(joined).toContain("--model sonnet");
    expect(joined).toContain("--effort low");
    expect(joined).toContain("--output-format json");
    expect(seenArgs).not.toContain("--fallback-model");
    expect(seenEnv.ANTHROPIC_AUTH_TOKEN).toBe("sk-ant-oat01-x");
    expect(seenEnv.ANTHROPIC_API_KEY).toBeUndefined();
    expect(seenEnv.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
  });
});
