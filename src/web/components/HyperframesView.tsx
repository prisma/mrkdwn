/**
 * HyperFrames pages: the live player (compositions execute on the preview
 * origin, cross-origin from the app — see server/hyperframes.ts), the project
 * file tree, and the integrated Kimi chat when the server has it configured.
 *
 * Humans watch and direct; agents (external ones over REST, Kimi in the
 * panel here) edit the project files. Every edit re-renders the preview.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import * as A from "@automerge/automerge";
import { useDocument } from "@automerge/automerge-repo-react-hooks";
import type { DocHandle } from "@automerge/automerge-repo/slim";
import type { MrkdwnDoc } from "../../shared/types";
import { hyperframesRenderSize, parseCompositionDuration } from "../../shared/hyperframes";
import { usePreviewOrigin } from "../app/preview";

/** Debounced doc-version key: bursts of agent edits settle before the player
 * reloads (a reload resets playback position). */
function useDocVersion(automergeUrl: string, settleMs = 800): string {
  const [doc] = useDocument<MrkdwnDoc>(automergeUrl as never, { suspense: false });
  const [version, setVersion] = useState("0");
  useEffect(() => {
    if (!doc) return;
    const t = setTimeout(() => {
      try {
        setVersion(A.getHeads(doc).join("").slice(0, 16) || "0");
      } catch {}
    }, settleMs);
    return () => clearTimeout(t);
  }, [doc, settleMs]);
  return version;
}

/** The player shell in a cross-origin iframe. Shared by the full view, the
 * markdown `![[slug]]` embed, and canvas file nodes. No sandbox attribute on
 * purpose: isolation comes from the cross-origin preview URL, and a sandbox
 * here would inherit into the player's inner iframe and break its
 * same-origin timeline control. */
export function HyperframesFrame(p: {
  pageId: string;
  automergeUrl: string;
  className?: string;
  title?: string;
  autoplay?: boolean;
  loop?: boolean;
}) {
  const origin = usePreviewOrigin();
  const version = useDocVersion(p.automergeUrl);
  if (!origin) return <div className="md-embed-loading">loading player…</div>;
  const params = new URLSearchParams({ v: version });
  if (p.autoplay) params.set("autoplay", "1");
  if (p.loop) params.set("loop", "1");
  return (
    <iframe
      className={p.className ?? "hf-frame"}
      src={`${origin}/preview/${p.pageId}/player?${params}`}
      title={p.title ?? "HyperFrames preview"}
      allow="autoplay; fullscreen"
      referrerPolicy="no-referrer"
    />
  );
}

