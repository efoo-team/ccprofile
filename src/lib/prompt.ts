import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

export async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

export async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  const answer = (await ask(`${question} ${hint} `)).toLowerCase();
  if (answer === "") return defaultYes;
  return answer === "y" || answer === "yes";
}

/** Reads a line without echoing it (for token paste). */
export function askHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!stdin.isTTY) {
      // Piped input: fall back to reading a single line.
      let buf = "";
      stdin.setEncoding("utf8");
      stdin.on("data", (chunk: string) => {
        buf += chunk;
        const nl = buf.indexOf("\n");
        if (nl !== -1) {
          stdin.pause();
          resolve(buf.slice(0, nl).trim());
        }
      });
      stdin.on("end", () => resolve(buf.trim()));
      stdin.on("error", reject);
      return;
    }

    stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "") {
          // Ctrl-C
          cleanup();
          stdout.write("\n");
          process.exit(130);
        }
        if (ch === "\r" || ch === "\n") {
          cleanup();
          stdout.write("\n");
          resolve(value.trim());
          return;
        }
        if (ch === "" || ch === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += ch;
      }
    };
    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
    };
    stdin.on("data", onData);
  });
}
