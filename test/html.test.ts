/** HTML pages: the mrkdwn-size contract, the API surface, and the guards
 * that keep the three page kinds from being edited with the wrong verbs. */
import { describe, expect, test } from "bun:test";
import { makeWorld } from "./helpers";
import {
  HTML_DEFAULT,
  HTML_MAX,
  htmlRenderSize,
  parseHtmlSize,
  starterHtml,
} from "../src/shared/html";

const sized = (w: number, h: number, body = "<p>hi</p>") =>
  `<!doctype html><html><head><meta charset="utf-8"><meta name="mrkdwn-size" content="${w}x${h}"></head><body>${body}</body></html>`;

describe("parseHtmlSize", () => {
  test("reads the standard tag", () => {
    expect(parseHtmlSize(sized(960, 600))).toEqual({ width: 960, height: 600 });
  });

  test("tolerates attribute order, casing, and the × separator", () => {
    expect(parseHtmlSize(`<meta content="640x480" name="mrkdwn-size">`)).toEqual({ width: 640, height: 480 });
    expect(parseHtmlSize(`<META NAME='mrkdwn-size' CONTENT='800 × 600'>`)).toEqual({ width: 800, height: 600 });
  });

  test("null when missing or garbled", () => {
    expect(parseHtmlSize("<!doctype html><html></html>")).toBeNull();
    expect(parseHtmlSize(`<meta name="mrkdwn-size" content="huge">`)).toBeNull();
    expect(parseHtmlSize(`<meta name="viewport" content="width=device-width">`)).toBeNull();
  });

  test("render size clamps into range and defaults when undeclared", () => {
    expect(htmlRenderSize(sized(4000, 40))).toEqual({ width: HTML_MAX.width, height: 160 });
    expect(htmlRenderSize("")).toEqual(HTML_DEFAULT);
  });

  test("the starter document is valid", () => {
    expect(parseHtmlSize(starterHtml("My <dash>"))).toEqual({ width: 800, height: 600 });
  });
});

describe("html pages over the API", () => {
  test("create, read, replace, surgical edits, and kind guards", async () => {
    const w = await makeWorld();
    try {
      const created = await w.authed("/api/pages", {
        method: "POST",
        body: JSON.stringify({ title: "Dashboard", kind: "html" }),
      });
      expect(created.status).toBe(201);
      const { page } = (await created.json()) as { page: { id: string; kind: string } };
      expect(page.kind).toBe("html");

      // a fresh page is seeded with the sized starter document
      const read1 = (await (await w.authed(`/api/doc?page=${page.id}`)).json()) as Record<string, unknown>;
      expect(read1.kind).toBe("html");
      expect(read1.markdown).toBeUndefined();
      expect(read1.size).toEqual({ width: 800, height: 600 });
      expect(String(read1.html)).toContain("mrkdwn-size");

      // PUT without the size declaration is refused with the fix in the message
      const unsized = await w.authed(`/api/doc?page=${page.id}`, {
        method: "PUT",
        body: JSON.stringify({ html: "<!doctype html><html><body>nope</body></html>" }),
      });
      expect(unsized.status).toBe(400);
      expect(((await unsized.json()) as { error: string }).error).toContain("mrkdwn-size");

      // oversized declarations are refused, not clamped
      const huge = await w.authed(`/api/doc?page=${page.id}`, {
        method: "PUT",
        body: JSON.stringify({ html: sized(3000, 2000) }),
      });
      expect(huge.status).toBe(400);
      expect(((await huge.json()) as { error: string }).error).toContain("out of range");

      // a valid document replaces the content and reports its size
      const put = await w.authed(`/api/doc?page=${page.id}`, {
        method: "PUT",
        agent: "claude",
        body: JSON.stringify({ html: sized(960, 600, "<h1>v1</h1>") }),
      });
      expect(put.status).toBe(200);
      const read2 = (await (await w.authed(`/api/doc?page=${page.id}`)).json()) as { html: string; size: object };
      expect(read2.html).toContain("<h1>v1</h1>");
      expect(read2.size).toEqual({ width: 960, height: 600 });

      // raw source comes back as text/plain (never rendered on the app origin)
      const raw = await w.authed(`/api/doc?page=${page.id}&format=html`);
      expect(raw.headers.get("content-type")).toContain("text/plain");
      expect(await raw.text()).toContain("<h1>v1</h1>");
      expect((await w.authed(`/api/doc?page=${page.id}&format=markdown`)).status).toBe(400);

      // surgical edits work on the source like any text
      const edit = await w.authed(`/api/doc/edits?page=${page.id}`, {
        method: "POST",
        agent: "claude",
        body: JSON.stringify({ edits: [{ oldText: "<h1>v1</h1>", newText: "<h1>v2</h1>" }] }),
      });
      expect(edit.status).toBe(200);
      const read3 = (await (await w.authed(`/api/doc?page=${page.id}`)).json()) as { html: string };
      expect(read3.html).toContain("<h1>v2</h1>");

      // …but an edit that would break the size declaration is refused
      const breakMeta = await w.authed(`/api/doc/edits?page=${page.id}`, {
        method: "POST",
        body: JSON.stringify({ edits: [{ oldText: `<meta name="mrkdwn-size" content="960x600">`, newText: "" }] }),
      });
      expect(breakMeta.status).toBe(400);
      expect(((await breakMeta.json()) as { error: string }).error).toContain("mrkdwn-size");

      // append and markdown writes don't apply to html pages
      const append = await w.authed(`/api/doc/append?page=${page.id}`, {
        method: "POST",
        body: JSON.stringify({ markdown: "## nope" }),
      });
      expect(append.status).toBe(400);
      const asMd = await w.authed(`/api/doc?page=${page.id}`, {
        method: "PUT",
        body: JSON.stringify({ markdown: "# nope" }),
      });
      expect(asMd.status).toBe(400);

      // and html writes don't apply to markdown pages
      const onMd = await w.authed("/api/doc", { method: "PUT", body: JSON.stringify({ html: sized(800, 600) }) });
      expect(onMd.status).toBe(400);
    } finally {
      await w.stop();
    }
  }, 20000);
});
