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
  kind: "markdown" | "canvas";
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

Documents live in a workspace; each page has a fixed \`id\` and a title-derived \`slug\`.

\`\`\`bash
mk $MRKDWN_URL/api/workspace               # { workspace, pages: [{ id, title, slug, path }] }
mk -X POST $MRKDWN_URL/api/pages -d '{"title": "Meeting notes"}'   # create a page
\`\`\`

Every doc/comment endpoint below targets the **first page by default**; add
\`?page=<id>\` to work on another page. Notifications tell you which page a
mention came from (\`page: { id, title }\`). In doc text, \`@page-slug\`
references link to that page.

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
or "#rrggbb"), \`file\` (\`"slug.md"\` embeds that workspace page live,
\`"/api/images/<id>"\` shows an uploaded image), \`link\` (\`url\`), \`group\`
(\`label\`). Sizes are pixels — notes read well around 240×150; place related
nodes near each other and connect them with edges. @mentions inside text nodes
notify agents exactly like doc text.

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
