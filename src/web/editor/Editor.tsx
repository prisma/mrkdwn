import { useEffect, useRef } from "react";
import { Compartment, EditorState, Prec, Transaction } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  dropCursor,
  highlightSpecialChars,
  keymap,
  placeholder,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { automergeSyncPlugin } from "@automerge/automerge-codemirror";
// not re-exported from the package index, but public in its module graph
import { isReconcileTx } from "@automerge/automerge-codemirror/dist/plugin.js";
import type { DocHandle } from "@automerge/automerge-repo/slim";
import type { MrkdwnDoc } from "../../shared/types";
import type { PresenceStore } from "../app/presence";
import { markdownTheme } from "./theme";
import { presenceExtension } from "./presenceExt";
import { markdownDecorations, refreshMentions } from "./markdownDecor";
import { commentsExtension, setCommentRanges, type CommentRange } from "./commentsExt";
import { mentionAutocomplete, type MentionOption } from "./mentionsExt";
import { activeFormats, applyColor, formatCommands, formatKeymap, type FormatAction, type MdColor } from "./formatKeys";
import { livePreview, setSourceMode } from "./livePreview";
import { blockEdit } from "./blockEdit";
import { blockHandles } from "./blockHandles";
import { tables } from "./tableWidget";
import { authorHighlight, setAuthorSpotlight, type AuthorSpotlight } from "./authorHighlight";

export interface SelectionInfo {
  from: number;
  to: number;
  /** coordinates relative to the editor wrapper, for the selection toolbar */
  x: number;
  y: number;
  /** formats already wrapping the selection (toolbar active states) */
  active: Set<FormatAction>;
}

export interface EditorApi {
  setCommentRanges(ranges: CommentRange[]): void;
  revealRange(from: number, to: number): void;
  focus(): void;
  format(action: FormatAction): void;
  applyColor(color: MdColor | null, background: boolean): void;
  setSourceMode(on: boolean): void;
  /** re-classify mentions after the pages/agents registries change */
  refreshMentions(): void;
  /** tint a collaborator's contributions in their color (null clears) */
  setAuthorSpotlight(spotlight: AuthorSpotlight | null): void;
  /** lock the doc while the server connection is down (remote sync still applies) */
  setEditable(on: boolean): void;
}

interface EditorProps {
  handle: DocHandle<MrkdwnDoc>;
  presence: PresenceStore;
  onSelectComment(id: string): void;
  onSelection(sel: SelectionInfo | null): void;
  getMentionOptions(): MentionOption[];
  getAgentHandles(): Set<string>;
  /** page slug → page id, for @page-slug links */
  getPageLinks(): Map<string, string>;
  onOpenPage(slug: string): void;
  /** `/page`: create a top-level page, resolve its slug (null = failed) */
  createPage(): Promise<string | null>;
  /** ArrowUp with nowhere to go — the caret leaves the doc into the title */
  onExitTop(): void;
  onReady(api: EditorApi): void;
}

/** Undo/redo must skip changes that arrived from other people. */
const remoteChangesOutOfHistory = EditorState.transactionExtender.of(tr =>
  isReconcileTx(tr) ? { annotations: Transaction.addToHistory.of(false) } : null
);

/** While read-only (connection lost), swallow user-originated doc changes but
 * let automerge reconciliations through — reconnecting must still sync. */
const readOnlyGuard = EditorState.transactionFilter.of(tr =>
  tr.startState.readOnly && tr.docChanged && !isReconcileTx(tr) ? [] : tr
);

