import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import * as A from "@automerge/automerge";
import type { DocHandle } from "@automerge/automerge-repo/slim";
import { useDocument } from "@automerge/automerge-repo-react-hooks";
import { nowId, type Author, type DocComment, type MrkdwnDoc } from "../shared/types";
import { loadIdentity, renameIdentity } from "./app/identity";
import { PresenceStore, cursorAt } from "./app/presence";
import { useAgentStatus, useConnected } from "./app/status";
import { useDurability } from "./app/durability";
import { Editor, type EditorApi, type SelectionInfo } from "./editor/Editor";
import type { CommentRange } from "./editor/commentsExt";
import type { MentionOption } from "./editor/mentionsExt";
import { agentsInHistory, AttributionIndex } from "../shared/attribution";
import { scanMentions } from "../shared/mentions";
import { Header } from "./components/Header";
import { Sidebar } from "./components/Sidebar";
import { CommandPalette } from "./components/CommandPalette";
import { CommentsPanel, type DraftComment, type PositionedComment } from "./components/CommentsPanel";
import { CanvasEditor } from "./canvas/CanvasEditor";
import { HtmlView } from "./components/HtmlView";
import { usePageEmbeds } from "./components/PageEmbed";
import { InviteAgentModal } from "./components/InviteAgentModal";
import { SelectionToolbar } from "./components/SelectionToolbar";
import type { PageMeta } from "../shared/types";

interface AppProps {
  handle: DocHandle<MrkdwnDoc>;
  adapter: Parameters<typeof useConnected>[0];
  workspace: { handle: string; name: string };
  pages: PageMeta[];
  currentPageId: string;
  onNavigate(id: string): void;
  /** create without navigating (the `/page` inline-link flow) */
  onCreatePage(title?: string): Promise<PageMeta | null>;
  /** create, open, and land in the (selected) title */
  onCreateAndOpenPage(title?: string, kind?: "markdown" | "canvas" | "html"): Promise<PageMeta | null>;
  /** this page was just created — focus + select its title on mount */
  focusTitle: boolean;
  onFocusTitleConsumed(): void;
}

