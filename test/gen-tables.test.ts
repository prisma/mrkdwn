/**
 * 250 generated cases for the table model: parse ⇄ serialize round-trips over
 * random shapes/alignments/cell content (markdown, escaped pipes, emoji,
 * empties), the add-row/add-column mutations the widget performs, and
 * normalizeCell's newline/pipe hygiene.
 */
import { expect, test } from "bun:test";
import { normalizeCell, parseTable, serializeTable, splitRow, type TableData } from "../src/web/editor/tableWidget";
import { int, pick, rng, words } from "./genutil";

const CELLS = [
  "",
  () => words(rngShared),
  () => `**${words(rngShared, 1, 2)}**`,
  () => `\`${words(rngShared, 1, 1)}\``,
  () => `~~${words(rngShared, 1, 2)}~~`,
  () => `:red[${words(rngShared, 1, 2)}]`,
  () => `:blue-background[${words(rngShared, 1, 2)}]`,
  () => `${words(rngShared, 1, 1)} \\| ${words(rngShared, 1, 1)}`,
  ":+1:",
  () => `[${words(rngShared, 1, 1)}](https://x.test/p)`,
] as const;

let rngShared: () => number;

function cell(r: () => number): string {
  const c = pick(r, CELLS);
  return typeof c === "function" ? c() : c;
}

function genTable(r: () => number): TableData {
  const cols = int(r, 1, 6);
  const aligns = Array.from({ length: cols }, () => pick(r, [null, "left", "center", "right"] as const));
  const header = Array.from({ length: cols }, () => cell(r));
  const rows = Array.from({ length: int(r, 0, 6) }, () => Array.from({ length: cols }, () => cell(r)));
  return { header, aligns, rows };
}

for (let i = 0; i < 250; i++) {
  test(`table model generated #${i}`, () => {
    const r = (rngShared = rng(93000 + i));
    const data = genTable(r);

    // serialize → parse round-trips exactly
    const text = serializeTable(data);
    const back = parseTable(text);
    expect(back).toEqual(data);
    // serialization is canonical (stable under a second round-trip)
    expect(serializeTable(back!)).toBe(text);
    // every serialized line is a single line
    for (const line of text.split("\n")) expect(line).not.toContain("\n");

    const kind = i % 3;
    if (kind === 0) {
      // add column (what the + strip does): every row grows by one
      data.header.push("");
      data.aligns.push(null);
      for (const row of data.rows) row.push("");
      const grown = parseTable(serializeTable(data))!;
      expect(grown.header.length).toBe(data.header.length);
      for (const row of grown.rows) expect(row.length).toBe(data.header.length);
    } else if (kind === 1) {
      // add row: dimensions stay rectangular
      data.rows.push(data.header.map(() => ""));
      const grown = parseTable(serializeTable(data))!;
      expect(grown.rows.length).toBe(data.rows.length);
      expect(grown.rows[grown.rows.length - 1]).toEqual(data.header.map(() => ""));
    } else {
      // cell edit hygiene: normalizeCell output is single-line, trimmed, and
      // pipe-safe, and survives a row round-trip
      const dirty = [words(r), "|", words(r, 0, 1), "\n", pick(r, ["a|b", "x \\| y", "  padded  ", "||"])].join(" ");
      const clean = normalizeCell(dirty);
      expect(clean).not.toContain("\n");
      expect(/(?<!\\)\|/.test(clean)).toBe(false);
      expect(clean).toBe(clean.trim());
      const row = data.header.map(() => clean);
      expect(splitRow(`| ${row.join(" | ")} |`)).toEqual(row);
    }
  });
}
