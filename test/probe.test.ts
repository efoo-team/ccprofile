import { describe, expect, it } from "vitest";
import { probeToken } from "../src/lib/probe.js";

function fakeFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), { status })) as typeof fetch;
}

describe("probeToken", () => {
  it("treats a scope rejection as alive (setup-token is inference-only)", async () => {
    const result = await probeToken(
      "sk-ant-oat01-x",
      fakeFetch(403, {
        type: "error",
        error: {
          type: "permission_error",
          message:
            "OAuth token does not meet scope requirement any_of(user:profile, user:office)",
        },
      }),
    );
    expect(result).toEqual({ status: "alive" });
  });

  it("treats authentication_error as invalid (revoked/expired)", async () => {
    const result = await probeToken(
      "sk-ant-oat01-x",
      fakeFetch(401, {
        type: "error",
        error: {
          type: "authentication_error",
          message: "Invalid OAuth token. The provided token was not found or is malformed.",
        },
      }),
    );
    expect(result.status).toBe("invalid");
  });

  it("extracts the account email when the token has profile scope", async () => {
    const result = await probeToken(
      "sk-ant-oat01-x",
      fakeFetch(200, { account: { email: "a@example.com" } }),
    );
    expect(result).toEqual({ status: "alive", email: "a@example.com" });
  });

  it("returns unknown on network failure", async () => {
    const failingFetch = (async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as unknown as typeof fetch;
    const result = await probeToken("sk-ant-oat01-x", failingFetch);
    expect(result.status).toBe("unknown");
  });

  it("returns unknown for unexpected server errors", async () => {
    const result = await probeToken(
      "sk-ant-oat01-x",
      fakeFetch(500, { type: "error", error: { type: "api_error", message: "boom" } }),
    );
    expect(result.status).toBe("unknown");
  });
});
