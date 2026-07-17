/**
 * The integrated agent: Kimi K3 (Moonshot API, OpenAI-compatible) editing a
 * hyperframes project through a server-side tool loop. Configured via
 * KIMI_API_KEY (+ optional KIMI_MODEL / KIMI_BASE_URL); absent → the endpoint
 * 404s and the UI hides the panel (/api/status reports `kimi`).
 *
 * Kimi's edits flow through the same change paths as external agents — tagged
 * with the "kimi" agent handle, so attribution, avatars, and the activity
 * feed treat it exactly like any other collaborator.
 */
import * as A from "@automerge/automerge";
import type { PageEntry } from "./repo";
import type { KimiConfig } from "./config";
import type { NotificationCenter } from "./notifications";
import { ApiError } from "./errors";
import { planEdits, type EditOp } from "./edits";
import { enqueue } from "./typewriter";
import { listProjectFiles, readProjectFile, writeProjectFile } from "./hyperframes";
import { colorFor } from "../shared/identity";
import { nowId, type PresenceMessage } from "../shared/types";

const KIMI_HANDLE = "kimi";
const KIMI_NAME = "Kimi K3";
const MAX_ITERATIONS = 16;
const MAX_CONCURRENT = 2;
const READ_CAP = 120_000; // chars per read_file result

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

const TOOLS = [
  tool("list_files", "List every file in the project with type and size.", {}),
  tool("read_file", "Read a text file's current content.", {
    path: { type: "string", description: "project-relative path, e.g. index.html" },
  }),
  tool("edit_file", "Surgically edit a text file via exact-match replacement. Preferred for small changes — merges cleanly with concurrent edits.", {
    path: { type: "string" },
    oldText: { type: "string", description: "exact text to replace (must match uniquely)" },
    newText: { type: "string" },
  }),
  tool("write_file", "Create a new text file, or fully replace an existing one.", {
    path: { type: "string" },
    content: { type: "string" },
  }),
];

function tool(name: string, description: string, properties: Record<string, unknown>) {
  return {
    type: "function" as const,
    function: {
      name,
      description,
      parameters: { type: "object", properties, required: Object.keys(properties) },
    },
  };
}

function systemPrompt(page: PageEntry): string {
  const { entrypoint, files } = listProjectFiles(page);
  const listing = files.map(f => `- ${f.path} (${f.kind}, ${f.byteSize} bytes)`).join("\n");
  return `You are Kimi, an expert motion-graphics engineer embedded in mrkdwn — a collaborative
workspace where humans and AI agents co-edit documents. You are editing the HyperFrames
video project "${page.handle.doc().title}". Humans watch the composition play live in an
embedded player and see your file edits the moment you make them.

Project entrypoint: ${entrypoint}
Files:
${listing}

HyperFrames composition contract (violating it breaks rendering):
- The composition is an HTML file with a sized root element carrying
  data-composition-id, data-width, data-height, data-duration.
- Clips are elements with data-start / data-duration / data-track-index.
- Exactly ONE paused GSAP timeline per composition, registered synchronously at
  window.__timelines["<composition-id>"] — never autoplay it.
- Deterministic only: no Date.now/clocks, no unseeded Math.random, no network fetches,
  no infinite repeats (repeat: -1). The player seeks the timeline; every frame must be
  reproducible.
- Keep ids unique across the page; media elements (<video>/<audio>) stay direct children
  of the composition root.

Working style:
- Read a file before editing it. Prefer edit_file (exact-match) for small changes;
  write_file only for new files or full rewrites.
- This is a LIVE collaborative document: humans and other agents may edit files
  while you work. If an edit fails because the text changed, that's normal —
  re-read the file and retry against its current content. Never conclude the
  backend is broken from an edit conflict.
- Make the change the user asked for — don't rewrite unrelated parts.
- When done, reply with a short plain-text summary of what you changed and why.`;
}

