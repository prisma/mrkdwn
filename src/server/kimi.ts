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
import type { PresenceMessage } from "../shared/types";

const KIMI_HANDLE = "kimi";
const KIMI_NAME = "Kimi K3";
const MAX_ITERATIONS = 16;
const MAX_CONCURRENT = 2;
const READ_CAP = 120_000; // chars per read_file result

let active = 0;

export interface KimiChatResult {
  ok: true;
  reply: string;
  /** file-touching actions, for the UI activity line */
  actions: { tool: string; path?: string }[];
  iterations: number;
}

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
- Make the change the user asked for — don't rewrite unrelated parts.
- When done, reply with a short plain-text summary of what you changed and why.`;
}

export async function handleKimiChat(
  deps: { kimi?: KimiConfig; notifications: NotificationCenter },
  page: PageEntry,
  data: Record<string, unknown>
): Promise<Response> {
  const kimi = deps.kimi;
  if (!kimi) throw new ApiError(404, "the integrated Kimi agent is not configured on this server");
  if (page.record.kind !== "hyperframes")
    throw new ApiError(400, "Kimi is currently available on hyperframes pages only");
  const message = data.message;
  if (typeof message !== "string" || !message.trim()) throw new ApiError(400, 'send { "message": "..." }');
  const history = Array.isArray(data.history) ? (data.history as { role: string; content: string }[]) : [];
  if (active >= MAX_CONCURRENT) throw new ApiError(429, "Kimi is busy — try again in a moment");

  active++;
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
    const actions: KimiChatResult["actions"] = [];

    for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
      const reply = await callKimi(kimi, messages);
      messages.push(reply);
      const calls = reply.tool_calls ?? [];
      if (calls.length === 0) {
        broadcastKimiPresence(page, false);
        const result: KimiChatResult = {
          ok: true,
          reply: reply.content?.trim() || "(done)",
          actions,
          iterations: iteration,
        };
        return Response.json(result);
      }
      for (const call of calls) {
        const output = await runTool(page, call, actions);
        messages.push({ role: "tool", content: output, tool_call_id: call.id });
      }
    }
    throw new ApiError(502, "Kimi did not settle within the tool-call budget — try a narrower ask");
  } finally {
    active--;
    broadcastKimiPresence(page, false);
  }
}

async function callKimi(kimi: KimiConfig, messages: ChatMessage[]): Promise<ChatMessage> {
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
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    throw new ApiError(502, `Kimi API error ${res.status}: ${detail}`);
  }
  const payload = (await res.json()) as { choices?: { message?: ChatMessage }[] };
  const reply = payload.choices?.[0]?.message;
  if (!reply) throw new ApiError(502, "Kimi API returned no completion");
  return reply;
}

async function runTool(page: PageEntry, call: ToolCall, actions: KimiChatResult["actions"]): Promise<string> {
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
    return `error: ${e instanceof Error ? e.message : String(e)}`;
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
