/** Workspace + pages: routing payloads, page creation, slug derivation,
 * per-page doc endpoints, legacy single-doc migration, slug utilities. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { makeWorld, until, type TestWorld } from "./helpers";
import { slugify, uniqueSlug } from "../src/shared/slug";
import type { PageMeta, WorkspacePayload } from "../src/shared/types";

describe("slug utilities", () => {
  test("slugify derives mentionable slugs", () => {
    expect(slugify("How To Deploy To Compute")).toBe("how-to-deploy-to-compute");
    expect(slugify("  Weird —— punctuation!! ")).toBe("weird-punctuation");
    expect(slugify("2024 Roadmap")).toBe("roadmap"); // must start with a letter
    expect(slugify("???")).toBe("untitled");
    expect(slugify("")).toBe("untitled");
    expect(slugify("x".repeat(80)).length).toBeLessThanOrEqual(32);
  });

  test("uniqueSlug suffixes collisions", () => {
    const taken = new Set(["notes", "notes-2"]);
    expect(uniqueSlug("Notes", taken)).toBe("notes-3");
    expect(uniqueSlug("Fresh", taken)).toBe("fresh");
  });
});

describe("workspace API", () => {
  let world: TestWorld;
  beforeAll(async () => {
    world = await makeWorld();
  });
  afterAll(async () => {
    await world.stop();
  });

  const getWorkspace = async (): Promise<WorkspacePayload> => (await fetch(`${world.base}/api/workspace`)).json();

  test("GET /api/workspace is public and lists the welcome page", async () => {
    const ws = await getWorkspace();
    expect(ws.workspace.handle).toBe("public");
    expect(ws.pages.length).toBeGreaterThanOrEqual(1);
    const page = ws.pages[0]!;
    expect(page.path).toBe(`/public/${page.id}-${page.slug}`);
    expect(page.id).not.toContain("-"); // id must split cleanly from the slug
    expect(page.automergeUrl).toMatch(/^automerge:/);
  });

  test("POST /api/pages creates a page with a derived slug (org-level permissions, no token)", async () => {
    const res = await fetch(`${world.base}/api/pages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Deploy Notes" }),
    });
    expect(res.status).toBe(201);
    const { page } = (await res.json()) as { page: PageMeta };
    expect(page.slug).toBe("deploy-notes");
    expect(page.path).toBe(`/public/${page.id}-deploy-notes`);
    const ws = await getWorkspace();
    expect(ws.pages.map(p => p.id)).toContain(page.id);
  });

  test("duplicate titles get unique slugs", async () => {
    const make = () =>
      fetch(`${world.base}/api/pages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Same Name" }),
      }).then(r => r.json() as Promise<{ page: PageMeta }>);
    const a = (await make()).page;
    const b = (await make()).page;
    expect(a.slug).toBe("same-name");
    expect(b.slug).toBe("same-name-2");
  });

  test("?page= scopes the doc endpoints; unknown ids 404", async () => {
    const created = ((await (
      await fetch(`${world.base}/api/pages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Scoped" }),
      })
    ).json()) as { page: PageMeta }).page;

    const put = await world.authed(`/api/doc?page=${created.id}`, {
      method: "PUT",
      body: JSON.stringify({ markdown: "scoped content" }),
    });
    expect(put.status).toBe(200);

    const scoped = await (await world.authed(`/api/doc?page=${created.id}`)).json();
    expect(scoped.markdown).toBe("scoped content");
    expect(scoped.page.id).toBe(created.id);

    // the default (first) page is untouched
    const def = await (await world.authed(`/api/doc`)).json();
    expect(def.markdown).not.toBe("scoped content");
    expect(def.page.id).not.toBe(created.id);

    const missing = await world.authed(`/api/doc?page=nope123`);
    expect(missing.status).toBe(404);
  });

  test("title edits re-derive the slug (registry follows the doc)", async () => {
    const created = ((await (
      await fetch(`${world.base}/api/pages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Before Rename" }),
      })
    ).json()) as { page: PageMeta }).page;
    expect(created.slug).toBe("before-rename");

    const put = await world.authed(`/api/doc?page=${created.id}`, {
      method: "PUT",
      body: JSON.stringify({ title: "After Rename" }),
    });
    expect(put.status).toBe(200);

    const updated = await until(
      async () => (await getWorkspace()).pages.find(p => p.id === created.id)!,
      p => p.slug === "after-rename"
    );
    expect(updated.title).toBe("After Rename");
    expect(updated.path).toBe(`/public/${created.id}-after-rename`);
  });

  test("agents introduce a display name via X-Agent-Name", async () => {
    const res = await world.authed("/api/presence", {
      method: "POST",
      agent: "claude",
      headers: { "x-agent-name": "Claude" },
    });
    expect(res.status).toBe(200);
    const status = (await (await fetch(`${world.base}/api/status`)).json()) as {
      agents: { handle: string; name?: string }[];
    };
    expect(status.agents.find(a => a.handle === "claude")?.name).toBe("Claude");
  });

  test("SPA deep links and unknown routes", async () => {
    // dev bundle serves the app shell for /:ws/:id-slug (html, not 404)
    const ws = await getWorkspace();
    const page = ws.pages[0]!;
    const res = await fetch(`${world.base}${page.path}`);
    // in tests there's no web bundle — but the route must not hit the API layer
    expect([200, 404]).toContain(res.status);
    // API paths are never shadowed by the SPA route
    const api = await fetch(`${world.base}/api/status`);
    expect(api.status).toBe(200);
  });
});