// ---------- jobs ----------
// The tool loop routinely outlives the platform edge's ~60s request window
// (model latency + 429 backoffs), so a chat request only STARTS a job and
// returns immediately; the panel polls /api/kimi/job with short waits. Jobs
// live in memory — mrkdwn is a single stateful process, and a lost job on
// redeploy only loses the chat bubble, never the edits (those are in the doc).

export interface KimiJob {
  id: string;
  pageId: string;
  status: "running" | "done" | "error";
  /** the user ask that started this job — lets a panel that mounts later
   * (navigation, another viewer) reconstruct the conversation */
  message: string;
  /** live one-liner of what Kimi is doing right now ("editing index.html…") */
  note: string;
  /** bumped on every visible change — polls long-wait until it moves */
  seq: number;
  reply?: string;
  error?: string;
  actions: { tool: string; path?: string }[];
  iterations: number;
  createdAt: number;
  updatedAt: number;
}

/** Record visible progress: bump the poll sequence so waiting polls return. */
function bump(job: KimiJob, note?: string): void {
  if (note !== undefined) job.note = note;
  job.seq++;
  job.updatedAt = Date.now();
}

const jobs = new Map<string, KimiJob>();
const JOB_TTL_MS = 15 * 60_000;
const JOB_POLL_MAX_WAIT_S = 25; // long-poll cap — stay far under the edge timeout

function pruneJobs(): void {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.status !== "running" && now - job.updatedAt > JOB_TTL_MS) jobs.delete(id);
  }
}

const runningJobs = () => [...jobs.values()].filter(j => j.status === "running").length;

/** POST /api/kimi/chat — validate, start the job, return 202 immediately. */
export function handleKimiChat(
  deps: { kimi?: KimiConfig; notifications: NotificationCenter },
  page: PageEntry,
  data: Record<string, unknown>
): Response {
  const kimi = deps.kimi;
  if (!kimi) throw new ApiError(404, "the integrated Kimi agent is not configured on this server");
  if (page.record.kind !== "hyperframes")
    throw new ApiError(400, "Kimi is currently available on hyperframes pages only");
  const message = data.message;
  if (typeof message !== "string" || !message.trim()) throw new ApiError(400, 'send { "message": "..." }');
  const history = Array.isArray(data.history) ? (data.history as { role: string; content: string }[]) : [];
  pruneJobs();
  // one run per page: two Kimi jobs editing the same project invalidate each
  // other's exact-match edits and read like phantom "collaborators"
  if ([...jobs.values()].some(j => j.status === "running" && j.pageId === page.record.id))
    throw new ApiError(409, "Kimi is already working on this page — wait for the current run to finish");
  if (runningJobs() >= MAX_CONCURRENT) throw new ApiError(429, "Kimi is busy — try again in a moment");

  const job: KimiJob = {
    id: nowId("kj"),
    pageId: page.record.id,
    status: "running",
    message: message.trim(),
    note: "reading the project…",
    seq: 0,
    actions: [],
    iterations: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  jobs.set(job.id, job);
  // fire and forget — runJob never throws
  void runJob(deps, kimi, page, job, message.trim(), history);
  return Response.json({ ok: true, job: jobView(job) }, { status: 202 });
}

/** GET /api/kimi/job?id=…&wait=…&seq=… — poll a job; `wait` long-polls
 * (seconds, capped) until the job's `seq` moves past the caller's, so every
 * visible change (note, action, completion) returns immediately. */
export async function handleKimiJob(url: URL): Promise<Response> {
  const id = url.searchParams.get("id");
  if (!id) throw new ApiError(400, "pass ?id=<job id> from the chat response");
  const job = jobs.get(id);
  if (!job)
    throw new ApiError(
      404,
      "no such Kimi job — it may have expired or the server restarted (any edits it made are already in the document)"
    );
  const waitS = Math.min(Math.max(0, Number(url.searchParams.get("wait") ?? 0) || 0), JOB_POLL_MAX_WAIT_S);
  const deadline = Date.now() + waitS * 1000;
  // seq is the progress fingerprint; `actions` is the pre-seq client's version
  const seqSeen = url.searchParams.has("seq")
    ? Number(url.searchParams.get("seq"))
    : url.searchParams.has("actions")
      ? NaN // legacy param can't track notes — behave like "return on any action change"
      : -1;
  const actionsSeen = Number(url.searchParams.get("actions") ?? -1);
  const unchanged = () =>
    Number.isNaN(seqSeen) ? job.actions.length === actionsSeen : job.seq === seqSeen;
  while (job.status === "running" && unchanged() && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 300));
  }
  return Response.json({ ok: true, job: jobView(job) });
}

