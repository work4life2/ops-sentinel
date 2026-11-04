/** Display width in a monospace terminal: CJK and fullwidth characters take two columns. */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    w += isWide(cp) ? 2 : 1;
  }
  return w;
}

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
    (cp >= 0xffe0 && cp <= 0xffe6)
  );
}

function pad(s: string, width: number, align: "left" | "right"): string {
  const gap = " ".repeat(Math.max(0, width - displayWidth(s)));
  return align === "right" ? gap + s : s + gap;
}

/** Render rows (first row = header) as an aligned text table. `right` lists right-aligned column indexes. */
export function textTable(rows: string[][], right: number[] = []): string {
  if (!rows.length) return "";
  const cols = Math.max(...rows.map((r) => r.length));
  const widths = Array.from({ length: cols }, (_, c) => Math.max(...rows.map((r) => displayWidth(r[c] ?? ""))));
  const line = (r: string[]) =>
    widths.map((w, c) => pad(r[c] ?? "", w, right.includes(c) ? "right" : "left")).join("  ").trimEnd();
  const rule = widths.map((w) => "-".repeat(w)).join("  ");
  return [line(rows[0]), rule, ...rows.slice(1).map(line)].join("\n");
}