export function HyperframesView(p: {
  handle: DocHandle<MrkdwnDoc>;
  pageId: string;
  kimi: boolean;
  readOnly?: boolean;
}) {
  const [doc] = useDocument<MrkdwnDoc>(p.handle.url, { suspense: false });
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [filesOpen, setFilesOpen] = useState(false);

  const project = doc?.hyperframes;
  const size = hyperframesRenderSize(project);
  const entry = project?.files[project.entrypoint];
  const duration = entry?.kind === "text" ? parseCompositionDuration(entry.content) : null;

  const paths = useMemo(() => (project ? Object.keys(project.files).sort() : []), [project]);
  const selected = selectedPath && project ? project.files[selectedPath] : undefined;

  if (!doc || !project) return null;

  return (
    <div className="hf-view">
      <div className="hf-stage">
        <HyperframesFrame pageId={p.pageId} automergeUrl={p.handle.url} title={doc.title || "HyperFrames project"} />
      </div>
      <div className="hf-meta">
        <span>
          {size.width}×{size.height}
          {duration ? ` · ${duration}s` : ""} · {paths.length} file{paths.length === 1 ? "" : "s"} · plays live as
          agents edit
        </span>
        <span className="hf-meta-actions">
          <button className="linkbtn" onClick={() => setFilesOpen(o => !o)}>
            {filesOpen ? "Hide files" : "Browse files"}
          </button>
          <a className="linkbtn" href={`/api/hyperframes/export?page=${p.pageId}`}>
            Download .zip
          </a>
        </span>
      </div>

      <div className="hf-panels">
        {filesOpen && (
          <div className="hf-files">
            <div className="hf-files-list">
              {paths.map(path => {
                const f = project.files[path]!;
                return (
                  <button
                    key={path}
                    className={"hf-file" + (path === selectedPath ? " hf-file--active" : "")}
                    onClick={() => setSelectedPath(path === selectedPath ? null : path)}
                  >
                    <span className="hf-file-path">{path}</span>
                    <span className="hf-file-kind">
                      {path === project.entrypoint ? "entrypoint" : f.kind === "blob" ? f.mimeType : ""}
                    </span>
                  </button>
                );
              })}
            </div>
            {selected && selectedPath && (
              <div className="hf-file-body">
                {selected.kind === "text" ? (
                  <pre>{selected.content}</pre>
                ) : (
                  <div className="hf-file-blob">
                    binary asset · {selected.mimeType} · {Math.round(selected.byteSize / 1024)} KB
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        {p.kimi && <KimiPanel pageId={p.pageId} disabled={p.readOnly ?? false} />}
      </div>
    </div>
  );
}

// ---------- Kimi chat ----------

interface KimiTurn {
  role: "user" | "assistant";
  content: string;
  actions?: { tool: string; path?: string }[];
  error?: boolean;
}

function KimiPanel(p: { pageId: string; disabled: boolean }) {
  const [turns, setTurns] = useState<KimiTurn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [turns, busy]);

  const send = async () => {
    const message = input.trim();
    if (!message || busy) return;
    setInput("");
    const history = turns.filter(t => !t.error).map(t => ({ role: t.role, content: t.content }));
    setTurns(t => [...t, { role: "user", content: message }]);
    setBusy(true);
    try {
      const res = await fetch(`/api/kimi/chat?page=${p.pageId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, history }),
      });
      const data = (await res.json()) as { reply?: string; actions?: KimiTurn["actions"]; error?: string };
      if (!res.ok || !data.reply) {
        setTurns(t => [...t, { role: "assistant", content: data.error ?? "Kimi request failed", error: true }]);
      } else {
        setTurns(t => [...t, { role: "assistant", content: data.reply!, actions: data.actions }]);
      }
    } catch (e) {
      setTurns(t => [...t, { role: "assistant", content: `Kimi request failed: ${String(e)}`, error: true }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="hf-kimi">
      <div className="hf-kimi-head">
        <span className="hf-kimi-dot" />
        Kimi <span className="hf-kimi-model">the integrated agent — ask for changes to this video</span>
      </div>
      <div className="hf-kimi-log" ref={logRef}>
        {turns.length === 0 && !busy && (
          <div className="hf-kimi-empty">
            “Make the title slide in from the left”, “add a closing card with our logo”, “tighten the pacing to 4
            seconds” — Kimi edits the project files and the preview updates live.
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i} className={`hf-kimi-turn hf-kimi-turn--${t.role}${t.error ? " hf-kimi-turn--error" : ""}`}>
            <div className="hf-kimi-bubble">{t.content}</div>
            {t.actions && t.actions.length > 0 && (
              <div className="hf-kimi-actions">
                {t.actions.map((a, j) => (
                  <span key={j} className="hf-kimi-action">
                    {a.tool === "write_file" ? "wrote" : "edited"} {a.path}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
        {busy && <div className="hf-kimi-turn hf-kimi-turn--assistant"><div className="hf-kimi-bubble hf-kimi-busy">Kimi is working…</div></div>}
      </div>
      <div className="hf-kimi-input">
        <textarea
          value={input}
          placeholder={p.disabled ? "Offline — reconnect to talk to Kimi" : "Ask Kimi to change the video…"}
          disabled={p.disabled || busy}
          rows={2}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <button className="btn btn--primary" disabled={p.disabled || busy || !input.trim()} onClick={() => void send()}>
          Send
        </button>
      </div>
    </div>
  );
}
