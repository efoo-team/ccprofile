export type TokenLiveness =
  | { status: "alive"; email?: string }
  | { status: "invalid"; detail: string }
  | { status: "unknown"; detail: string };

const PROFILE_ENDPOINT = "https://api.anthropic.com/api/oauth/profile";

/**
 * Distinguishes live tokens from revoked ones using the OAuth profile
 * endpoint. setup-token tokens are inference-only by design, so a scope
 * rejection (permission_error) proves the token authenticated successfully
 * — that is the expected "alive" signal, not a failure. See
 * anthropics/claude-code#11985.
 */
export async function probeToken(
  token: string,
  fetchFn: typeof fetch = fetch,
): Promise<TokenLiveness> {
  let res: Response;
  try {
    res = await fetchFn(PROFILE_ENDPOINT, {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
    });
  } catch (error) {
    return {
      status: "unknown",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  if (res.ok) {
    // Tokens with the user:profile scope (not setup-token) get account info.
    try {
      const body = (await res.json()) as {
        account?: { email?: string; email_address?: string };
      };
      const email = body.account?.email ?? body.account?.email_address;
      return email ? { status: "alive", email } : { status: "alive" };
    } catch {
      return { status: "alive" };
    }
  }

  let errType = "";
  let message = "";
  try {
    const body = (await res.json()) as {
      error?: { type?: string; message?: string };
    };
    errType = body.error?.type ?? "";
    message = body.error?.message ?? "";
  } catch {
    // non-JSON error body
  }

  if (errType === "permission_error" && message.includes("scope")) {
    return { status: "alive" };
  }
  if (res.status === 401 || errType === "authentication_error") {
    return { status: "invalid", detail: message || `HTTP ${res.status}` };
  }
  return { status: "unknown", detail: message || `HTTP ${res.status}` };
}
