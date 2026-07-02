/** Per-author attribution from Automerge history: actor-keyed human edits,
 * message-keyed agent edits, interior-insertion carving, deletion decay. */
import { describe, expect, test } from "bun:test";
import * as A from "@automerge/automerge";
import {
  agentsInHistory,
  attributeContent,
  AttributionIndex,
  changeAuthorKey,
  contributionsOf,
  keysForAuthor,
} from "../src/shared/attribution";
import type { MrkdwnDoc } from "../src/shared/types";

const base = (actor: string) =>
  A.from({ title: "t", content: "", comments: {}, authors: {} }, actor) as unknown as A.Doc<MrkdwnDoc>;

const insert = (doc: A.Doc<MrkdwnDoc>, at: number, text: string, agent?: string) =>
  A.change(doc, agent ? { message: JSON.stringify({ agent }) } : {}, d => A.splice(d, ["content"], at, 0, text));

const textOf = (doc: A.Doc<MrkdwnDoc>, ranges: { from: number; to: number }[]) =>
  ranges.map(r => doc.content.slice(r.from, r.to));

describe("changeAuthorKey", () => {
  test("agents key by change message, humans by actor", () => {
    expect(changeAuthorKey(JSON.stringify({ agent: "claude" }), "aa")).toBe("agent:claude");
    expect(changeAuthorKey(undefined, "aa")).toBe("actor:aa");
    expect(changeAuthorKey("free-text message", "aa")).toBe("actor:aa");
    expect(changeAuthorKey(JSON.stringify({ other: 1 }), "aa")).toBe("actor:aa");
  });
});

describe("attributeContent", () => {
  test("attributes insertions per actor and per agent message", () => {
    let doc = insert(base("aaaa"), 0, "Hello world");
    doc = insert(doc, 11, "!", "claude");
    const attributed = attributeContent(doc);
    expect(textOf(doc, attributed.get("actor:aaaa") ?? [])).toEqual(["Hello world"]);
    expect(textOf(doc, attributed.get("agent:claude") ?? [])).toEqual(["!"]);
  });

  test("text inserted inside someone else's range is carved out", () => {
    let doc = insert(base("aaaa"), 0, "Hello world");
    let docB = A.clone(doc, "bbbb");
    docB = insert(docB, 5, " brave");
    doc = A.merge(doc, docB);
    const attributed = attributeContent(doc);
    expect(textOf(doc, attributed.get("actor:bbbb") ?? [])).toEqual([" brave"]);
    expect(textOf(doc, attributed.get("actor:aaaa") ?? [])).toEqual(["Hello", " world"]);
  });

  test("deleted contributions decay to nothing", () => {
    let doc = insert(base("aaaa"), 0, "keep ");
    doc = insert(doc, 5, "DELETED", "claude");
    doc = A.change(doc, d => A.splice(d, ["content"], 5, 7, ""));
    const attributed = attributeContent(doc);
    expect(attributed.has("agent:claude")).toBe(false);
    expect(textOf(doc, attributed.get("actor:aaaa") ?? [])).toEqual(["keep "]);
  });
});

describe("contributionsOf", () => {
  test("unions all session actors registered under one author id", () => {
    let doc = insert(base("aaaa"), 0, "first ");
    doc = A.change(doc, d => {
      d.authors!["aaaa"] = { id: "me", name: "Me", color: "#111111", kind: "human" };
    });
    // second session, same human, different actor
    let doc2 = A.clone(doc, "cccc");
    doc2 = A.change(doc2, d => {
      d.authors!["cccc"] = { id: "me", name: "Me", color: "#111111", kind: "human" };
    });
    doc2 = insert(doc2, 6, "second");
    doc = A.merge(doc, doc2);

    expect(keysForAuthor(doc, "me")).toEqual(new Set(["actor:aaaa", "actor:cccc"]));
    expect(textOf(doc, contributionsOf(doc, "me"))).toEqual(["first second"]);
  });

  test("agents resolve via their agent: author id", () => {
    let doc = insert(base("aaaa"), 0, "human ", undefined);
    doc = insert(doc, 6, "agent bit", "claude");
    expect(textOf(doc, contributionsOf(doc, "agent:claude"))).toEqual(["agent bit"]);
    expect(contributionsOf(doc, "agent:codex")).toEqual([]);
  });
});

