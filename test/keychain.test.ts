import { describe, expect, it, vi } from "vitest";
import { Keychain, type ExecResult, type Runner } from "../src/lib/keychain.js";

function runnerReturning(results: Record<string, ExecResult>): Runner {
  return vi.fn(async (cmd, args) => {
    const key = [cmd, ...args].join(" ");
    return results[key] ?? { code: 0, stdout: "", stderr: "" };
  });
}

describe("Keychain.setToken", () => {
  it("passes the secret via stdin to `security -i`, never via argv", async () => {
    const calls: Array<{ args: string[]; stdinData?: string }> = [];
    const runner: Runner = async (cmd, args, opts) => {
      calls.push({ args: [cmd, ...args], stdinData: opts?.stdinData });
      if (args[0] === "find-generic-password") {
        return { code: 0, stdout: "sk-ant-oat01-abc\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    await new Keychain(runner).setToken("ccprofile", "work", "sk-ant-oat01-abc");

    const write = calls[0]!;
    expect(write.args).toEqual(["security", "-i"]);
    expect(write.args.join(" ")).not.toContain("sk-ant-oat01-abc");
    expect(write.stdinData).toBe(
      "add-generic-password -U -s ccprofile -a work -w sk-ant-oat01-abc\n",
    );
  });

  it("throws when the read-back does not match the written token", async () => {
    const runner = runnerReturning({
      "security find-generic-password -w -s ccprofile -a work": {
        code: 0,
        stdout: "different\n",
        stderr: "",
      },
    });
    await expect(
      new Keychain(runner).setToken("ccprofile", "work", "sk-ant-oat01-abc"),
    ).rejects.toThrow(/Failed to store/);
  });

  it("rejects tokens containing parser-breaking characters", async () => {
    const runner = runnerReturning({});
    await expect(
      new Keychain(runner).setToken("ccprofile", "work", "bad token; rm -rf /"),
    ).rejects.toThrow(/unsupported characters/);
  });
});

describe("Keychain.getToken", () => {
  it("returns the trimmed secret on success", async () => {
    const runner = runnerReturning({
      "security find-generic-password -w -s ccprofile -a work": {
        code: 0,
        stdout: "sk-ant-oat01-abc\n",
        stderr: "",
      },
    });
    expect(await new Keychain(runner).getToken("ccprofile", "work")).toBe(
      "sk-ant-oat01-abc",
    );
  });

  it("returns null when the entry is missing", async () => {
    const runner = runnerReturning({
      "security find-generic-password -w -s ccprofile -a work": {
        code: 44,
        stdout: "",
        stderr: "could not be found",
      },
    });
    expect(await new Keychain(runner).getToken("ccprofile", "work")).toBeNull();
  });
});
