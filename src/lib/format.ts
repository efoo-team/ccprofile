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

export function table(rows: string[][]): string {
  if (rows.length === 0) return "";
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, stripAnsi(cell).length);
    });
  }
  return rows
    .map((row) =>
      row
        .map((cell, i) => cell + " ".repeat((widths[i] ?? 0) - stripAnsi(cell).length))
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