function jobView(job: KimiJob) {
  return {
    id: job.id,
    status: job.status,
    message: job.message,
    note: job.note,
    seq: job.seq,
    createdAt: job.createdAt,
    ...(job.reply !== undefined ? { reply: job.reply } : {}),
    ...(job.error !== undefined ? { error: job.error } : {}),
    actions: job.actions,
    iterations: job.iterations,
  };
}

/** GET /api/kimi/jobs?page=… — the page's active + recent jobs, so a panel
 * mounting later (navigation, reload, another viewer) can re-attach to a
 * running job or backfill a reply that landed while nobody watched. */
export function handleKimiJobs(url: URL): Response {
  const pageId = url.searchParams.get("page");
  if (!pageId) throw new ApiError(400, "pass ?page=<page id>");
  pruneJobs();
  const list = [...jobs.values()]
    .filter(j => j.pageId === pageId)
    .sort((a, b) => Number(b.status === "running") - Number(a.status === "running") || b.createdAt - a.createdAt)
    .slice(0, 6)
    .map(jobView);
  return Response.json({ ok: true, jobs: list });
}

async function runJob(
  deps: { notifications: NotificationCenter },
  kimi: KimiConfig,
  page: PageEntry,
  job: KimiJob,
  message: string,
  history: { role: string; content: string }[]
): Promise<void> {
  try {
    deps.notifications.markSeen(KIMI_HANDLE, KIMI_NAME);
    broadcastKimiPresence(page, true);

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt(page) },
      ...history
        .filter(m => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        .slice(-12)
        .map(m => ({ role: m.role as "user" | "assistant", content: m.content })),
      { role: "user", content: message },
    ];

    for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
      job.iterations = iteration;
      bump(job, iteration === 1 ? "reading the project…" : "thinking about the next step…");
      const reply = await callKimi(kimi, messages, note => bump(job, note));
      messages.push(reply);
      const calls = reply.tool_calls ?? [];
      if (calls.length === 0) {
        job.reply = reply.content?.trim() || "(done)";
        job.status = "done";
        bump(job, "done");
        return;
      }
      for (const call of calls) {
        bump(job, toolNote(call));
        const output = await runTool(page, call, job.actions);
        bump(job);
        messages.push({ role: "tool", content: output, tool_call_id: call.id });
      }
    }
    job.error = "Kimi did not settle within the tool-call budget — try a narrower ask";
    job.status = "error";
  } catch (e) {
    job.error = e instanceof ApiError ? e.message : "Kimi run failed unexpectedly";
    job.status = "error";
    if (!(e instanceof ApiError)) console.error("[mrkdwn] kimi job failed:", e);
  } finally {
    bump(job);
    broadcastKimiPresence(page, false);
  }
}

function toolNote(call: ToolCall): string {
  let path = "";
  try {
    path = String((JSON.parse(call.function.arguments || "{}") as { path?: unknown }).path ?? "");
  } catch {}
  switch (call.function.name) {
    case "list_files":
      return "surveying the project files…";
    case "read_file":
      return path ? `reading ${path}…` : "reading a file…";
    case "edit_file":
      return path ? `editing ${path}…` : "editing…";
    case "write_file":
      return path ? `writing ${path}…` : "writing a file…";
    default:
      return "working…";
  }
}

