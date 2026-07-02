/** The comment-box @mention dropdown: token detection + candidate ranking
 * (src/web/components/mentionQuery.ts). */
import { describe, expect, test } from "bun:test";
import { activeMentionToken, filterMentions } from "../src/web/components/mentionQuery";
import type { MentionOption } from "../src/web/editor/mentionsExt";

describe("activeMentionToken", () => {
  test("bare @ query at the caret", () => {
    expect(activeMentionToken("@cl", 3)).toEqual({ from: 0, query: "cl" });
  });

  test("token mid-text, caret at its end", () => {
    expect(activeMentionToken("hey @cla", 8)).toEqual({ from: 4, query: "cla" });
  });

  test("caret inside later text sees only the token it touches", () => {
    // caret right after "@cl" even though more text follows
    expect(activeMentionToken("hi @cl there", 6)).toEqual({ from: 3, query: "cl" });
    // caret in the trailing text — not in a token
    expect(activeMentionToken("hi @cl there", 10)).toBeNull();
  });

  test("empty query right after typing @", () => {
    expect(activeMentionToken("see @", 5)).toEqual({ from: 4, query: "" });
  });

  test("guards: mid-word, emails, doubled @, code spans", () => {
    expect(activeMentionToken("a@cl", 4)).toBeNull(); // email-ish
    expect(activeMentionToken("user@do", 7)).toBeNull();
    expect(activeMentionToken("@@cl", 4)).toBeNull();
    expect(activeMentionToken("`@cl", 4)).toBeNull(); // code
  });

  test("newline and punctuation before @ are fine", () => {
    expect(activeMentionToken("done!\n@co", 9)).toEqual({ from: 6, query: "co" });
    expect(activeMentionToken("(@cl", 4)).toEqual({ from: 1, query: "cl" });
  });

  test("no token when caret is before the @", () => {
    expect(activeMentionToken("@cl", 0)).toBeNull();
  });
});

describe("filterMentions", () => {
  const options: MentionOption[] = [
    { handle: "claude", detail: "agent · online", kind: "agent" },
    { handle: "codex", detail: "agent", kind: "agent" },
    { handle: "soren", detail: "here now", kind: "human" },
    { handle: "runbook", detail: "page · Runbook", kind: "page" },
    { handle: "deploy-clues", detail: "page · Deploy clues", kind: "page" },
    { handle: "notes", detail: "page · Claude review notes", kind: "page" },
  ];

  test("empty query lists everything, agents first", () => {
    const all = filterMentions(options, "");
    expect(all.map(o => o.handle)).toEqual(["claude", "codex", "soren", "runbook", "deploy-clues", "notes"]);
  });

  test("prefix match beats substring beats title match", () => {
    const hits = filterMentions(options, "cl");
    expect(hits.map(o => o.handle)).toEqual(["claude", "deploy-clues", "notes"]);
  });

  test("matches page titles too", () => {
    expect(filterMentions(options, "review").map(o => o.handle)).toEqual(["notes"]);
  });

  test("case-insensitive", () => {
    // handle match ranks first; "Claude review notes" title-matches below it
    expect(filterMentions(options, "CLAUDE").map(o => o.handle)).toEqual(["claude", "notes"]);
  });

  test("no matches → empty", () => {
    expect(filterMentions(options, "zzz")).toEqual([]);
  });

  test("respects the limit", () => {
    expect(filterMentions(options, "", 2).map(o => o.handle)).toEqual(["claude", "codex"]);
  });

  test("agents live in this document rank first", () => {
    const withLive: MentionOption[] = [
      { handle: "claude", detail: "agent", kind: "agent" },
      { handle: "codex", detail: "agent · in this doc", kind: "agent", live: true },
      { handle: "soren", detail: "here now", kind: "human" },
    ];
    expect(filterMentions(withLive, "").map(o => o.handle)).toEqual(["codex", "claude", "soren"]);
    // liveness breaks ties but never beats a better text match
    expect(filterMentions(withLive, "cl").map(o => o.handle)).toEqual(["claude"]);
  });
});
