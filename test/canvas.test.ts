/** Canvas pages: JSON Canvas spec mapping, CRDT reconcile semantics, the
 * agent API surface, and image upload/resize serving. */
import { describe, expect, test } from "bun:test";
import * as A from "@automerge/automerge";
import { makeWorld, until } from "./helpers";
import {
  canvasToSpec,
  emptyCanvas,
  parseSpecCanvas,
  reconcileCanvas,
  type SpecCanvas,
} from "../src/shared/canvas";
import type { MrkdwnDoc } from "../src/shared/types";
import type { ObjectMirror } from "../src/server/persist";

const note = (id: string, x = 0, extra: object = {}) => ({
  id,
  type: "text" as const,
  text: "hello",
  x,
  y: 0,
  width: 240,
  height: 150,
  ...extra,
});

describe("parseSpecCanvas", () => {
  test("accepts a valid spec document", () => {
    const spec = parseSpecCanvas({
      nodes: [note("aaaaaaaaaaaaaaaa", 10, { color: "3" }), { id: "b", type: "link", url: "https://x.dev", x: 0, y: 0, width: 100, height: 50 }],
      edges: [{ id: "e1", fromNode: "aaaaaaaaaaaaaaaa", toNode: "b", fromSide: "right", toEnd: "arrow" }],
    });
    expect(spec.nodes).toHaveLength(2);
    expect(spec.edges[0]!.fromSide).toBe("right");
  });

  test("rounds fractional coordinates to spec integers", () => {
    const spec = parseSpecCanvas({ nodes: [note("a", 10.7)], edges: [] });
    expect(spec.nodes[0]!.x).toBe(11);
  });

  test("rejects bad node types, duplicate ids, dangling edges, bad colors", () => {
    expect(() => parseSpecCanvas({ nodes: [{ id: "a", type: "video", x: 0, y: 0, width: 1, height: 1 }] })).toThrow(/type/);
    expect(() => parseSpecCanvas({ nodes: [note("a"), note("a")] })).toThrow(/duplicate/);
    expect(() => parseSpecCanvas({ nodes: [note("a")], edges: [{ id: "e", fromNode: "a", toNode: "ghost" }] })).toThrow(/toNode/);
    expect(() => parseSpecCanvas({ nodes: [note("a", 0, { color: "9" })] })).toThrow(/color/);
  });
});

describe("canvas ↔ automerge", () => {
  test("reconcile + export round-trips spec JSON", () => {
    const doc = A.from({ title: "c", content: "", comments: {}, canvas: emptyCanvas() }) as unknown as A.Doc<MrkdwnDoc>;
    const spec: SpecCanvas = parseSpecCanvas({
      nodes: [note("aaaa000000000001"), { id: "bbbb000000000002", type: "file", file: "runbook.md", x: 300, y: 0, width: 380, height: 300 }],
      edges: [{ id: "eeee000000000003", fromNode: "aaaa000000000001", toNode: "bbbb000000000002", toEnd: "arrow" }],
    });
    const next = A.change(doc, d => reconcileCanvas(d.canvas!, spec));
    expect(canvasToSpec(next.canvas)).toEqual(spec);
  });

  test("stacking order survives via z (later nodes export later)", () => {
    const doc = A.from({ title: "c", content: "", comments: {}, canvas: emptyCanvas() }) as unknown as A.Doc<MrkdwnDoc>;
    let d = A.change(doc, dd => reconcileCanvas(dd.canvas!, { nodes: [note("n1"), note("n2")], edges: [] }));
    // re-add n1 (new object) — it should now stack on top, i.e. export after n2
    d = A.change(d, dd => {
      delete dd.canvas!.nodes["n1"];
    });
    d = A.change(d, dd => reconcileCanvas(dd.canvas!, { nodes: [note("n2"), note("n1")], edges: [] }));
    expect(canvasToSpec(d.canvas).nodes.map(n => n.id)).toEqual(["n2", "n1"]);
  });

  test("agent PUT merges with a concurrent human drag", () => {
    const base = A.from({ title: "c", content: "", comments: {}, canvas: emptyCanvas() }) as unknown as A.Doc<MrkdwnDoc>;
    const seeded = A.change(base, d => reconcileCanvas(d.canvas!, { nodes: [note("n1"), note("n2")], edges: [] }));

    // human drags n1 on one fork…
    const human = A.change(A.clone(seeded), d => {
      d.canvas!.nodes["n1"]!.x = 500;
      d.canvas!.nodes["n1"]!.y = 400;
    });
    // …while the agent recolors n2 via a reconcile on another fork
    const agentSpec = canvasToSpec(seeded.canvas);
    agentSpec.nodes.find(n => n.id === "n2")!.color = "5";
    const agent = A.change(A.clone(seeded), d => reconcileCanvas(d.canvas!, agentSpec));

    const merged = A.merge(human, agent);
    expect(merged.canvas!.nodes["n1"]!.x).toBe(500); // the drag survived
    expect(merged.canvas!.nodes["n2"]!.color).toBe("5"); // the recolor landed
  });
});

