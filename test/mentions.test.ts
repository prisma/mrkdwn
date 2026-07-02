import { expect, test } from "bun:test";
import { scanMentions, mentionSnippet } from "../src/shared/mentions";

test("finds mentions at line start, after spaces and punctuation", () => {
  const text = "@claude hi\nplease ask @Codex, or (@claude)";
  const handles = scanMentions(text).map(m => m.handle);
  expect(handles).toEqual(["claude", "codex", "claude"]);
});

test("offsets point at the @", () => {
  const text = "ping @claude now";
  const [m] = scanMentions(text);
  expect(text.slice(m!.index, m!.end)).toBe("@claude");
});

test("ignores emails, code spans, doubled @ and mid-word @", () => {
  const text = "mail schmidt@prisma.io or `@claude` or a@@b or foo@bar";
  expect(scanMentions(text)).toEqual([]);
});

test("handles are case-normalized and length-capped", () => {
  expect(scanMentions("@CLAUDE")[0]!.handle).toBe("claude");
  const long = "@" + "a".repeat(64);
  const [m] = scanMentions(long);
  expect(m!.handle.length).toBe(32);
});

test("snippet returns the mention's line, trimmed", () => {
  const text = "# Title\n\n- [ ] ask @claude to fix the intro\nmore";
  const m = scanMentions(text).find(x => x.handle === "claude")!;
  expect(mentionSnippet(text, m.index)).toBe("- [ ] ask @claude to fix the intro");
});