describe("AttributionIndex", () => {
  test("matches the one-shot computation", () => {
    let doc = insert(base("aaaa"), 0, "Hello world");
    doc = insert(doc, 11, "!", "claude");
    doc = A.change(doc, d => {
      d.authors!["aaaa"] = { id: "me", name: "Me", color: "#111111", kind: "human" };
    });
    const index = new AttributionIndex();
    expect(index.contributionsOf(doc, "me")).toEqual(contributionsOf(doc, "me"));
    expect(index.contributionsOf(doc, "agent:claude")).toEqual(contributionsOf(doc, "agent:claude"));
  });

  test("absorbs new changes incrementally and re-resolves after edits", () => {
    let doc = insert(base("aaaa"), 0, "keep ");
    const index = new AttributionIndex();
    expect(textOf(doc, index.contributionsOf(doc, "agent:claude"))).toEqual([]);

    doc = insert(doc, 5, "agent text", "claude");
    expect(textOf(doc, index.contributionsOf(doc, "agent:claude"))).toEqual(["agent text"]);

    // human deletes part of it — same pairs, new resolution
    doc = A.change(doc, d => A.splice(d, ["content"], 5, 6, ""));
    expect(textOf(doc, index.contributionsOf(doc, "agent:claude"))).toEqual(["text"]);
  });

  test("repeated lookups on an unchanged doc reuse the cache", () => {
    let doc = insert(base("aaaa"), 0, "stable", "claude");
    const index = new AttributionIndex();
    const first = index.contributionsOf(doc, "agent:claude");
    const second = index.contributionsOf(doc, "agent:claude");
    expect(second).toEqual(first);
  });

  test("survives merged remote history", () => {
    let doc = insert(base("aaaa"), 0, "Hello world");
    const index = new AttributionIndex();
    index.update(doc);
    let docB = A.clone(doc, "bbbb");
    docB = insert(docB, 5, " brave");
    doc = A.merge(doc, docB);
    doc = A.change(doc, d => {
      d.authors!["bbbb"] = { id: "b", name: "B", color: "#222222", kind: "human" };
    });
    expect(textOf(doc, index.contributionsOf(doc, "b"))).toEqual([" brave"]);
    expect(index.contributionsOf(doc, "b")).toEqual(contributionsOf(doc, "b"));
  });
});

describe("agentsInHistory", () => {
  test("collects the handles of agent-tagged changes, humans excluded", () => {
    let doc = insert(base("aaaa"), 0, "human text");
    doc = insert(doc, 10, " by claude", "claude");
    doc = insert(doc, 20, " by codex", "codex");
    const { handles, changeCount } = agentsInHistory(doc);
    expect(handles).toEqual(new Set(["claude", "codex"]));
    expect(changeCount).toBe(4); // A.from init + 3 inserts
  });

  test("even fully deleted agent text still counts as participation", () => {
    let doc = insert(base("aaaa"), 0, "keep ");
    doc = insert(doc, 5, "GONE", "claude");
    doc = A.change(doc, d => A.splice(d, ["content"], 5, 4, ""));
    expect(agentsInHistory(doc).handles).toEqual(new Set(["claude"]));
  });

  test("incremental scan only decodes new changes", () => {
    let doc = insert(base("aaaa"), 0, "start", "claude");
    const first = agentsInHistory(doc);
    expect(first.handles).toEqual(new Set(["claude"]));
    doc = insert(doc, 5, " more", "codex");
    const next = agentsInHistory(doc, first.changeCount);
    expect(next.handles).toEqual(new Set(["codex"])); // claude was before the cutoff
    expect(next.changeCount).toBe(first.changeCount + 1);
    // nothing new → nothing found
    expect(agentsInHistory(doc, next.changeCount).handles).toEqual(new Set());
  });
});
