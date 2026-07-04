const ESC = "\u001B";

const useColor =
  process.stdout.isTTY && process.env.NO_COLOR === undefined;

function paint(code: string, s: string): string {
  return useColor ? `${ESC}[${code}m${s}${ESC}[0m` : s;
}

export const bold = (s: string): string => paint("1", s);
export const dim = (s: string): string => paint("2", s);
export const red = (s: string): string => paint("31", s);
export const green = (s: string): string => paint("32", s);
export const yellow = (s: string): string => paint("33", s);
export const cyan = (s: string): string => paint("36", s);

export const ok = (s: string): string => `${green("✓")} ${s}`;
export const warn = (s: string): string => `${yellow("⚠")} ${s}`;
export const fail = (s: string): string => `${red("✗")} ${s}`;

export function stripAnsi(s: string): string {
  return s.replaceAll(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "");
}

/** East Asian Wide/Fullwidth code points that occupy two terminal columns. */
function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

/** Rendered column count of a string, ANSI-stripped and wide-char aware. */
export function displayWidth(s: string): number {
  let width = 0;
  for (const ch of stripAnsi(s)) {
    width += isWide(ch.codePointAt(0) ?? 0) ? 2 : 1;
  }
  return width;
}

export function table(rows: string[][]): string {
  if (rows.length === 0) return "";
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, displayWidth(cell));
    });
  }
  return rows
    .map((row) =>
      row
        .map((cell, i) => cell + " ".repeat((widths[i] ?? 0) - displayWidth(cell)))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

export function describeExpiry(days: number, warningDays: number): string {
  if (days < 0) return red(`expired ${-days}d ago`);
  if (days <= warningDays) return yellow(`expires in ${days}d`);
  return green(`expires in ${days}d`);
}
