import { describe, expect, test } from "bun:test";
import { zipSync, unzipSync } from "fflate";
import { makeWorld } from "./helpers";
import type { ObjectMirror } from "../src/server/persist";
import { blobKey } from "../src/server/hyperframes";
import { cleanProjectPath, parseCompositionSize, pickEntrypoint } from "../src/shared/hyperframes";

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

const COMPOSITION = `<!doctype html>
<html><head><meta charset="utf-8"><title>t</title></head>
<body>
<div id="root" data-composition-id="main" data-width="1280" data-height="720" data-duration="4">
  <section class="clip" data-start="0" data-duration="4" data-track-index="1"><h1 id="title">Zip upload</h1></section>
</div>
<script>window.__timelines = { main: null };</script>
</body></html>`;

describe("shared hyperframes helpers", () => {
  test("cleanProjectPath normalizes and rejects traversal", () => {
    expect(cleanProjectPath("./assets/logo.png")).toBe("assets/logo.png");
    expect(cleanProjectPath("/index.html")).toBe("index.html");
    expect(cleanProjectPath("../evil")).toBeNull();
    expect(cleanProjectPath("a/../b")).toBeNull();
    expect(cleanProjectPath("a\\b")).toBeNull();
    expect(cleanProjectPath("")).toBeNull();
  });

  test("pickEntrypoint prefers index.html (shallowest), then shallowest html", () => {
    expect(pickEntrypoint(["compositions/intro.html", "index.html", "notes.md"])).toBe("index.html");
    // an index.html anywhere beats a non-index html (sub-composition zips)
    expect(pickEntrypoint(["deep/nested/index.html", "shallow.html"])).toBe("deep/nested/index.html");
    expect(pickEntrypoint(["a/b/one.html", "a/two.html"])).toBe("a/two.html");
    expect(pickEntrypoint(["notes.md"])).toBeUndefined();
  });

  test("parseCompositionSize reads the composition root", () => {
    expect(parseCompositionSize(COMPOSITION)).toEqual({ width: 1280, height: 720 });
    expect(parseCompositionSize("<div>no composition</div>")).toBeNull();
  });
});

