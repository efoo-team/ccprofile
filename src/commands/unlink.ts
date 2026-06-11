import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { removeBlock } from "../lib/envrc.js";
import { bold, ok } from "../lib/format.js";

export async function unlinkCommand(argv: string[]): Promise<number> {
  const { positionals } = parseArgs({ args: argv, allowPositionals: true, options: {} });
  const dir = resolve(positionals[0] ?? process.cwd());
  const envrcPath = join(dir, ".envrc");

  if (!existsSync(envrcPath)) {
    console.error(`No .envrc found in ${dir}.`);
    return 1;
  }

  const current = readFileSync(envrcPath, "utf8");
  const { content, removed } = removeBlock(current);
  if (!removed) {
    console.error(`No ccprofile-managed block found in ${envrcPath}.`);
    return 1;
  }

  if (content.trim() === "") {
    unlinkSync(envrcPath);
    console.log(ok(`Removed ${bold(envrcPath)} (it contained only the ccprofile block).`));
  } else {
    writeFileSync(envrcPath, content);
    console.log(ok(`Removed the ccprofile block from ${bold(envrcPath)}.`));
  }
  return 0;
}
