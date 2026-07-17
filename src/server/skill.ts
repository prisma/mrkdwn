/**
 * Agent onboarding: the copy-paste invite snippet and the full skill document
 * served at /skill.md. The skill doubles as a Claude Code skill file — an agent
 * (or human) can save it under ~/.claude/skills/mrkdwn-collab/SKILL.md.
 */
import type { ServerConfig } from "./config";

export interface InvitePage {
  id: string;
  title: string;
  /** e.g. /public/2e3884382c-notion-mode */
  path: string;
  kind: "markdown" | "canvas" | "html" | "hyperframes";
}

export function buildSnippet(config: ServerConfig, page: InvitePage): string {
  const base = config.baseUrl;
  const token = config.state.agentToken;
  const pq = `?page=${page.id}`;
  return `I'm inviting you to collaborate with me on a live markdown page: "${page.title}".

mrkdwn connection details:
- This page (humans watch you edit in realtime): ${base}${page.path}
- API base: ${base}/api — target this page with \`${pq}\` on doc/comment/presence requests
- Auth: send \`Authorization: Bearer ${token}\` on every /api request
- Name yourself: pick a short handle (e.g. claude) and a display name, and send both on
  every request as \`X-Agent: <handle>\` and \`X-Agent-Name: <display name>\`. Humans see
  the name on your avatar, cursor, and comments, and reach you by writing @<handle>.

Start by reading the full guide (API reference + collaboration etiquette):
  curl -s ${base}/skill.md
You can also install it as a skill: save it to ~/.claude/skills/mrkdwn-collab/SKILL.md

Quick reference (all requests need the auth + identity headers):
${
  page.kind === "canvas"
    ? `  This page is a CANVAS (JSON Canvas 1.0 — https://jsoncanvas.org):
  Read canvas:  GET  ${base}/api/doc${pq}          → { kind: "canvas", canvas: { nodes, edges } }
  Edit canvas:  PUT  ${base}/api/doc${pq}          {"canvas": {"nodes": [...], "edges": [...]}}
                (full replace, merged per node — send back what you read, changed)`
    : page.kind === "html"
      ? `  This page is an HTML PAGE — you write a full HTML document (markup + CSS + JS),
  humans see it rendered live in a sandboxed iframe:
  Read source:  GET  ${base}/api/doc${pq}          → { kind: "html", html, size }
  Replace:      PUT  ${base}/api/doc${pq}          {"html": "<!doctype html>..."}
  Surgical:     POST ${base}/api/doc/edits${pq}    {"edits":[{"oldText":"exact text","newText":"replacement"}]}
  REQUIRED: declare the render size in <head>: <meta name="mrkdwn-size" content="960x600">
  (min 240x160, max 1600x1200 — a PUT without it is rejected)`
      : page.kind === "hyperframes"
        ? `  This page is a HYPERFRAMES VIDEO PROJECT (https://hyperframes.heygen.com) — a
  multi-file HTML video composition; humans watch it play live in an embedded player:
  List files:   GET  ${base}/api/hf/files${pq}
  Read file:    GET  ${base}/api/hf/file${pq}&path=index.html
  Edit file:    POST ${base}/api/doc/edits${pq}    {"file":"index.html","edits":[{"oldText":"exact","newText":"new"}]}
  Write file:   PUT  ${base}/api/hf/file${pq}      {"path":"styles.css","content":"..."}
  Fork project: POST ${base}/api/pages/fork        {"page":"${page.id}"}   (iterate on a copy)
  Download zip: GET  ${base}/api/hyperframes/export${pq}    (render locally: npx hyperframes render)
  Follow the HyperFrames contract: one paused GSAP timeline on window.__timelines["<id>"],
  data-start/data-duration/data-track-index clips, sized composition root.`
        : `  Read page:    GET  ${base}/api/doc${pq}
  Edit:         POST ${base}/api/doc/edits${pq}    {"edits":[{"oldText":"exact text","newText":"replacement"}]}
  Append:       POST ${base}/api/doc/append${pq}   {"markdown":"## New section\\n..."}`
}
  Comments:     GET  ${base}/api/comments${pq}     (reply: POST /api/comments/<id>/replies${pq} {"body":"..."})
  Mentions:     GET  ${base}/api/notifications?wait=25   (long-poll; delivers @<your-handle> mentions)

Please do this now:
1. Choose your handle + display name, then POST ${base}/api/presence${pq} — your avatar appears on the page.
2. Read the whole page and look for work that's already waiting for you: unchecked to-dos,
   open questions, or requests aimed at an agent — they count even when nobody typed your
   @handle. Also check notifications for pending mentions. Act on what you find.
3. Keep collaborating: make surgical edits, reply in comment threads, and ack notifications
   (POST /api/notifications/ack {"ids":[...]}) when done.
4. Stay reachable: keep long-polling notifications (?wait=25, in a loop) for at least
   30 minutes. Every time a notification or a new instruction arrives, restart that
   30-minute window from that moment — only stop when it expires with no new work.`;
}

export function skillMarkdown(config: ServerConfig): string {
  const base = config.baseUrl;
  return `---
name: mrkdwn-collab
description: Collaborate on a live mrkdwn markdown document — read it, make surgical edits, comment, and respond to @mentions over a simple REST API. Use when given a mrkdwn document URL and bearer token.
---

# Collaborating on a mrkdwn document

mrkdwn is a realtime collaborative markdown editor. Humans edit in a web UI; you edit
through this API. Everything you do — edits, comments, even your cursor — shows up for
humans instantly, and their changes merge with yours conflict-free (CRDT-backed, no locks,
no "file changed" errors).

## Setup

Your invite carries the server URL, a bearer token, and usually the page it's
for. You choose your own identity: a short stable handle (letters, digits,
dashes — e.g. \`claude\`) and a human-facing display name.

\`\`\`bash
export MRKDWN_URL="${base}"        # server base url (from the invite)
export MRKDWN_TOKEN="<bearer token>"       # from the invite
export MRKDWN_AGENT="claude"               # pick your own @handle
export MRKDWN_AGENT_NAME="Claude"          # pick your own display name
\`\`\`

Send all three headers on every request — the display name is how humans see
you on avatars, cursors, and comments (your @handle stays the stable id, and
humans reach you by writing \`@<handle>\`):

\`\`\`bash
alias mk='curl -s -H "Authorization: Bearer $MRKDWN_TOKEN" -H "X-Agent: $MRKDWN_AGENT" -H "X-Agent-Name: $MRKDWN_AGENT_NAME"'
\`\`\`

On joining, announce yourself (shows your avatar to humans):
\`mk -X POST "$MRKDWN_URL/api/presence?page=<id>"\` — then **read the page
before doing anything else**. Work is often already waiting: unchecked
to-dos, open questions, or asks addressed to "the agent" count even when
nobody typed your @handle. Your first poll of \`/api/notifications\` also
delivers any @mentions of your handle written before you joined.

## Pages (the workspace)

Documents live in a workspace; each page has a fixed \`id\`, a title-derived
\`slug\`, and one of four kinds:

- **markdown** (default) — collaborative text; edit with surgical text edits.
- **canvas** — a JSON Canvas board of nodes and edges; edit as JSON.
- **html** — a full HTML document you author; humans view it rendered live
  in a sandboxed iframe.
- **hyperframes** — a HyperFrames video project (multi-file HTML composition,
  https://hyperframes.heygen.com); humans watch it play in an embedded player.

\`\`\`bash
mk $MRKDWN_URL/api/workspace               # { workspace, pages: [{ id, title, slug, kind, path }] }
mk -X POST $MRKDWN_URL/api/pages -d '{"title": "Meeting notes"}'                    # markdown
mk -X POST $MRKDWN_URL/api/pages -d '{"title": "Launch board", "kind": "canvas"}'   # canvas
mk -X POST $MRKDWN_URL/api/pages -d '{"title": "Burndown", "kind": "html"}'         # html
mk -X POST $MRKDWN_URL/api/pages -d '{"title": "Promo video", "kind": "hyperframes"}'  # hyperframes
\`\`\`

Every doc/comment endpoint below targets the **first page by default**; add
\`?page=<id>\` to work on another page. Notifications tell you which page a
mention came from (\`page: { id, title }\`). In doc text, \`@page-slug\`
references link to that page — and a line containing only \`![[page-slug]]\`
**embeds** that page (any kind: markdown, canvas, html, or hyperframes) as a
live block humans see rendered inside the document.

**Forking.** Any page can be forked — a brand-new page initialized from the
source's full state and history (comments and attribution included), with
lineage recorded. Use it to explore an alternative version without touching
the original; other pages keep referencing the original.

\`\`\`bash
mk -X POST $MRKDWN_URL/api/pages/fork -d '{"page": "<id>", "title": "Promo video (punchier cut)"}'
# → { page: { id, path, ... }, forkedFrom: { id, title } }
\`\`\`

## Canvas pages

Some pages are **canvases** — [JSON Canvas 1.0](https://jsoncanvas.org) boards of
nodes and edges instead of markdown. \`GET /api/workspace\` marks them with
\`"kind": "canvas"\`; create one with \`POST /api/pages {"title": "...", "kind": "canvas"}\`.

\`\`\`bash
mk "$MRKDWN_URL/api/doc?page=<id>"      # → { kind: "canvas", canvas: { nodes: [...], edges: [...] } }
mk -X PUT "$MRKDWN_URL/api/doc?page=<id>" -d '{
  "canvas": {
    "nodes": [
      { "id": "a1b2c3d4e5f60708", "type": "text", "x": 40, "y": 40,
        "width": 240, "height": 150, "color": "3", "text": "## Plan\\n- [ ] ship it" },
      { "id": "b2c3d4e5f6071809", "type": "file", "x": 360, "y": 40,
        "width": 380, "height": 300, "file": "runbook.md" }
    ],
    "edges": [
      { "id": "c3d4e5f607182910", "fromNode": "a1b2c3d4e5f60708", "fromSide": "right",
        "toNode": "b2c3d4e5f6071809", "toSide": "left", "toEnd": "arrow" }
    ]
  }
}'
\`\`\`

The PUT replaces the whole canvas but is **merged per node**: read first, apply
your changes, send everything back. Nodes you return unchanged keep any
concurrent human edits (someone dragging a note mid-request loses nothing);
nodes you omit are deleted, so never send a partial list.

Node types: \`text\` (markdown in \`text\` — a sticky note; \`color\` is "1"–"6"
or "#rrggbb"), \`file\` (\`"slug.md"\` embeds that markdown page live,
\`"slug.html"\` embeds an html page rendered live, \`"/api/images/<id>"\` shows
an uploaded image), \`link\` (\`url\`), \`group\` (\`label\`). Page embeds may
carry a \`pageId\` (mrkdwn extension) — include it when you know it; it keeps
the embed working when the page is renamed. Sizes are pixels — notes read
well around 240×150; place related nodes near each other and connect them
with edges. @mentions inside text nodes notify agents exactly like doc text.

## HTML pages

An **html** page is a complete HTML document you author — markup, CSS, and
JS in one file. Humans don't edit it; they watch it render live in a
sandboxed iframe (scripts run, but in an opaque origin: no cookies, no
storage, no app credentials). Use them for dashboards, visualizations,
interactive widgets, prototypes.

**The document must declare its render size** with a meta tag in \`<head>\`
(CSS pixels, min 240x160, max 1600x1200) — writes without it are rejected:

\`\`\`html
<meta name="mrkdwn-size" content="960x600">
\`\`\`

\`\`\`bash
mk "$MRKDWN_URL/api/doc?page=<id>"                  # → { kind: "html", html, size }
mk "$MRKDWN_URL/api/doc?page=<id>&format=html"      # raw source only
mk -X PUT "$MRKDWN_URL/api/doc?page=<id>" -d '{
  "html": "<!doctype html><html><head><meta charset=\\"utf-8\\"><meta name=\\"mrkdwn-size\\" content=\\"960x600\\"><style>body{font-family:system-ui}</style></head><body><h1>Live</h1><script>/* js runs */</script></body></html>"
}'
\`\`\`

Surgical edits work exactly like markdown (the source is text under the same
CRDT), so prefer them for small changes — \`POST /api/doc/edits\` with
oldText/newText; the edit is rejected if it would break the size declaration.
\`append\` doesn't apply to html pages. Humans see your update the moment you
write it — send complete, valid documents rather than streaming fragments.
An html page can be embedded on a canvas as a \`file\` node (\`"slug.html"\`).

## HyperFrames video pages

A **hyperframes** page is a [HyperFrames](https://hyperframes.heygen.com)
video project: a directory of files (composition html, css, js, media assets)
rendered as video. Humans watch it **play live** in an embedded player — every
file edit you make shows up on the next replay. Text files live in the same
CRDT as everything else (concurrent edits to different files always merge);
binary assets are content-addressed blobs served alongside them.

\`\`\`bash
mk "$MRKDWN_URL/api/hf/files?page=<id>"                      # { entrypoint, files: [{ path, kind, mimeType, byteSize }] }
mk "$MRKDWN_URL/api/hf/file?page=<id>&path=index.html"       # raw file content
mk -X POST "$MRKDWN_URL/api/doc/edits?page=<id>" -d '{
  "file": "index.html",
  "edits": [{ "oldText": "Hello", "newText": "Launch day" }]
}'                                                           # surgical edit inside one file
mk -X PUT "$MRKDWN_URL/api/hf/file?page=<id>" -d '{"path": "styles.css", "content": "/* ... */"}'
mk -X DELETE "$MRKDWN_URL/api/hf/file?page=<id>&path=old.js"
mk -o project.zip "$MRKDWN_URL/api/hyperframes/export?page=<id>"   # download to render locally
\`\`\`

Compositions follow the HyperFrames contract: a sized root element with
\`data-composition-id\`/\`data-width\`/\`data-height\`/\`data-duration\`, clips
with \`data-start\`/\`data-duration\`/\`data-track-index\`, and **one paused
GSAP timeline** registered at \`window.__timelines["<composition-id>"]\` —
the player drives playback and seeking. Keep animations deterministic (no
clocks, no unseeded randomness). To create a project from scratch, upload a
zip: \`curl -X POST --data-binary @project.zip "$MRKDWN_URL/api/hyperframes/upload?title=My video"\`
(binaries land in object storage; \`node_modules\`/\`.git\` are dropped).

The typical iteration loop humans expect: they comment or @mention you with
feedback → you edit the project files (or **fork first** via
\`POST /api/pages/fork\` when exploring an alternative take) → they replay the
embedded preview and compare versions. A hyperframes page embeds in markdown
(\`![[slug]]\`) and on canvases (file node \`"slug.hf"\`).

## Reading a document

\`\`\`bash
mk $MRKDWN_URL/api/doc                     # JSON: { title, markdown, heads, page, openComments }
mk "$MRKDWN_URL/api/doc?format=markdown"   # raw markdown only
mk "$MRKDWN_URL/api/doc?page=<id>"         # a specific page
\`\`\`

Always read before editing — humans may have changed things since you last looked.

## Editing

**Preferred: exact-match edits.** Same contract as your file-editing tools: \`oldText\`
must match the current document exactly and uniquely.

\`\`\`bash
mk -X POST $MRKDWN_URL/api/doc/edits -d '{
  "edits": [
    { "oldText": "## Draft heading", "newText": "## Final heading" },
    { "oldText": "teh", "newText": "the", "replaceAll": true }
  ]
}'
\`\`\`

- Edits apply in order, atomically — if any edit fails, none apply.
- \`409 not found\` → re-read the doc; the text changed under you.
- \`409 ambiguous\` → include more surrounding context, or pass \`"replaceAll": true\`.

**Appending** (new sections, notes at the end):

\`\`\`bash
mk -X POST $MRKDWN_URL/api/doc/append -d '{"markdown": "## Open questions\\n\\n- ..."}'
\`\`\`

**Full replace** — \`PUT /api/doc {"markdown": "..."}\` (also accepts \`{"title": "..."}\`).
The server diffs your text against the current doc so concurrent human edits survive,
but prefer surgical edits: they produce cleaner merges and read better in realtime.

## Comments

\`\`\`bash
mk $MRKDWN_URL/api/comments                                  # open threads (+ ?includeResolved=1)
mk -X POST $MRKDWN_URL/api/comments -d '{
  "anchorText": "exact text from the doc to attach to",
  "body": "Should this section mention pricing? cc @sorenschmidt"
}'
mk -X POST $MRKDWN_URL/api/comments/<id>/replies -d '{"body": "Done — reworded it."}'
mk -X POST $MRKDWN_URL/api/comments/<id>/resolve
\`\`\`

Omit \`anchorText\` for a document-level comment. If \`anchorText\` is ambiguous, pass
\`"occurrence": 2\` (1-based).

## Mentions → your task queue

When anyone writes \`@$MRKDWN_AGENT\` in the doc or in a comment, you get a notification:

\`\`\`bash
mk "$MRKDWN_URL/api/notifications?wait=25"
# → { "notifications": [ { "id", "kind": "doc-mention"|"comment-mention",
#      "snippet": "…the line that mentions you…", "commentId"? } ] }
\`\`\`

\`wait\` long-polls up to that many seconds — loop it while you work so humans can reach you:

\`\`\`bash
while true; do
  mk "$MRKDWN_URL/api/notifications?wait=25" | jq -c '.notifications[]'
done
\`\`\`

**Stay on the page.** Keep this loop running for at least **30 minutes** after you join,
and every time a notification (or any new instruction from a human) arrives, extend the
window — restart the 30 minutes from that moment. Humans edit at human pace; leaving
after one task usually means missing the follow-up. Only stop polling when the window
expires with nothing new.

For each notification: do what it asks. For \`comment-mention\`s, reply in that thread
(\`POST /api/comments/<commentId>/replies\`) so the conversation stays attached. Then ack:

\`\`\`bash
mk -X POST $MRKDWN_URL/api/notifications/ack -d '{"ids": ["n_..."]}'
\`\`\`

Unacked notifications are redelivered on every poll.

## Etiquette (humans are editing live)

- On joining a page (and after being away), re-read it — pick up asks from the
  content itself, not just from @mention notifications.
- Make small, targeted edits; don't rewrite sections nobody asked you to touch.
- Match the document's tone and formatting; it's markdown all the way down.
- When you complete a mention-task from the doc text, it's often nice to leave the
  mention in place but tick the checkbox / adjust the text it sits in, or reply in-thread
  for comments. Don't delete other people's questions.
- Heartbeat \`POST /api/presence\` (or just keep long-polling) roughly every 30s while
  active, so your avatar reflects reality.
- You share one bearer token with other agents; your \`X-Agent\` handle is what
  distinguishes you. Don't impersonate other handles.
`;
}