export function Editor(props: EditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  useEffect(() => {
    const host = hostRef.current!;
    const p = propsRef.current;

    const selectionNotifier = EditorView.updateListener.of(u => {
      if (!u.selectionSet && !u.docChanged && !u.geometryChanged) return;
      const sel = u.state.selection.main;
      if (sel.empty) {
        propsRef.current.onSelection(null);
        return;
      }
      // measure after the dispatch settles (setTimeout, not rAF — rAF stalls
      // in backgrounded tabs and the toolbar would never appear)
      setTimeout(() => {
        try {
          const coords = u.view.coordsAtPos(sel.head);
          if (!coords) return propsRef.current.onSelection(null);
          const box = host.getBoundingClientRect();
          const from = Math.min(sel.from, sel.to);
          const to = Math.max(sel.from, sel.to);
          propsRef.current.onSelection({
            from,
            to,
            x: coords.left - box.left,
            y: coords.top - box.top,
            active: activeFormats(u.view.state, from, to),
          });
        } catch (err) {
          console.error("[mrkdwn] selection notify failed:", err);
        }
      }, 0);
    });

    // ArrowUp on the top visual row hands focus to the title input
    const exitTop = Prec.highest(
      keymap.of([
        {
          key: "ArrowUp",
          run: view => {
            const sel = view.state.selection.main;
            if (!sel.empty) return false;
            const up = view.moveVertically(sel, false);
            if (up.head !== sel.head) return false;
            propsRef.current.onExitTop();
            return true;
          },
        },
      ])
    );

    const editable = new Compartment();

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: p.handle.doc().content,
        extensions: [
          exitTop,
          keymap.of([...formatKeymap, ...defaultKeymap, ...historyKeymap]),
          history(),
          remoteChangesOutOfHistory,
          readOnlyGuard,
          editable.of([]),
          drawSelection(),
          dropCursor(),
          highlightSpecialChars(),
          EditorView.lineWrapping,
          placeholder("Write markdown — # heading,  - [ ] task,  @claude …"),
          markdown({ base: markdownLanguage, codeLanguages: languages, addKeymap: true }),
          markdownTheme,
          livePreview(),
          tables(),
          blockEdit(),
          blockHandles({ createPage: () => propsRef.current.createPage() }),
          automergeSyncPlugin({ handle: p.handle, path: ["content"] }),
          presenceExtension(p.presence),
          markdownDecorations({
            agentHandles: () => propsRef.current.getAgentHandles(),
            pageLinks: () => propsRef.current.getPageLinks(),
            onOpenPage: slug => propsRef.current.onOpenPage(slug),
          }),
          commentsExtension(id => propsRef.current.onSelectComment(id)),
          authorHighlight(),
          mentionAutocomplete(() => propsRef.current.getMentionOptions()),
          selectionNotifier,
        ],
      }),
    });

    // debugging hook (harmless in production; single-doc app)
    (window as unknown as Record<string, unknown>).__mrkdwnView = view;

    p.onReady({
      setCommentRanges(ranges) {
        try {
          view.dispatch({ effects: setCommentRanges.of(ranges) });
        } catch {}
      },
      revealRange(from, to) {
        const len = view.state.doc.length;
        const safeFrom = Math.min(from, len);
        const safeTo = Math.min(to, len);
        view.dispatch({
          selection: { anchor: safeFrom, head: safeTo },
          effects: EditorView.scrollIntoView(safeFrom, { y: "center" }),
        });
        view.focus();
      },
      focus() {
        view.focus();
      },
      format(action) {
        formatCommands[action]({ state: view.state, dispatch: view.dispatch });
        view.focus();
      },
      applyColor(color, background) {
        applyColor(color, background)({ state: view.state, dispatch: view.dispatch });
        view.focus();
      },
      setSourceMode(on) {
        try {
          view.dispatch({ effects: setSourceMode.of(on) });
        } catch {}
      },
      refreshMentions() {
        try {
          view.dispatch({ effects: refreshMentions.of(null) });
        } catch {}
      },
      setAuthorSpotlight(spotlight) {
        try {
          view.dispatch({ effects: setAuthorSpotlight.of(spotlight) });
        } catch {}
      },
      setEditable(on) {
        try {
          view.dispatch({
            effects: editable.reconfigure(on ? [] : [EditorState.readOnly.of(true), EditorView.editable.of(false)]),
          });
        } catch {}
      },
    });

    return () => view.destroy();
    // mount once — live values flow through propsRef
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div className="editor-host" ref={hostRef} />;
}