describe("fork", () => {
  test("forks any page into an independent document with lineage", async () => {
    const w = await makeWorld();
    try {
      // seed content on the default (markdown) page
      const put = await w.authed("/api/doc", {
        method: "PUT",
        agent: "tester",
        body: JSON.stringify({ markdown: "# Original\n\nshared line" }),
      });
      expect(put.status).toBe(200);
      const source = (await (await w.authed("/api/doc")).json()) as { page: { id: string } };

      const forkRes = await fetch(`${w.base}/api/pages/fork`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ page: source.page.id }),
      });
      expect(forkRes.status).toBe(201);
      const fork = (await forkRes.json()) as { page: { id: string; title: string; forkedFromId?: string } };
      expect(fork.page.id).not.toBe(source.page.id);
      expect(fork.page.forkedFromId).toBe(source.page.id);
      expect(fork.page.title).toContain("(fork)");

      // fork carries the content...
      const forkDoc = (await (await w.authed(`/api/doc?page=${fork.page.id}`)).json()) as { markdown: string };
      expect(forkDoc.markdown).toContain("shared line");

      // ...and edits to the fork never reach the source
      const edit = await w.authed(`/api/doc/edits?page=${fork.page.id}`, {
        method: "POST",
        agent: "tester",
        body: JSON.stringify({ edits: [{ oldText: "shared line", newText: "forked line" }] }),
      });
      expect(edit.status).toBe(200);
      const sourceDoc = (await (await w.authed(`/api/doc?page=${source.page.id}`)).json()) as { markdown: string };
      expect(sourceDoc.markdown).toContain("shared line");
      expect(sourceDoc.markdown).not.toContain("forked line");
    } finally {
      await w.stop();
    }
  }, 20000);

  test("fork accepts a custom title and preserves kind", async () => {
    const w = await makeWorld();
    try {
      const created = (await (
        await fetch(`${w.base}/api/pages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "Video", kind: "hyperframes" }),
        })
      ).json()) as { page: { id: string } };

      const forkRes = await fetch(`${w.base}/api/pages/fork`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ page: created.page.id, title: "Video v2" }),
      });
      const fork = (await forkRes.json()) as { page: { id: string; title: string; kind: string } };
      expect(fork.page.title).toBe("Video v2");
      expect(fork.page.kind).toBe("hyperframes");
    } finally {
      await w.stop();
    }
  }, 20000);
});

describe("hyperframes pages", () => {
  test("created with a starter project; file API reads/writes/deletes", async () => {
    const w = await makeWorld();
    try {
      const created = (await (
        await fetch(`${w.base}/api/pages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "Promo", kind: "hyperframes" }),
        })
      ).json()) as { page: { id: string; kind: string } };
      expect(created.page.kind).toBe("hyperframes");
      const pq = `?page=${created.page.id}`;

      // doc payload carries the manifest + preview url
      const doc = (await (await w.authed(`/api/doc${pq}`)).json()) as {
        kind: string;
        entrypoint: string;
        files: { path: string }[];
        preview: string;
        size: { width: number };
      };
      expect(doc.kind).toBe("hyperframes");
      expect(doc.entrypoint).toBe("index.html");
      expect(doc.files.map(f => f.path)).toContain("index.html");
      expect(doc.preview).toContain(`/preview/${created.page.id}/player`);
      expect(doc.size.width).toBe(1280);

      // read raw
      const raw = await w.authed(`/api/hf/file${pq}&path=index.html`);
      expect(raw.status).toBe(200);
      expect(await raw.text()).toContain("data-composition-id");

      // surgical edit inside a file
      const edit = await w.authed(`/api/doc/edits${pq}`, {
        method: "POST",
        agent: "tester",
        body: JSON.stringify({
          file: "index.html",
          edits: [{ oldText: '<h1 id="title">Promo</h1>', newText: '<h1 id="title">Launch film</h1>' }],
        }),
      });
      expect(edit.status).toBe(200);
      expect(await (await w.authed(`/api/hf/file${pq}&path=index.html`)).text()).toContain("Launch film");

      // edits without a file param are rejected with a hint
      const noFile = await w.authed(`/api/doc/edits${pq}`, {
        method: "POST",
        agent: "tester",
        body: JSON.stringify({ edits: [{ oldText: "a", newText: "b" }] }),
      });
      expect(noFile.status).toBe(400);

      // append never applies
      const append = await w.authed(`/api/doc/append${pq}`, {
        method: "POST",
        agent: "tester",
        body: JSON.stringify({ markdown: "nope" }),
      });
      expect(append.status).toBe(400);

      // write a new file, then delete it
      const putFile = await w.authed(`/api/hf/file${pq}`, {
        method: "PUT",
        agent: "tester",
        body: JSON.stringify({ path: "styles.css", content: "h1 { color: red; }" }),
      });
      expect(putFile.status).toBe(201);
      const del = await w.authed(`/api/hf/file${pq}&path=styles.css`, { method: "DELETE", agent: "tester" });
      expect(del.status).toBe(200);

      // the entrypoint refuses deletion; traversal paths bounce
      expect((await w.authed(`/api/hf/file${pq}&path=index.html`, { method: "DELETE", agent: "tester" })).status).toBe(400);
      expect((await w.authed(`/api/hf/file${pq}&path=../../etc/passwd`)).status).toBe(400);

      // markdown body on a hyperframes page bounces
      const wrongBody = await w.authed(`/api/doc${pq}`, {
        method: "PUT",
        agent: "tester",
        body: JSON.stringify({ markdown: "# no" }),
      });
      expect(wrongBody.status).toBe(400);
    } finally {
      await w.stop();
    }
  }, 20000);

  test("kimi endpoint 404s when unconfigured", async () => {
    const w = await makeWorld();
    try {
      const created = (await (
        await fetch(`${w.base}/api/pages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: "V", kind: "hyperframes" }),
        })
      ).json()) as { page: { id: string } };
      const res = await fetch(`${w.base}/api/kimi/chat?page=${created.page.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "hi" }),
      });
      expect(res.status).toBe(404);
      // and status reports the feature off
      const status = (await (await fetch(`${w.base}/api/status`)).json()) as { kimi: boolean; previewOrigin: string };
      expect(status.kimi).toBe(false);
      expect(status.previewOrigin).toContain("127.0.0.1");
    } finally {
      await w.stop();
    }
  }, 20000);
});

