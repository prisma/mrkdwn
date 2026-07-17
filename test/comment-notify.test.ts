/** Comment notifications beyond @mentions: replies into an agent's thread
 * reach it untagged, and new comments fan out to online agents as
 * "comment-activity" with a triage instruction. */
import { describe, expect, test } from "bun:test";
import { makeWorld, until } from "./helpers";
import type { AgentNotification } from "../src/shared/types";

async function notifications(w: Awaited<ReturnType<typeof makeWorld>>, agent: string): Promise<AgentNotification[]> {
  const res = await w.authed("/api/notifications", { agent });
  return ((await res.json()) as { notifications: AgentNotification[] }).notifications;
}

describe("comment notifications", () => {
  test("replying to an agent's comment notifies it without a tag; online agents get activity", async () => {
    const w = await makeWorld();
    try {
      // codex authors a comment (goes online by doing so)
      const posted = await w.authed("/api/comments", {
        method: "POST",
        agent: "codex",
        body: JSON.stringify({ body: "The verified cut is live. I'm staying online for feedback." }),
      });
      expect(posted.status).toBe(201);
      const commentId = ((await posted.json()) as { comment: { id: string } }).comment.id;
      // claude is online too (polled recently) — clears any pending items
      await w.authed("/api/notifications", { agent: "claude" });

      // a human replies through the web client: a direct doc change, no @tag
      const page = w.running.ctx.host.defaultPage;
      page.handle.change(d => {
        d.comments[commentId]!.replies.push({
          id: "r_test1",
          author: { id: "human-1", name: "Brisk Puffin", color: "#123456", kind: "human" },
          body: "The dog on the right side is a little wonky. It's glitching",
          createdAt: Date.now(),
        });
      });

      // codex hears about it as a thread reply — untagged
      const codexSeen = await until(
        () => notifications(w, "codex"),
        list => list.some(n => n.kind === "comment-reply"),
        8000
      );
      const reply = codexSeen.find(n => n.kind === "comment-reply")!;
      expect(reply.snippet).toContain("wonky");
      expect(reply.commentId).toBe(commentId);
      expect(reply.from).toBe("Brisk Puffin");
      expect(reply.instruction).toContain("thread");
      // and codex is NOT told about its own comment as activity
      expect(codexSeen.some(n => n.kind === "comment-activity" && n.snippet.includes("staying online"))).toBe(false);

      // claude (online, not part of the thread) gets activity items with the
      // triage instruction — for the comment and/or the reply
      const claudeSeen = await until(
        () => notifications(w, "claude"),
        list => list.some(n => n.kind === "comment-activity"),
        8000
      );
      const activity = claudeSeen.find(n => n.kind === "comment-activity")!;
      expect(activity.instruction).toContain("relevant");
      // claude was not tagged and not in the thread — no reply/mention kinds
      expect(claudeSeen.some(n => n.kind === "comment-mention" || n.kind === "comment-reply")).toBe(false);
    } finally {
      await w.stop();
    }
  }, 20000);

  test("a tagged reply produces a mention, not a duplicate thread notification", async () => {
    const w = await makeWorld();
    try {
      const posted = await w.authed("/api/comments", {
        method: "POST",
        agent: "codex",
        body: JSON.stringify({ body: "Draft is up." }),
      });
      const commentId = ((await posted.json()) as { comment: { id: string } }).comment.id;

      const page = w.running.ctx.host.defaultPage;
      page.handle.change(d => {
        d.comments[commentId]!.replies.push({
          id: "r_test2",
          author: { id: "human-1", name: "Brisk Puffin", color: "#123456", kind: "human" },
          body: "@codex - see here",
          createdAt: Date.now(),
        });
      });

      const seen = await until(
        () => notifications(w, "codex"),
        list => list.some(n => n.commentId === commentId && n.kind !== "comment-activity"),
        8000
      );
      const forReply = seen.filter(n => n.commentId === commentId);
      // the mention wins; the thread-reply variant must not double-deliver
      expect(forReply.some(n => n.kind === "comment-mention")).toBe(true);
      expect(forReply.some(n => n.kind === "comment-reply")).toBe(false);
    } finally {
      await w.stop();
    }
  }, 20000);
});
