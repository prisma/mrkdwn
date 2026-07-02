import { afterAll, beforeAll, expect, test } from "bun:test";
import { makeWorld, until, type TestWorld } from "./helpers";

let w: TestWorld;

beforeAll(async () => {
  w = await makeWorld();
});

afterAll(async () => {
  await w.stop();
});

const doc = async () => (await (await w.authed("/api/doc")).json()) as { title: string; markdown: string };

test("auth: /api/doc requires the bearer token, /api/status does not", async () => {
  expect((await fetch(`${w.base}/api/doc`)).status).toBe(401);
  expect((await fetch(`${w.base}/api/doc`, { headers: { authorization: "Bearer nope" } })).status).toBe(401);
  expect((await fetch(`${w.base}/api/status`)).status).toBe(200);
});

test("GET /api/doc returns json and raw markdown", async () => {
  const d = await doc();
  expect(d.title).toBe("Welcome to mrkdwn");
  expect(d.markdown).toContain("humans and AI agents write together");
  const raw = await w.authed("/api/doc?format=markdown");
  expect(raw.headers.get("content-type")).toContain("text/markdown");
  expect(await raw.text()).toBe(d.markdown);
});

test("POST /api/doc/edits applies exact-match replacements", async () => {
  const res = await w.authed("/api/doc/edits", {
    method: "POST",
    agent: "claude",
    body: JSON.stringify({ edits: [{ oldText: "## Your workspace", newText: "## Your workspace!" }] }),
  });
  expect(res.status).toBe(200);
  expect((await doc()).markdown).toContain("## Your workspace!");
});

test("edits: 409 with hint when oldText is missing, nothing applied on failure", async () => {
  const before = (await doc()).markdown;
  const res = await w.authed("/api/doc/edits", {
    method: "POST",
    body: JSON.stringify({
      edits: [
        { oldText: "## Never lose a word", newText: "## HELLO" }, // would apply…
        { oldText: "text-that-does-not-exist", newText: "x" }, // …but this fails
      ],
    }),
  });
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: string }).error).toContain("not found");
  expect((await doc()).markdown).toBe(before); // atomic: first edit rolled back
});

test("edits: 409 on ambiguity unless replaceAll", async () => {
  await w.authed("/api/doc/append", { method: "POST", body: JSON.stringify({ markdown: "dupe dupe" }) });
  const res = await w.authed("/api/doc/edits", {
    method: "POST",
    body: JSON.stringify({ edits: [{ oldText: "dupe", newText: "dup" }] }),
  });
  expect(res.status).toBe(409);
  expect(((await res.json()) as { error: string }).error).toContain("locations");

  const ok = await w.authed("/api/doc/edits", {
    method: "POST",
    body: JSON.stringify({ edits: [{ oldText: "dupe", newText: "dup", replaceAll: true }] }),
  });
  expect(ok.status).toBe(200);
  const after = (await doc()).markdown;
  expect(after).toContain("dup dup");
  expect(after).not.toContain("dupe");
});

