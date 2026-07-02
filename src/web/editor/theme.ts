/** Markdown syntax gets CSS classes (styles live in styles.css so the theme
 * switch is pure CSS). */
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";

const mdHighlight = HighlightStyle.define([
  { tag: tags.heading1, class: "md-h1" },
  { tag: tags.heading2, class: "md-h2" },
  { tag: tags.heading3, class: "md-h3" },
  { tag: tags.heading4, class: "md-h4" },
  { tag: tags.heading5, class: "md-h5" },
  { tag: tags.heading6, class: "md-h6" },
  { tag: tags.strong, class: "md-strong" },
  { tag: tags.emphasis, class: "md-em" },
  { tag: tags.strikethrough, class: "md-strike" },
  { tag: tags.monospace, class: "md-code" },
  { tag: tags.link, class: "md-link" },
  { tag: tags.url, class: "md-url" },
  { tag: tags.quote, class: "md-quote" },
  { tag: tags.contentSeparator, class: "md-hr" },
  { tag: tags.processingInstruction, class: "md-mark" },
  { tag: tags.labelName, class: "md-mark" },
  { tag: tags.atom, class: "md-mark" },
  // inside fenced code blocks (via nested language parsers)
  { tag: tags.keyword, class: "tok-kw" },
  { tag: tags.string, class: "tok-str" },
  { tag: tags.comment, class: "tok-com" },
  { tag: [tags.number, tags.bool], class: "tok-num" },
  { tag: [tags.function(tags.variableName), tags.definition(tags.variableName)], class: "tok-def" },
  { tag: [tags.typeName, tags.className], class: "tok-type" },
]);

export const markdownTheme: Extension = syntaxHighlighting(mdHighlight);
