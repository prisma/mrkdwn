/** The agent typewriter: edits stream in at typing speed, stay correct under
 * concurrent human edits, keep attribution, and serialize per doc. */
import { describe, expect, test } from "bun:test";
import * as A from "@automerge/automerge";
import { makeWorld, until } from "./helpers";
import { enqueue, singleSpliceDiff, typeSplices } from "../src/server/typewriter";
import { contributionsOf } from "../src/shared/attribution";
import { Repo } from "@automerge/automerge-repo";
import type { MrkdwnDoc } from "../src/shared/types";

const FAST = { intervalMs: 5, budgetMs: 400 };

function makeHandle(content: string) {
  const repo = new Repo({ network: [] });
  return repo.create<MrkdwnDoc>({ title: "T", content, comments: {} });
}

describe("typeSplices", () => {
  test("text arrives progressively, final content exact", async () => {
    const handle = makeHandle("alpha omega");
    const lengths: number[] = [];
    handle.on("change", () => lengths.push(handle.doc().content.length));
    await typeSplices(handle, [{ index: 6, delText: "", ins: "beta gamma delta " }], {}, FAST);
    expect(handle.doc().content).toBe("alpha beta gamma delta omega");
    // more than one change → it streamed, not teleported
    expect(lengths.length).toBeGreaterThan(1);
    for (let i = 1; i < lengths.length; i++) expect(lengths[i]!).toBeGreaterThan(lengths[i - 1]!);
  });

  test("replacement deletes then types, caret follows", async () => {
    const handle = makeHandle("state: draft, needs review");
    const carets: number[] = [];
    await typeSplices(
      handle,
      [{ index: 7, delText: "draft", ins: "shipped" }],
      {},
      FAST,
      i => carets.push(i)
    );
    expect(handle.doc().content).toBe("state: shipped, needs review");
    expect(carets.length).toBeGreaterThan(1);
    expect(carets[carets.length - 1]).toBe(7 + "shipped".length);
  });

  test("concurrent human edit mid-typing shifts, never corrupts", async () => {
    const handle = makeHandle("intro\nEND");
    const typing = typeSplices(
      handle,
      [{ index: 5, delText: "", ins: "\nagent line one\nagent line two" }],
      {},
      { intervalMs: 15, budgetMs: 2000 }
    );
    // human prepends while the agent is typing
    await new Promise(r => setTimeout(r, 30));
    handle.change(d => A.splice(d, ["content"], 0, 0, "HUMAN "));
    await typing;
    expect(handle.doc().content).toBe("HUMAN intro\nagent line one\nagent line two\nEND");
  });

  test("skips a splice whose target text a human deleted", async () => {
    const handle = makeHandle("keep DOOMED tail");
    handle.change(d => A.splice(d, ["content"], 5, 7, "")); // human beat us to it
    await typeSplices(handle, [{ index: 5, delText: "DOOMED", ins: "replacement" }], {}, FAST);
    expect(handle.doc().content).toBe("keep tail"); // untouched by the agent
  });

  test("every chunk carries the agent change message (attribution)", async () => {
    const handle = makeHandle("");
    await typeSplices(
      handle,
      [{ index: 0, delText: "", ins: "typed by an agent, chunk by chunk" }],
      { message: JSON.stringify({ agent: "claude" }) },
      FAST
    );
    const ranges = contributionsOf(handle.doc(), "agent:claude");
    expect(ranges).toHaveLength(1); // chunks merge into one attributed range
    expect(ranges[0]).toMatchObject({ from: 0, to: handle.doc().content.length });
  });
});

describe("singleSpliceDiff", () => {
  test("trims common prefix and suffix", () => {
    expect(singleSpliceDiff("a quick fox", "a slow fox")).toEqual({ index: 2, delText: "quick", ins: "slow" });
    expect(singleSpliceDiff("same", "same")).toBeNull();
    expect(singleSpliceDiff("", "new")).toEqual({ index: 0, delText: "", ins: "new" });
    expect(singleSpliceDiff("gone", "")).toEqual({ index: 0, delText: "gone", ins: "" });
  });
});

describe("enqueue", () => {
  test("tasks on one key run strictly in order, even after failures", async () => {
    const order: string[] = [];
    const t1 = enqueue("k", async () => {
      await new Promise(r => setTimeout(r, 30));
      order.push("first");
    });
    const t2 = enqueue("k", async () => {
      order.push("second");
      throw new Error("boom");
    });
    const t3 = enqueue("k", async () => order.push("third"));
    await t1;
    await expect(t2).rejects.toThrow("boom");
    await t3;
    expect(order).toEqual(["first", "second", "third"]);
  });
});

describe("animated agent edits over the API", () => {
  test("edits stream into the doc and follow-up requests read-after-write", async () => {
    const w = await makeWorld();
    try {
      // re-enable typing (makeWorld turns it off) — fast for the test
      w.running.ctx.config.agentTyping = { intervalMs: 5, budgetMs: 300 };
      const before = (await (await w.authed("/api/doc")).json()) as { markdown: string };

      const long = "The typewriter streams this sentence in, chunk by chunk, like a fast human.";
      const req = w.authed("/api/doc/append", {
        method: "POST",
        agent: "claude",
        body: JSON.stringify({ markdown: long }),
      });

      // observe an intermediate state: longer than before, shorter than final
      const midway = await until(
        async () => ((await (await w.authed("/api/doc")).json()) as { markdown: string }).markdown.length,
        len => len > before.markdown.length && len < before.markdown.length + long.length,
        5000,
        5
      );
      expect(midway).toBeGreaterThan(before.markdown.length);

      const res = (await (await req).json()) as { ok: boolean; markdown: string };
      expect(res.ok).toBe(true);
      expect(res.markdown.endsWith(long)).toBe(true); // response waits for the animation

      // immediate follow-up edit sees the settled text (per-doc queue)
      const edit = await w.authed("/api/doc/edits", {
        method: "POST",
        agent: "claude",
        body: JSON.stringify({ edits: [{ oldText: "like a fast human.", newText: "like a careful human." }] }),
      });
      expect(edit.status).toBe(200);
      expect(((await edit.json()) as { markdown: string }).markdown).toContain("careful human");
    } finally {
      await w.stop();
    }
  }, 20000);
});