test("append adds a blank-line separator", async () => {
  await w.authed("/api/doc/append", { method: "POST", body: JSON.stringify({ markdown: "## Appended" }) });
  expect((await doc()).markdown).toMatch(/\n\n## Appended/);
});

test("PUT /api/doc replaces content and title", async () => {
  const res = await w.authed("/api/doc", {
    method: "PUT",
    agent: "claude",
    body: JSON.stringify({ markdown: "# Fresh start\n\nBody.\n", title: "Fresh" }),
  });
  expect(res.status).toBe(200);
  const d = await doc();
  expect(d.title).toBe("Fresh");
  expect(d.markdown).toBe("# Fresh start\n\nBody.\n");
});

test("comments: anchored create → reply → resolve, with live range tracking", async () => {
  const create = await w.authed("/api/comments", {
    method: "POST",
    agent: "claude",
    body: JSON.stringify({ anchorText: "Body.", body: "Rename this? @codex" }),
  });
  expect(create.status).toBe(201);
  const { comment } = (await create.json()) as { comment: { id: string; range: { start: number; end: number } } };
  expect(comment.range).not.toBeNull();

  // an edit before (and disjoint from) the anchor shifts the tracked range
  await w.authed("/api/doc/edits", {
    method: "POST",
    body: JSON.stringify({ edits: [{ oldText: "Fresh start", newText: "A very fresh start" }] }),
  });
  const list = (await (await w.authed("/api/comments")).json()) as {
    comments: { id: string; range: { start: number; end: number }; quote: string }[];
  };
  const listed = list.comments.find(c => c.id === comment.id)!;
  expect(listed.quote).toBe("Body.");
  expect(listed.range.start).toBe(comment.range.start + "A very fresh start".length - "Fresh start".length);

  const reply = await w.authed(`/api/comments/${comment.id}/replies`, {
    method: "POST",
    agent: "claude",
    body: JSON.stringify({ body: "Done." }),
  });
  expect(reply.status).toBe(201);

  const resolve = await w.authed(`/api/comments/${comment.id}/resolve`, { method: "POST", agent: "claude" });
  expect(resolve.status).toBe(200);
  const open = (await (await w.authed("/api/comments")).json()) as { comments: unknown[] };
  expect(open.comments).toHaveLength(0);
  const all = (await (await w.authed("/api/comments?includeResolved=1")).json()) as { comments: unknown[] };
  expect(all.comments).toHaveLength(1);
});

test("comments: ambiguous anchors need an occurrence", async () => {
  await w.authed("/api/doc/append", { method: "POST", body: JSON.stringify({ markdown: "twin\n\ntwin" }) });
  const bad = await w.authed("/api/comments", {
    method: "POST",
    agent: "claude",
    body: JSON.stringify({ anchorText: "twin", body: "which one?" }),
  });
  expect(bad.status).toBe(409);
  const good = await w.authed("/api/comments", {
    method: "POST",
    agent: "claude",
    body: JSON.stringify({ anchorText: "twin", body: "this one", occurrence: 2 }),
  });
  expect(good.status).toBe(201);
});

test("mentions in the welcome doc do not notify (baseline), new ones do", async () => {
  // fresh world: welcome doc contains @claude but the baseline scan swallowed it
  const first = (await (await w.authed("/api/notifications", { agent: "claude" })).json()) as {
    notifications: unknown[];
  };
  // (doc was PUT-replaced above; any queue here would be from that — assert shape only)
  expect(Array.isArray(first.notifications)).toBe(true);

  const w2 = await makeWorld();
  try {
    const base = (await (await w2.authed("/api/notifications", { agent: "claude" })).json()) as {
      notifications: unknown[];
    };
    expect(base.notifications).toHaveLength(0);

    await w2.authed("/api/doc/append", {
      method: "POST",
      body: JSON.stringify({ markdown: "- [ ] @claude please tighten the intro" }),
    });
    const got = await until(
      async () =>
        ((await (await w2.authed("/api/notifications", { agent: "claude" })).json()) as {
          notifications: { kind: string; snippet: string; id: string }[];
        }).notifications,
      n => n.length > 0,
      6000,
      200
    );
    expect(got[0]!.kind).toBe("doc-mention");
    expect(got[0]!.snippet).toContain("@claude please tighten");

    // ack clears the queue
    await w2.authed("/api/notifications/ack", {
      method: "POST",
      agent: "claude",
      body: JSON.stringify({ ids: [got[0]!.id] }),
    });
    const after = (await (await w2.authed("/api/notifications", { agent: "claude" })).json()) as {
      notifications: unknown[];
    };
    expect(after.notifications).toHaveLength(0);
  } finally {
    await w2.stop();
  }
}, 20000);

test("comment mentions notify and long-poll wakes up early", async () => {
  const w2 = await makeWorld();
  try {
    const poll = w2.authed("/api/notifications?wait=15", { agent: "codex" });
    await new Promise(r => setTimeout(r, 300));
    const started = Date.now();
    await w2.authed("/api/comments", {
      method: "POST",
      agent: "claude",
      body: JSON.stringify({ anchorText: "break things", body: "hey @codex take a look" }),
    });
    const res = (await (await poll).json()) as { notifications: { kind: string; commentId?: string }[] };
    expect(Date.now() - started).toBeLessThan(10_000); // woke before the 15s wait
    expect(res.notifications).toHaveLength(1);
    expect(res.notifications[0]!.kind).toBe("comment-mention");
    expect(res.notifications[0]!.commentId).toBeDefined();
  } finally {
    await w2.stop();
  }
}, 25000);

test("unknown handles do not notify until the agent makes first contact", async () => {
  const w2 = await makeWorld();
  try {
    await w2.authed("/api/doc/append", {
      method: "POST",
      body: JSON.stringify({ markdown: "hello @mysteryagent" }),
    });
    await new Promise(r => setTimeout(r, 2000)); // let the debounced scan run
    // a mention alone doesn't conjure an agent — the registry is untouched
    const status = (await (await fetch(`${w2.base}/api/status`)).json()) as { agents: { handle: string }[] };
    expect(status.agents.map(a => a.handle)).not.toContain("mysteryagent");

    // the invite is handle-less (agents name themselves) and page-scoped
    const setup = await fetch(`${w2.base}/api/agent-setup`);
    expect(setup.status).toBe(200);
    const snippet = await setup.text();
    expect(snippet).toContain("X-Agent: <handle>");
    expect(snippet).toContain("?page=");

    // the agent's first authenticated request registers its self-chosen
    // handle and delivers the mention that was already waiting for it
    await w2.authed("/api/doc/append", {
      method: "POST",
      body: JSON.stringify({ markdown: "again @mysteryagent" }),
    });
    const got = await until(
      async () =>
        ((await (await w2.authed("/api/notifications", { agent: "mysteryagent" })).json()) as {
          notifications: { snippet: string }[];
        }).notifications,
      n => n.length >= 2,
      6000,
      200
    );
    expect(got.map(n => n.snippet).join(" ")).toContain("hello @mysteryagent");
    expect(got.map(n => n.snippet).join(" ")).toContain("again @mysteryagent");
  } finally {
    await w2.stop();
  }
}, 25000);

test("agent status reflects polling activity", async () => {
  await w.authed("/api/presence", { method: "POST", agent: "claude" });
  const status = (await (await fetch(`${w.base}/api/status`)).json()) as {
    agents: { handle: string; online: boolean }[];
  };
  const claude = status.agents.find(a => a.handle === "claude")!;
  expect(claude.online).toBe(true);
});

test("skill.md is served and self-describing", async () => {
  const res = await fetch(`${w.base}/skill.md`);
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).toContain("name: mrkdwn-collab");
  expect(text).toContain("/api/doc/edits");
  expect(text).toContain("/api/notifications");
});
