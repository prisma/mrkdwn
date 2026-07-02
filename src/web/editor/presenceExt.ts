/**
 * Remote carets & selections, and the outgoing side of presence.
 *
 * Incoming: peers' Automerge cursors are resolved to positions and drawn as a
 * caret widget (with a name flag that fades after inactivity) plus a tinted
 * selection. Between presence updates the decorations are mapped through
 * document changes, so remote carets ride along smoothly while you type.
 *
 * Outgoing: local selection changes are pushed to the PresenceStore, which
 * throttles, converts to cursors, and broadcasts.
 */
import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { PresenceStore } from "../app/presence";

interface ResolvedPeer {
  key: string;
  name: string;
  color: string;
  kind: "human" | "agent";
  anchor: number | null;
  head: number;
  typing: boolean;
  /** show the name flag (recent movement/typing) */
  flag: boolean;
}

const setPeers = StateEffect.define<ResolvedPeer[]>();
const FLAG_TTL_MS = 4000;

class CaretWidget extends WidgetType {
  constructor(private p: ResolvedPeer) {
    super();
  }

  override eq(other: CaretWidget): boolean {
    const a = this.p;
    const b = other.p;
    return (
      a.key === b.key && a.name === b.name && a.color === b.color && a.typing === b.typing && a.flag === b.flag && a.kind === b.kind
    );
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "rc";
    wrap.style.setProperty("--rc", this.p.color);

    const caret = document.createElement("span");
    caret.className = "rc-caret";
    wrap.appendChild(caret);

    const flag = document.createElement("span");
    flag.className = "rc-flag" + (this.p.flag ? " rc-flag--show" : "");
    flag.textContent = (this.p.kind === "agent" ? "✳ " : "") + this.p.name + (this.p.typing ? " …" : "");
    wrap.appendChild(flag);
    return wrap;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

function buildDecorations(peers: ResolvedPeer[], docLen: number): DecorationSet {
  const ranges = [];
  for (const p of peers) {
    const head = Math.max(0, Math.min(p.head, docLen));
    if (p.anchor !== null && p.anchor !== p.head) {
      const from = Math.max(0, Math.min(Math.min(p.anchor, p.head), docLen));
      const to = Math.max(0, Math.min(Math.max(p.anchor, p.head), docLen));
      if (from < to)
        ranges.push(
          Decoration.mark({ class: "rc-sel", attributes: { style: `--rc:${p.color}` } }).range(from, to)
        );
    }
    ranges.push(Decoration.widget({ widget: new CaretWidget(p), side: -1 }).range(head));
  }
  return Decoration.set(ranges, true);
}

export function presenceExtension(store: PresenceStore): Extension {
  const field = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(deco, tr) {
      deco = deco.map(tr.changes);
      for (const e of tr.effects) if (e.is(setPeers)) deco = buildDecorations(e.value, tr.newDoc.length);
      return deco;
    },
    provide: f => EditorView.decorations.from(f),
  });

  const plugin = ViewPlugin.fromClass(
    class {
      private unsub: () => void;
      private dead = false;

      constructor(private view: EditorView) {
        this.unsub = store.subscribe(() => this.schedule());
        this.schedule();
      }

      update(u: ViewUpdate): void {
        if (u.selectionSet || u.docChanged) {
          const sel = u.state.selection.main;
          const typed = u.transactions.some(tr => tr.isUserEvent("input") || tr.isUserEvent("delete"));
          store.setLocalSelection(sel.anchor, sel.head, typed && u.docChanged);
        }
        // doc changed (locally or via reconciliation) → re-resolve peer cursors
        if (u.docChanged) this.schedule();
      }

      private schedule(): void {
        queueMicrotask(() => {
          if (this.dead) return;
          const now = Date.now();
          const resolved: ResolvedPeer[] = [];
          for (const peer of store.getPeers()) {
            const head = store.resolve(peer.head);
            if (head === null) continue;
            resolved.push({
              key: peer.user.id,
              name: peer.user.name,
              color: peer.user.color,
              kind: peer.user.kind,
              anchor: store.resolve(peer.anchor),
              head,
              typing: peer.typing,
              flag: peer.typing || now - peer.lastMoved < FLAG_TTL_MS,
            });
          }
          try {
            this.view.dispatch({ effects: setPeers.of(resolved) });
          } catch {}
        });
      }

      destroy(): void {
        this.dead = true;
        this.unsub();
      }
    }
  );

  return [field, plugin];
}