describe("canvas over the API", () => {
  test("create, read, PUT, guards, and mention notifications", async () => {
    const w = await makeWorld();
    try {
      const created = await w.authed("/api/pages", {
        method: "POST",
        body: JSON.stringify({ title: "Board", kind: "canvas" }),
      });
      expect(created.status).toBe(201);
      const { page } = (await created.json()) as { page: { id: string; kind: string } };
      expect(page.kind).toBe("canvas");

      // read: canvas payload, no markdown
      const read1 = (await (await w.authed(`/api/doc?page=${page.id}`)).json()) as Record<string, unknown>;
      expect(read1.kind).toBe("canvas");
      expect(read1.canvas).toEqual({ nodes: [], edges: [] });
      expect(read1.markdown).toBeUndefined();

      // markdown-style edits are refused with a helpful hint
      const wrongEdit = await w.authed(`/api/doc/edits?page=${page.id}`, {
        method: "POST",
        body: JSON.stringify({ edits: [{ oldText: "a", newText: "b" }] }),
      });
      expect(wrongEdit.status).toBe(400);
      expect(((await wrongEdit.json()) as { error: string }).error).toContain("canvas");

      // PUT canvas with a mention on a sticky note
      const put = await w.authed(`/api/doc?page=${page.id}`, {
        method: "PUT",
        agent: "claude",
        body: JSON.stringify({
          canvas: {
            nodes: [note("aaaa000000000001", 20, { text: "hey @codex — review this board" })],
            edges: [],
          },
        }),
      });
      expect(put.status).toBe(200);
      const read2 = (await (await w.authed(`/api/doc?page=${page.id}`)).json()) as { canvas: SpecCanvas };
      expect(read2.canvas.nodes).toHaveLength(1);
      expect(read2.canvas.nodes[0]!.x).toBe(20);

      // the @mention in the text node reaches the agent's queue
      const got = await until(
        async () =>
          ((await (await w.authed("/api/notifications", { agent: "codex" })).json()) as {
            notifications: { snippet: string }[];
          }).notifications,
        n => n.length >= 1,
        6000,
        150
      );
      expect(got[0]!.snippet).toContain("review this board");

      // invalid canvas → 400 with the validator's message
      const bad = await w.authed(`/api/doc?page=${page.id}`, {
        method: "PUT",
        body: JSON.stringify({ canvas: { nodes: [{ id: "x", type: "wat", x: 0, y: 0, width: 1, height: 1 }] } }),
      });
      expect(bad.status).toBe(400);

      // canvas PUT on a markdown page → 400
      const md = await w.authed("/api/doc", { method: "PUT", body: JSON.stringify({ canvas: { nodes: [], edges: [] } }) });
      expect(md.status).toBe(400);
    } finally {
      await w.stop();
    }
  }, 20000);
});

describe("images API", () => {
  function fakeMirror(): ObjectMirror & { keys(): string[] } {
    const objects = new Map<string, Uint8Array>();
    return {
      async write(key, data) {
        objects.set(key, data);
      },
      async read(key) {
        return objects.get(key) ?? null;
      },
      keys: () => [...objects.keys()],
    };
  }

  async function testPng(size: number): Promise<Uint8Array> {
    const png1x1 = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64"
    );
    return await new Bun.Image(png1x1).resize(size, size).png().bytes();
  }

  test("upload → serve → resized variant with immutable cache headers", async () => {
    const mirror = fakeMirror();
    const w = await makeWorld({ mirror });
    try {
      const png = await testPng(64);
      const up = await fetch(`${w.base}/api/images`, {
        method: "POST",
        headers: { "content-type": "image/png" },
        body: png as unknown as BodyInit,
      });
      expect(up.status).toBe(201);
      const meta = (await up.json()) as { id: string; url: string; width: number; height: number };
      expect(meta.width).toBe(64);
      expect(mirror.keys().some(k => k.includes(meta.id))).toBe(true);

      const orig = await fetch(`${w.base}${meta.url}`);
      expect(orig.status).toBe(200);
      expect(orig.headers.get("cache-control")).toContain("immutable");
      expect(orig.headers.get("content-type")).toBe("image/png");

      const resized = await fetch(`${w.base}${meta.url}?w=32`);
      const bytes = new Uint8Array(await resized.arrayBuffer());
      const m = await new Bun.Image(bytes).metadata();
      expect(m.width).toBe(32);
      expect(resized.headers.get("etag")).toContain("w32");

      // upscales are refused silently: original comes back
      const big = await fetch(`${w.base}${meta.url}?w=2000`);
      const bigMeta = await new Bun.Image(new Uint8Array(await big.arrayBuffer())).metadata();
      expect(bigMeta.width).toBe(64);
    } finally {
      await w.stop();
    }
  }, 20000);

  test("rejects junk: bad content type, non-image bytes, and no-S3 mode", async () => {
    const mirror = fakeMirror();
    const w = await makeWorld({ mirror });
    try {
      const badType = await fetch(`${w.base}/api/images`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "hi",
      });
      expect(badType.status).toBe(415);
      const notImage = await fetch(`${w.base}/api/images`, {
        method: "POST",
        headers: { "content-type": "image/png" },
        body: "not a png",
      });
      expect(notImage.status).toBe(400);
      expect((await fetch(`${w.base}/api/images/0123456789abcdef`)).status).toBe(404);
    } finally {
      await w.stop();
    }

    const w2 = await makeWorld(); // no mirror at all
    try {
      const res = await fetch(`${w2.base}/api/images`, {
        method: "POST",
        headers: { "content-type": "image/png" },
        body: await testPng(8) as unknown as BodyInit,
      });
      expect(res.status).toBe(503);
    } finally {
      await w2.stop();
    }
  }, 20000);
});
