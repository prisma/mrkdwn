/** The `:emoji:` completion source: when it triggers, where it anchors, and
 * that the catalog contains what the UI filters from it. */
import { expect, test } from "bun:test";
import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { emojiCompletionSource } from "../src/web/editor/mentionsExt";

function complete(doc: string, pos = doc.length) {
  const state = EditorState.create({ doc });
  return emojiCompletionSource(new CompletionContext(state, pos, false));
}

test(":tad triggers, anchored at the colon, catalog has :tada: and :stadium:", () => {
  const result = complete("hello :tad");
  expect(result).not.toBeNull();
  expect(result!.from).toBe(6);
  const labels = result!.options.map(o => o.label);
  expect(labels).toContain(":tada:");
  expect(labels).toContain(":stadium:");
  // every option carries its glyph for the dropdown renderer
  expect(result!.options.every(o => (o as { emoji?: string }).emoji)).toBe(true);
});

test("shortcodes with +/- complete too", () => {
  const labels = complete("go :+1")!.options.map(o => o.label);
  expect(labels).toContain(":+1:");
});

test("fewer than two chars after the colon stays quiet", () => {
  expect(complete("hello :t")).toBeNull();
  expect(complete("hello :")).toBeNull();
});

test("times, paths, and code don't trigger", () => {
  expect(complete("meet at 10:30")).toBeNull(); // digit before the colon
  expect(complete("a:b:cd")).toBeNull(); // word char / colon chains
  expect(complete("`:tada")).toBeNull(); // backtick before
});

test("mid-document positions work", () => {
  const doc = "before :roc after";
  const result = complete(doc, doc.indexOf(" after"));
  expect(result).not.toBeNull();
  expect(result!.from).toBe(7);
});