async function callKimi(
  kimi: KimiConfig,
  messages: ChatMessage[],
  onNote?: (note: string) => void
): Promise<ChatMessage> {
  // upstream providers rate-limit in bursts — ride them out instead of
  // bouncing an error into the chat panel
  const backoffMs = [2_000, 5_000, 12_000];
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${kimi.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${kimi.apiKey}` },
        body: JSON.stringify({ model: kimi.model, messages, tools: TOOLS, temperature: 0.4 }),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (e) {
      throw new ApiError(502, `couldn't reach the Kimi API: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (res.ok) {
      const payload = (await res.json()) as { choices?: { message?: ChatMessage }[] };
      const reply = payload.choices?.[0]?.message;
      if (!reply) throw new ApiError(502, "Kimi API returned no completion");
      return reply;
    }
    const retryable = res.status === 429 || res.status >= 500;
    const wait = backoffMs[attempt];
    if (!retryable || wait === undefined) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      throw new ApiError(502, `Kimi API error ${res.status}: ${detail}`);
    }
    await res.body?.cancel();
    onNote?.(
      res.status === 429
        ? `the model is rate-limited upstream — retrying in ${Math.round(wait / 1000)}s…`
        : `the model API hiccuped (${res.status}) — retrying…`
    );
    await new Promise(r => setTimeout(r, wait));
  }
}

async function runTool(page: PageEntry, call: ToolCall, actions: KimiJob["actions"]): Promise<string> {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
  } catch {
    return "error: tool arguments were not valid JSON";
  }
  try {
    switch (call.function.name) {
      case "list_files":
        return JSON.stringify(listProjectFiles(page));
      case "read_file": {
        const { file, path } = readProjectFile(page, String(args.path ?? ""));
        if (file.kind !== "text") return `error: ${path} is a binary asset (${file.mimeType}, ${file.byteSize} bytes)`;
        return file.content.length > READ_CAP ? `${file.content.slice(0, READ_CAP)}\n…(truncated)` : file.content;
      }
      case "edit_file": {
        const path = String(args.path ?? "");
        const edit: EditOp = { oldText: String(args.oldText ?? ""), newText: String(args.newText ?? "") };
        await enqueue(page.handle.url, async () => {
          const { file, path: cleaned } = readProjectFile(page, path);
          if (file.kind !== "text") throw new ApiError(400, `${cleaned} is a binary asset`);
          const { splices } = planEdits(file.content, [edit]);
          page.handle.change(d => {
            for (const s of splices)
              A.splice(d, ["hyperframes", "files", cleaned, "content"], s.index, s.delText.length, s.ins);
          }, kimiChange());
        });
        actions.push({ tool: "edit_file", path });
        return `ok: edited ${path}`;
      }
      case "write_file": {
        const path = String(args.path ?? "");
        await enqueue(page.handle.url, async () => {
          writeProjectFile(page, path, String(args.content ?? ""), kimiChange());
        });
        actions.push({ tool: "write_file", path });
        return `ok: wrote ${path}`;
      }
      default:
        return `error: unknown tool ${call.function.name}`;
    }
  } catch (e) {
    // tool errors go back to the model so it can self-correct
    const message = e instanceof Error ? e.message : String(e);
    if (message.includes("oldText not found") || message.includes("matches") /* ambiguity */) {
      return `error: the file changed since you read it (collaborators edit live) — call read_file again and retry your edit against the exact current text. (${message})`;
    }
    return `error: ${message}`;
  }
}

const kimiChange = () => ({ message: JSON.stringify({ agent: KIMI_HANDLE }) });

/** Kimi shows up like any other agent: avatar + "writing" hint on the page. */
function broadcastKimiPresence(page: PageEntry, typing: boolean): void {
  const msg: PresenceMessage = {
    type: "presence",
    user: { id: `agent:${KIMI_HANDLE}`, name: KIMI_NAME, color: colorFor(`agent:${KIMI_HANDLE}`), kind: "agent" },
    anchor: null,
    head: null,
    typing,
    ts: Date.now(),
  };
  try {
    page.handle.broadcast(msg);
  } catch {
    // presence is best-effort
  }
}
