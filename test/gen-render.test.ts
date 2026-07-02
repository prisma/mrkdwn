/**
 * 250 generated cases for the inline cell renderer: random combinations of
 * bold/em/strike/code/links/colors/emoji (with nesting where the syntax
 * allows it) must render without throwing, produce exactly the expected
 * visible text, and emit the right styling hooks.
 *
 * Runs against a happy-dom document. Scoped to `document` only — a full
 * GlobalRegistrator.register() would replace global fetch with happy-dom's
 * same-origin-policy fetch and break the server API tests in this process.
 */
import { Window } from "happy-dom";

(globalThis as { document?: unknown }).document = new Window().document;

import { expect, test } from "bun:test";
import { get as emojiGet } from "node-emoji";
import { renderInline } from "../src/web/editor/tableWidget";
import { int, pick, rng, words } from "./genutil";

interface Node {
  md: string;
  plain: string;
  cls: string | null;
}

const EMOJI = [":+1:", ":-1:", ":sunglasses:", ":rocket:", ":warning:", ":tada:"] as const;
const COLORS = ["red", "orange", "yellow", "green", "blue", "violet", "gray", "primary", "rainbow"] as const;

function genNode(r: () => number, depth: number): Node {
  const kinds = depth > 0 ? ["word", "bold", "em", "strike", "code", "link", "color", "emoji"] : ["word", "emoji"];
  const kind = pick(r, kinds);
  switch (kind) {
    case "bold": {
      const inner = genNode(r, 0);
      return { md: `**${inner.md}**`, plain: inner.plain, cls: ".md-strong" };
    }
    case "em": {
      const t = words(r, 1, 2);
      return { md: `*${t}*`, plain: t, cls: ".md-em" };
    }
    case "strike": {
      const t = words(r, 1, 2);
      return { md: `~~${t}~~`, plain: t, cls: ".md-strike" };
    }
    case "code": {
      const t = words(r, 1, 2);
      return { md: `\`${t}\``, plain: t, cls: ".md-code" };
    }
    case "link": {
      const t = words(r, 1, 2);
      return { md: `[${t}](https://x.test/${words(r, 1, 1)})`, plain: t, cls: ".md-link" };
    }
    case "color": {
      const c = pick(r, COLORS);
      const bg = r() < 0.4;
      // colors may nest other inline markup (but no brackets)
      const inner = genNode(r, 0);
      const innerMd = pick(r, [inner.md, `${words(r, 1, 1)} ${inner.md}`]);
      const innerPlain = innerMd === inner.md ? inner.plain : `${innerMd.split(" ")[0]} ${inner.plain}`;
      return {
        md: `:${c}${bg ? "-background" : ""}[${innerMd}]`,
        plain: innerPlain,
        cls: bg ? `.md-colorbg-${c}` : `.md-color-${c}`,
      };
    }
    case "emoji": {
      const e = pick(r, EMOJI);
      return { md: e, plain: emojiGet(e)!, cls: null };
    }
    default: {
      const t = words(r, 1, 2);
      return { md: t, plain: t, cls: null };
    }
  }
}

for (let i = 0; i < 250; i++) {
  test(`renderInline generated #${i}`, () => {
    const r = rng(58000 + i);
    const nodes = Array.from({ length: int(r, 1, 6) }, () => genNode(r, 1));
    const md = nodes.map(n => n.md).join(" ");
    const out = document.createElement("div");
    renderInline(md, out);

    // exact visible text
    expect(out.textContent).toBe(nodes.map(n => n.plain).join(" "));
    // each styled construct produced its styling hook
    for (const n of nodes) if (n.cls) expect(out.querySelector(n.cls)).not.toBeNull();
    // raw syntax never leaks into the rendered text
    expect(out.textContent).not.toMatch(/\*\*|~~|]\(https?:/);
  });
}