describe("zip upload → preview → export", () => {
  const logoBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

  function projectZip(): Uint8Array {
    return zipSync({
      // wrapped in a folder like real zips; junk that must be dropped
      "myvideo/index.html": new TextEncoder().encode(COMPOSITION),
      "myvideo/assets/style.css": new TextEncoder().encode("h1 { font-size: 96px; }"),
      "myvideo/assets/logo.png": logoBytes,
      "myvideo/node_modules/gsap/index.js": new TextEncoder().encode("skip me"),
      "__MACOSX/junk": new TextEncoder().encode("junk"),
      "myvideo/.DS_Store": new TextEncoder().encode("junk"),
    });
  }

  test("full roundtrip with content-addressed blobs", async () => {
    const mirror = fakeMirror();
    const w = await makeWorld({ mirror });
    try {
      const up = await fetch(`${w.base}/api/hyperframes/upload?title=My video`, {
        method: "POST",
        headers: { "content-type": "application/zip" },
        body: projectZip().slice().buffer as ArrayBuffer,
      });
      expect(up.status).toBe(201);
      const result = (await up.json()) as {
        page: { id: string; slug: string; automergeUrl: string };
        filesImported: number;
        blobsStored: number;
      };
      // wrapper folder stripped, node_modules + junk dropped
      expect(result.filesImported).toBe(3);
      expect(result.blobsStored).toBe(1);
      expect(mirror.keys().some(k => k.startsWith("blobs/"))).toBe(true);
      const id = result.page.id;

      // text file served live (redirected to the preview origin: localhost → 127.0.0.1)
      const entry = await fetch(`${w.base}/preview/${id}/live/index.html`);
      expect(entry.status).toBe(200);
      expect(entry.headers.get("content-type")).toContain("text/html");
      expect(await entry.text()).toContain("data-composition-id");
      expect(entry.url).toContain("127.0.0.1"); // compositions never execute on the app origin

      // blob served with etag + range support
      const blob = await fetch(`${w.base}/preview/${id}/live/assets/logo.png`);
      expect(blob.status).toBe(200);
      expect(new Uint8Array(await blob.arrayBuffer())).toEqual(logoBytes);
      const etag = blob.headers.get("etag")!;
      expect(etag).toBeTruthy();
      const ranged = await fetch(`${w.base}/preview/${id}/live/assets/logo.png`, {
        headers: { range: "bytes=0-3" },
      });
      expect(ranged.status).toBe(206);
      expect((await ranged.arrayBuffer()).byteLength).toBe(4);

      // player shell references the entrypoint
      const shell = await fetch(`${w.base}/preview/${id}/player`);
      expect(shell.status).toBe(200);
      const shellHtml = await shell.text();
      expect(shellHtml).toContain("<hyperframes-player");
      expect(shellHtml).toContain(`/preview/${id}/live/index.html`);

      // the player script itself is served
      const player = await fetch(`${w.base}/preview/__assets__/player.js`);
      expect(player.status).toBe(200);

      // unknown paths & traversal 404
      expect((await fetch(`${w.base}/preview/${id}/live/nope.js`)).status).toBe(404);
      expect((await fetch(`${w.base}/preview/${id}/live/..%2f..%2fsecret`)).status).toBe(404);

      // fork shares the blob without copying
      const fork = (await (
        await fetch(`${w.base}/api/pages/fork`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ page: id }),
        })
      ).json()) as { page: { id: string } };
      const forkBlob = await fetch(`${w.base}/preview/${fork.page.id}/live/assets/logo.png`);
      expect(forkBlob.status).toBe(200);
      expect(mirror.keys().filter(k => k.startsWith("blobs/")).length).toBe(1); // still one copy

      // export roundtrips text + blob bytes
      const exported = await fetch(`${w.base}/api/hyperframes/export?page=${id}`);
      expect(exported.status).toBe(200);
      const files = unzipSync(new Uint8Array(await exported.arrayBuffer()));
      expect(new TextDecoder().decode(files["index.html"]!)).toContain("data-composition-id");
      expect(new Uint8Array(files["assets/logo.png"]!)).toEqual(logoBytes);
    } finally {
      await w.stop();
    }
  }, 30000);

  test("zip without an html entrypoint is rejected", async () => {
    const w = await makeWorld({ mirror: fakeMirror() });
    try {
      const zip = zipSync({ "notes.md": new TextEncoder().encode("# just notes") });
      const up = await fetch(`${w.base}/api/hyperframes/upload`, {
        method: "POST",
        headers: { "content-type": "application/zip" },
        body: zip.slice().buffer as ArrayBuffer,
      });
      expect(up.status).toBe(400);
    } finally {
      await w.stop();
    }
  }, 20000);

  test("preview 404s for non-hyperframes pages", async () => {
    const w = await makeWorld();
    try {
      const pages = (await (await fetch(`${w.base}/api/workspace`)).json()) as { pages: { id: string }[] };
      const res = await fetch(`${w.base}/preview/${pages.pages[0]!.id}/live/index.html`);
      expect(res.status).toBe(404);
    } finally {
      await w.stop();
    }
  }, 20000);
});

// blobKey is part of the persistence contract — pin it
test("blob keys are content-addressed", () => {
  expect(blobKey("abc123")).toBe("blobs/abc123");
});