function loadTheme(): "light" | "dark" {
  const saved = localStorage.getItem("mrkdwn:theme");
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function App(props: AppProps) {
  const { handle, adapter } = props;
  const [doc, changeDoc] = useDocument<MrkdwnDoc>(handle.url, { suspense: false });
  const [identity, setIdentity] = useState<Author>(loadIdentity);
  const [theme, setTheme] = useState<"light" | "dark">(loadTheme);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftComment | null>(null);
  const [selection, setSelection] = useState<SelectionInfo | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [sourceMode, setSourceMode] = useState(() => localStorage.getItem("mrkdwn:source") === "1");
  const [sidebarOpen, setSidebarOpen] = useState(() => localStorage.getItem("mrkdwn:sidebar") !== "0");
  const [paletteOpen, setPaletteOpen] = useState(false);

  const status = useAgentStatus();
  const connected = useConnected(adapter);
  const durability = useDurability(handle, connected, status?.persistence ?? false);
  const pageKind = props.pages.find(pg => pg.id === props.currentPageId)?.kind ?? "markdown";
  const editorApi = useRef<EditorApi | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  // connection gone → the doc is read-only until sync resumes
  useEffect(() => {
    editorApi.current?.setEditable(connected);
  }, [connected]);

  // a freshly created page opens with its title selected — typing renames
  useEffect(() => {
    if (!props.focusTitle) return;
    titleRef.current?.focus();
    titleRef.current?.select();
    props.onFocusTitleConsumed();
    // runs once per page (App remounts keyed by page id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const focusTitleFromEditor = useCallback(() => {
    const el = titleRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  // register this session's Automerge actor → author, so contributions can
  // be attributed to people (agents are attributed via change messages)
  useEffect(() => {
    try {
      const actor = A.getActorId(handle.doc());
      changeDoc(d => {
        if (!d.authors) d.authors = {};
        const existing = d.authors[actor];
        if (!existing || existing.name !== identity.name || existing.color !== identity.color) {
          d.authors[actor] = { ...identity };
        }
      });
    } catch {}
  }, [handle, identity, changeDoc]);

  const presence = useMemo(() => new PresenceStore(handle, identity), [handle]);
  useEffect(() => () => presence.dispose(), [presence]);
  useEffect(() => presence.setSelf(identity), [presence, identity]);
  const peers = useSyncExternalStore(presence.subscribe, presence.getPeers);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("mrkdwn:theme", theme);
  }, [theme]);

  useEffect(() => {
    if (doc?.title) document.title = `${doc.title} · mrkdwn`;
  }, [doc?.title]);

  useEffect(() => {
    localStorage.setItem("mrkdwn:source", sourceMode ? "1" : "0");
    editorApi.current?.setSourceMode(sourceMode);
  }, [sourceMode]);

  useEffect(() => {
    localStorage.setItem("mrkdwn:sidebar", sidebarOpen ? "1" : "0");
  }, [sidebarOpen]);

  // ⌘K / Ctrl-K opens the page palette from anywhere (including the editor)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        setPaletteOpen(o => !o);
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);

  // ---- comments plumbing ----

  const positioned: PositionedComment[] = useMemo(() => {
    if (!doc) return [];
    const current = handle.doc();
    const list = Object.values(doc.comments ?? {}).map(comment => {
      let pos: number | null = null;
      try {
        const start = A.getCursorPosition(current, ["content"], comment.anchorStart);
        const end = A.getCursorPosition(current, ["content"], comment.anchorEnd);
        if (end > start) pos = start;
      } catch {}
      return { comment, pos };
    });
    return list.sort((a, b) => {
      if (a.pos === null && b.pos === null) return a.comment.createdAt - b.comment.createdAt;
      if (a.pos === null) return 1;
      if (b.pos === null) return -1;
      return a.pos - b.pos || a.comment.createdAt - b.comment.createdAt;
    });
  }, [doc, handle]);

  const openCount = positioned.filter(c => !c.comment.resolved).length;

  // ---- author spotlight: click an avatar → tint their contributions and
  // filter the comments panel to threads by or mentioning them ----

  const [spotlight, setSpotlight] = useState<Author | null>(null);

  // history processing is expensive (a wasm diff per change) — the index does
  // it once per change; keep it warm off the click path so clicks are instant
  const attribution = useMemo(() => new AttributionIndex(), [handle]);
  useEffect(() => {
    if (!doc) return;
    const t = setTimeout(() => attribution.update(handle.doc()), 250);
    return () => clearTimeout(t);
  }, [doc, attribution, handle]);

  /** the @handle this author is mentionable as (agents: handle; humans: slugified name) */
  const mentionHandleFor = (author: Author) =>
    author.kind === "agent"
      ? author.id.replace(/^agent:/, "")
      : author.name.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^\w-]/g, "");

  const commentsAbout = useCallback(
    (author: Author): PositionedComment[] => {
      const mention = mentionHandleFor(author);
      const touches = (body: string) => scanMentions(body).some(m => m.handle === mention);
      return positioned.filter(
        ({ comment }) =>
          comment.author.id === author.id ||
          comment.replies.some(r => r.author.id === author.id) ||
          touches(comment.body) ||
          comment.replies.some(r => touches(r.body))
      );
    },
    [positioned]
  );

  const applySpotlight = useCallback(
    (author: Author) => {
      if (spotlight?.id === author.id) {
        setSpotlight(null);
        editorApi.current?.setAuthorSpotlight(null);
        return;
      }
      setSpotlight(author);
      const ranges = attribution.contributionsOf(handle.doc(), author.id);
      editorApi.current?.setAuthorSpotlight(ranges.length ? { ranges, color: author.color } : null);
      // open the comments panel filtered to them — only if there's anything
      if (commentsAbout(author).length > 0) setCommentsOpen(true);
    },
    [spotlight, handle, commentsAbout, attribution]
  );

  const spotlightComments = spotlight ? commentsAbout(spotlight) : null;
  const visibleComments = spotlightComments ?? positioned;

  // ---- who participated in THIS doc: agents appear only where they edited,
  // commented, or are present right now (humans already come from per-doc
  // presence) ----

  const agentHistory = useRef({ seen: 0, handles: new Set<string>() });
  const participatingAgents = useMemo(() => {
    const registered = status?.agents ?? [];
    if (!doc || registered.length === 0) return [];
    // text edits: agent-tagged changes (decode only what's new since last scan)
    const { handles, changeCount } = agentsInHistory(handle.doc(), agentHistory.current.seen);
    for (const h of handles) agentHistory.current.handles.add(h);
    agentHistory.current.seen = changeCount;
    const active = new Set(agentHistory.current.handles);
    // comment threads
    for (const c of Object.values(doc.comments ?? {})) {
      if (c.author.kind === "agent") active.add(c.author.id.replace(/^agent:/, ""));
      for (const r of c.replies) if (r.author.kind === "agent") active.add(r.author.id.replace(/^agent:/, ""));
    }
    // here right now
    for (const peer of peers) {
      if (peer.user.kind === "agent") active.add(peer.user.id.replace(/^agent:/, ""));
    }
    return registered.filter(a => active.has(a.handle));
  }, [doc, status, peers, handle]);

  // push highlight ranges (comments + draft) into the editor
  useEffect(() => {
    if (!editorApi.current || !doc) return;
    const current = handle.doc();
    const ranges: CommentRange[] = [];
    for (const { comment } of positioned) {
      if (comment.resolved) continue;
      try {
        const from = A.getCursorPosition(current, ["content"], comment.anchorStart);
        const to = A.getCursorPosition(current, ["content"], comment.anchorEnd);
        if (to > from) ranges.push({ id: comment.id, from, to, active: comment.id === activeCommentId });
      } catch {}
    }
    if (draft) {
      try {
        const from = A.getCursorPosition(current, ["content"], draft.anchorStart);
        const to = A.getCursorPosition(current, ["content"], draft.anchorEnd);
        if (to > from) ranges.push({ id: "__draft", from, to, active: true });
      } catch {}
    }
    editorApi.current.setCommentRanges(ranges);
  }, [doc, positioned, activeCommentId, draft, handle]);

  const startDraft = useCallback(() => {
    if (!selection) return;
    const current = handle.doc();
    const len = current.content.length;
    const from = Math.min(selection.from, len);
    const to = Math.min(selection.to, len);
    if (from >= to) return;
    setDraft({
      anchorStart: cursorAt(current, from, len),
      anchorEnd: cursorAt(current, to, len),
      quote: current.content.slice(from, to),
    });
    setCommentsOpen(true);
    setActiveCommentId(null);
  }, [selection, handle]);

  const submitDraft = useCallback(
    (body: string) => {
      if (!draft) return;
      const comment: DocComment = {
        id: nowId("c"),
        author: identity,
        body,
        createdAt: Date.now(),
        anchorStart: draft.anchorStart,
        anchorEnd: draft.anchorEnd,
        quote: draft.quote,
        resolved: false,
        replies: [],
      };
      changeDoc(d => {
        d.comments[comment.id] = comment;
      });
      setDraft(null);
      setActiveCommentId(comment.id);
    },
    [draft, identity, changeDoc]
  );

  const revealComment = useCallback(
    (id: string) => {
      const current = handle.doc();
      const comment = current.comments[id];
      if (!comment) return;
      try {
        const from = A.getCursorPosition(current, ["content"], comment.anchorStart);
        const to = A.getCursorPosition(current, ["content"], comment.anchorEnd);
        if (to > from) editorApi.current?.revealRange(from, to);
      } catch {}
    },
    [handle]
  );

  // ---- mentions ----

  const agentHandlesRef = useRef<Set<string>>(new Set(["claude", "codex"]));
  const mentionOptionsRef = useRef<MentionOption[]>([]);
  const pageLinksRef = useRef<Map<string, string>>(new Map());
  const mentionOptions = useMemo<MentionOption[]>(() => {
    // agents with live presence in THIS document rank before everything else
    const liveHere = new Set(
      peers.filter(x => x.user.kind === "agent").map(x => x.user.id.replace(/^agent:/, ""))
    );
    const agents = [...(status?.agents ?? [])].sort(
      (a, b) => Number(liveHere.has(b.handle)) - Number(liveHere.has(a.handle))
    );
    const humanOptions: MentionOption[] = peers
      .filter(x => x.user.kind === "human")
      .map(x => ({
        handle: x.user.name.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^\w-]/g, "") || "someone",
        detail: "here now",
        kind: "human",
      }));
    return [
      ...agents.map(a => ({
        handle: a.handle,
        detail: liveHere.has(a.handle) ? "agent · in this doc" : a.online ? "agent · online" : "agent",
        kind: "agent" as const,
        live: liveHere.has(a.handle),
      })),
      ...humanOptions,
      ...props.pages.map(p2 => ({
        handle: p2.slug,
        detail: `page · ${p2.title || "Untitled"}`,
        kind: "page" as const,
      })),
    ];
  }, [status, peers, props.pages]);
  useEffect(() => {
    agentHandlesRef.current = new Set((status?.agents ?? []).map(a => a.handle));
    pageLinksRef.current = new Map(props.pages.map(p2 => [p2.slug, p2.id]));
    mentionOptionsRef.current = mentionOptions;
  }, [status, mentionOptions, props.pages]);

  // a just-created page's @slug link should turn into a pill immediately
  useEffect(() => {
    editorApi.current?.refreshMentions();
  }, [props.pages]);

  const openPage = useCallback(
    (slug: string) => {
      const id = pageLinksRef.current.get(slug);
      if (id) props.onNavigate(id);
    },
    [props.onNavigate]
  );

  /** `/page` in the block menu: create a top-level page, return its slug for
   * the inserted `@slug` link. */
  const createLinkedPage = useCallback(async () => {
    const page = await props.onCreatePage("Untitled");
    return page?.slug ?? null;
  }, [props.onCreatePage]);

  // `![[slug]]` embed blocks mount React inside CodeMirror widgets
  const mountEmbed = usePageEmbeds(props.pages, props.onNavigate);

  if (!doc) return null;

  return (
    <div className="app">
      <Header
        identity={identity}
        onRename={name => setIdentity(renameIdentity(identity, name))}
        peers={peers}
        agents={participatingAgents}
        connected={connected}
        durability={durability}
        openComments={openCount}
        commentsOpen={commentsOpen}
        onToggleComments={() => setCommentsOpen(o => !o)}
        onInviteAgent={() => setInviteOpen(true)}
        theme={theme}
        onToggleTheme={() => setTheme(t => (t === "light" ? "dark" : "light"))}
        sourceMode={sourceMode}
        onToggleSource={() => setSourceMode(s => !s)}
        workspace={props.workspace}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen(o => !o)}
        onSpotlight={applySpotlight}
        spotlightId={spotlight?.id ?? null}
      />

      <div className="doc-layout">
        <Sidebar
          pages={props.pages}
          currentPageId={props.currentPageId}
          collapsed={!sidebarOpen}
          onNavigate={props.onNavigate}
          onCreatePage={() => void props.onCreateAndOpenPage()}
          onCreateCanvas={() => void props.onCreateAndOpenPage(undefined, "canvas")}
          onCreateHtml={() => void props.onCreateAndOpenPage(undefined, "html")}
        />
        <main
          className={
            "doc-main" + (pageKind === "canvas" ? " doc-main--canvas" : pageKind === "html" ? " doc-main--html" : "")
          }
        >
          <div className={pageKind === "canvas" ? "canvas-column" : pageKind === "html" ? "html-column" : "doc-column"}>
            <input
              ref={titleRef}
              className="title-input"
              value={doc.title}
              placeholder="Untitled"
              disabled={!connected}
              onChange={e =>
                changeDoc(d => {
                  A.updateText(d, ["title"], e.target.value);
                })
              }
              onKeyDown={e => {
                if (e.key === "Enter" || e.key === "ArrowDown") {
                  e.preventDefault();
                  editorApi.current?.revealRange(0, 0);
                }
              }}
            />
            {pageKind === "canvas" ? (
              <CanvasEditor
                handle={handle}
                pages={props.pages}
                currentPageId={props.currentPageId}
                onNavigate={props.onNavigate}
                onCreatePage={props.onCreatePage}
                readOnly={!connected}
              />
            ) : pageKind === "html" ? (
              <HtmlView handle={handle} />
            ) : (
            <div className="editor-wrap">
              <Editor
                handle={handle}
                presence={presence}
                onSelectComment={id => {
                  setActiveCommentId(id);
                  setCommentsOpen(true);
                }}
                onSelection={setSelection}
                getMentionOptions={() => mentionOptionsRef.current}
                getAgentHandles={() => agentHandlesRef.current}
                getPageLinks={() => pageLinksRef.current}
                onOpenPage={openPage}
                createPage={createLinkedPage}
                mountEmbed={mountEmbed}
                onExitTop={focusTitleFromEditor}
                onReady={api => {
                  editorApi.current = api;
                  if (sourceMode) api.setSourceMode(true);
                }}
              />
              {selection && !draft && (
                <SelectionToolbar
                  selection={selection}
                  onFormat={action => editorApi.current?.format(action)}
                  onColor={(color, background) => editorApi.current?.applyColor(color, background)}
                  onComment={startDraft}
                />
              )}
            </div>
            )}
          </div>
        </main>

        {commentsOpen && (
          <CommentsPanel
            comments={visibleComments}
            identity={identity}
            activeId={activeCommentId}
            onActivate={setActiveCommentId}
            onReveal={revealComment}
            draft={draft}
            onSubmitDraft={submitDraft}
            onCancelDraft={() => setDraft(null)}
            changeDoc={changeDoc}
            agentHandles={agentHandlesRef.current}
            mentionOptions={mentionOptions}
            filter={spotlight}
            onClearFilter={() => spotlight && applySpotlight(spotlight)}
          />
        )}
      </div>

      <InviteAgentModal
        open={inviteOpen}
        pageId={props.currentPageId}
        pageTitle={doc.title}
        onClose={() => setInviteOpen(false)}
      />

      {paletteOpen && (
        <CommandPalette
          pages={props.pages}
          currentPageId={props.currentPageId}
          onNavigate={props.onNavigate}
          onCreatePage={title => void props.onCreateAndOpenPage(title)}
          onClose={() => setPaletteOpen(false)}
        />
      )}
    </div>
  );
}
