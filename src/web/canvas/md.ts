/**
 * Tiny markdown → HTML renderer for canvas node text and embedded pages.
 * Input is escaped before any transformation, so raw HTML never passes
 * through — canvas text is world-editable in the public workspace.
 * Covers the subset the editor writes: headings, bold/italic/strike, code,
 * links, images, task lists, lists, quotes, hr.
 */

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const MD_COLORS: Record<string, string> = {
  red: "#e03131", orange: "#e8590c", yellow: "#e67700", green: "#2b8a3e",
  blue: "#1971c2", violet: "#7048e8", rainbow: "#c2255c", gray: "#868e96", grey: "#868e96",
};

function inline(s: string): string {
  return s
    .replace(/:([a-z]+)-background\[([^\]\n]*)\]/g, (m, c: string, t: string) =>
      MD_COLORS[c] ? `<span style="background:${MD_COLORS[c]}22;border-radius:3px;padding:0 3px">${t}</span>` : m)
    .replace(/:([a-z]+)\[([^\]\n]*)\]/g, (m, c: string, t: string) =>
      MD_COLORS[c] ? `<span style="color:${MD_COLORS[c]}">${t}</span>` : m)
    .replace(/`([^`]+)`/g, (_m, c: string) => `<code>${c}</code>`)
    .replace(/!\[([^\]]*)\]\((\/api\/images\/[0-9a-f]{16})\)/g, `<img src="$2?w=640" alt="$1" loading="lazy" />`)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|\/[^)\s]*)\)/g, `<a href="$2" target="_blank" rel="noreferrer">$1</a>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|\W)\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
    .replace(/~~([^~]+)~~/g, "<s>$1</s>");
}

export function renderMarkdown(md: string): string {
  const lines = esc(md).split("\n");
  const out: string[] = [];
  let list: "ul" | "ol" | null = null;
  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    const task = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.*)$/);
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    const quote = line.match(/^>\s?(.*)$/);

    if (h) {
      closeList();
      const level = Math.min(h[1]!.length + 2, 6); // node headings render small
      out.push(`<h${level}>${inline(h[2]!)}</h${level}>`);
    } else if (task) {
      if (list !== "ul") {
        closeList();
        out.push("<ul>");
        list = "ul";
      }
      const done = task[1]!.toLowerCase() === "x";
      out.push(`<li class="task${done ? " done" : ""}"><span class="box">${done ? "✓" : ""}</span>${inline(task[2]!)}</li>`);
    } else if (ul) {
      if (list !== "ul") {
        closeList();
        out.push("<ul>");
        list = "ul";
      }
      out.push(`<li>${inline(ul[1]!)}</li>`);
    } else if (ol) {
      if (list !== "ol") {
        closeList();
        out.push("<ol>");
        list = "ol";
      }
      out.push(`<li>${inline(ol[1]!)}</li>`);
    } else if (quote) {
      closeList();
      out.push(`<blockquote>${inline(quote[1]!)}</blockquote>`);
    } else if (/^(-{3,}|\*{3,})$/.test(line)) {
      closeList();
      out.push("<hr />");
    } else if (line.length === 0) {
      closeList();
    } else {
      closeList();
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  closeList();
  return out.join("");
}
