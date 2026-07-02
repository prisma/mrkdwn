import type { MrkdwnDoc } from "../shared/types";

/** Seeded into an empty workspace: the page every new visitor lands on.
 * It explains the features by *being* them — everything it claims is live
 * on the page itself. Tests pin the title and the intro line; keep stable. */
export const WELCOME_DOC: MrkdwnDoc = {
  title: "Welcome to mrkdwn",
  content: `Live collaborative markdown where **humans and AI agents write together** 👋 Everything on this page is editable — go ahead, break things. Every keystroke syncs to everyone instantly, merges without conflicts, and is versioned forever.

## Writing

Markdown without the syntax noise: type it, see it rendered, never watch \`**\` bloom around your cursor.

- Type \`#\` + space for a heading — Backspace at its start demotes it, typing \`#\` promotes it
- \`-\` starts a list, \`[]\` becomes a checkbox, \`>\` a quote — Tab / Shift-Tab nest list items
- \`/\` on an empty line opens the block menu; hovering any block reveals ⋮⋮ to drag it and ＋ to insert
- Select text for the toolbar: bold, italic, strikethrough, \`code\`, links, colors — and 💬 to comment
- The \`</>\` button (top right) shows raw markdown when you want scalpel edits

## Try it ✨

- [ ] Check this box — the line won't budge
- [ ] Select any sentence and hit 💬 to start a comment thread (@ mentions people, agents, and pages)
- [ ] Type \`:ta\` anywhere and pick 🎉 from the emoji dropdown
- [ ] Paint text :red[red], :violet[violet], or :blue-background[highlight it] straight from the toolbar
- [ ] Grab this line's ⋮⋮ handle and drag it somewhere else

Tables are real — click a cell to edit, Tab between cells, hover for the ＋ row/column strips:

| Feature | Status |
| --- | --- |
| Live cursors & presence | :green[shipped] |
| Agent co-authors | :green[shipped] |
| ~~Locks and merge conflicts~~ | never — CRDTs |

## Your workspace

Pages live in the left sidebar — filter them by title, or collapse it out of the way. **⌘K** jumps to any page, and creates one named after whatever you typed if it doesn't exist. Link pages by writing \`@page-slug\`, or type \`/page\` to create and link a new one inline. Every page keeps a stable URL; renaming just polishes the slug.

## Agents are co-authors 🤖

Hit **Invite your agent** (top right) and paste the invite into Claude Code, Codex, or any agent with a shell. The agent names itself, reads the page for anything already asked of it, and works alongside you — live cursor, avatar, edits, and comment replies. Write @claude anywhere (page or comment) to hand it a task; it arrives as a notification.

Curious who wrote what? Click any avatar in the top bar — that person's contributions light up in their color, and the comments panel filters to their threads.

## Never lose a word

The dot next to the logo tells the truth about your data: :green[green] means everything is durably stored in S3, :orange[amber] means a save is under way (at most two seconds out), :red[red] means the connection dropped — editing pauses until sync resumes. The full edit history rides along with every save.

> mrkdwn is an open-source demonstration of how much product fits in one stateful process on **Prisma Compute** — page registry in Prisma Postgres via Prisma Next, content in Automerge CRDTs, served by Bun. Take the guided tour at [/tour](/tour), then fork it and make it yours.
`,
  comments: {},
};
