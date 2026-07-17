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
import type { KimiChatTurn, MrkdwnDoc } from "../../shared/types";
import { loadIdentity } from "../app/identity";
import { getProjectFile, hyperframesRenderSize, parseCompositionDuration, projectPaths } from "../../shared/hyperframes";
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
  const entry = project ? getProjectFile(project, project.entrypoint) : undefined;
  const duration = entry?.kind === "text" ? parseCompositionDuration(entry.content) : null;

  const paths = useMemo(() => (project ? projectPaths(project) : []), [project]);
  const selected = selectedPath && project ? getProjectFile(project, selectedPath) : undefined;

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
                const f = getProjectFile(project, path)!;
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
        {p.kimi && <KimiPanel pageId={p.pageId} handle={p.handle} disabled={p.readOnly ?? false} />}
      </div>
    </div>
  );
}

// ---------- Kimi chat ----------

interface KimiJobPayload {
  id: string;
  status: "running" | "done" | "error";
  message?: string;
  note?: string;
  seq?: number;
  reply?: string;
  error?: string;
  actions?: KimiChatTurn["actions"];
}

/** Parse a response that SHOULD be JSON but may be an HTML error page from
 * an intermediary (edge timeouts, 502 pages). Never throws. */
async function parseJson<T>(res: Response): Promise<T | null> {
  try {
    const text = await res.text();
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** The transcript lives in the page's Automerge doc (doc.kimiChat, written
 * server-side) — synced live to every viewer, persisted with the page,
 * carried by forks. The panel derives turns from the doc and only manages
 * the ephemeral run state (busy/note/chips) by polling the active job. */
function KimiPanel(p: { pageId: string; handle: DocHandle<MrkdwnDoc>; disabled: boolean }) {
  const [doc] = useDocument<MrkdwnDoc>(p.handle.url, { suspense: false });
  const turns = useMemo(
    () => Object.values(doc?.kimiChat ?? {}).sort((a, b) => a.createdAt - b.createdAt),
    [doc]
  );
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [busyActions, setBusyActions] = useState<KimiChatTurn["actions"]>([]);
  const [busyNote, setBusyNote] = useState("");
  const [elapsed, setElapsed] = useState(0);
  /** client-side-only failures (network loss, server restart) — not part of
   * the shared transcript */
  const [localNote, setLocalNote] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  const attachedJob = useRef<string | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [turns, busy, busyActions, busyNote, localNote]);

  // a ticking clock makes a long run feel alive (and honest)
  useEffect(() => {
    if (!busy) return;
    const started = Date.now();
    setElapsed(0);
    const t = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(t);
  }, [busy]);

  const settle = (note?: string) => {
    if (!alive.current) return;
    setBusyActions([]);
    setBusyNote("");
    setBusy(false);
    setLocalNote(note ?? null);
  };

  /** Poll a job until it settles. The completed turn arrives through doc
   * sync (the server writes it), so settling only clears the run UI.
   * Transient poll failures (redeploys, blips) retry before giving up. */
  const attachToJob = async (jobId: string) => {
    if (attachedJob.current === jobId) return; // mount-reconcile + send raced
    attachedJob.current = jobId;
    setBusy(true);
    setLocalNote(null);
    let failures = 0;
    let seenSeq = -1;
    while (alive.current) {
      let job: KimiJobPayload | undefined;
      try {
        // the timeout matters: a silently-dropped long-poll connection
        // would otherwise hang this await forever, freezing the panel on
        // "working…" while the job finishes without us
        const res = await fetch(`/api/kimi/job?id=${jobId}&wait=20&seq=${seenSeq}`, {
          signal: AbortSignal.timeout(30_000),
        });
        const data = await parseJson<{ job?: KimiJobPayload; error?: string }>(res);
        if (res.status === 404) {
          settle("Kimi's run was interrupted — any edits it made are already in the project.");
          return;
        }
        if (res.ok && data?.job) {
          job = data.job;
          failures = 0;
        }
      } catch {
        // network blip / timed-out poll — fall through to the retry counter
      }
      if (!job) {
        failures++;
        if (failures >= 4) {
          settle("Lost contact with the server while Kimi was working — its reply will appear when you're back online.");
          return;
        }
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }
      seenSeq = job.seq ?? -1;
      setBusyActions(job.actions ?? []);
      if (job.note) setBusyNote(job.note);
      if (job.status !== "running") {
        settle();
        return;
      }
    }
  };

  // mount reconcile: a job may be running — started before we navigated
  // here, or by another viewer. Its turns are already in the doc.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await fetch(`/api/kimi/jobs?page=${p.pageId}`).catch(() => null);
      const data = res && res.ok ? await parseJson<{ jobs?: KimiJobPayload[] }>(res) : null;
      if (cancelled || !alive.current) return;
      const running = (data?.jobs ?? []).find(j => j.status === "running");
      if (running) void attachToJob(running.id);
    })();
    return () => {
      cancelled = true;
    };
    // runs once per page mount (the panel remounts with the page)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.pageId]);

  /** The tool loop outlives the platform's ~60s request window, so chat only
   * starts a job; attachToJob polls it with short long-poll requests. The
   * user turn shows up via doc sync the moment the server records it. */
  const send = async () => {
    const message = input.trim();
    if (!message || busy) return;
    setInput("");
    setBusy(true);
    setBusyActions([]);
    setLocalNote(null);
    try {
      const started = await fetch(`/api/kimi/chat?page=${p.pageId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, author: loadIdentity().name }),
      });
      const startData = await parseJson<{ job?: KimiJobPayload; error?: string }>(started);
      const jobId = startData?.job?.id;
      if (!started.ok || !jobId) {
        settle(startData?.error ?? `Kimi request failed (${started.status})`);
        setInput(message); // let them retry without retyping
        return;
      }
      await attachToJob(jobId);
    } catch (e) {
      settle(`Kimi request failed: ${String(e)}`);
      setInput(message);
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
        {turns.map(t => (
          <div key={t.id} className={`hf-kimi-turn hf-kimi-turn--${t.role}${t.error ? " hf-kimi-turn--error" : ""}`}>
            {t.role === "user" && t.author && <div className="hf-kimi-author">{t.author}</div>}
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
        {localNote && !busy && <div className="hf-kimi-localnote">{localNote}</div>}
        {busy && (
          <div className="hf-kimi-turn hf-kimi-turn--assistant">
            <div className="hf-kimi-bubble hf-kimi-busy">
              <span className="hf-kimi-pulse" aria-hidden>
                <i /><i /><i />
              </span>
              {busyNote || "Kimi is working…"}
              {elapsed >= 5 && <span className="hf-kimi-elapsed"> · {elapsed >= 60 ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : `${elapsed}s`}</span>}
            </div>
            {busyActions && busyActions.length > 0 && (
              <div className="hf-kimi-actions">
                {busyActions.map((a, j) => (
                  <span key={j} className="hf-kimi-action">
                    {a.tool === "write_file" ? "wrote" : "edited"} {a.path}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
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
