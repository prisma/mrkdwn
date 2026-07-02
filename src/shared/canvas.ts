/**
 * JSON Canvas (https://jsoncanvas.org/spec/1.0) mapped onto Automerge.
 *
 * The spec models a canvas as two ARRAYS (nodes, edges). Arrays merge badly
 * under concurrent edits, so the CRDT representation keys both by id:
 * concurrent moves/edits of different nodes merge per-property, and two
 * people dragging the same node converge on one winner instead of a
 * duplicated entry. A `z` counter per node preserves the spec's implicit
 * stacking order (export sorts by it).
 *
 * `canvasToSpec` / `reconcileCanvas` translate at the boundary: the REST API
 * speaks pure spec JSON (agents never see the CRDT shape), and reconcile
 * upserts per node so an agent PUT merges with in-flight human drags.
 */

export type CanvasColor = string; // "1".."6" preset or "#rrggbb"
export type NodeSide = "top" | "right" | "bottom" | "left";
export type EdgeEnd = "none" | "arrow";

interface NodeBase {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color?: CanvasColor;
  /** stacking order (not part of the spec wire format — export sorts by it) */
  z: number;
}

export type CanvasNode = NodeBase &
  (
    | { type: "text"; text: string }
    | { type: "file"; file: string; subpath?: string }
    | { type: "link"; url: string }
    | { type: "group"; label?: string; background?: string; backgroundStyle?: "cover" | "ratio" | "repeat" }
  );

export interface CanvasEdge {
  id: string;
  fromNode: string;
  fromSide?: NodeSide;
  fromEnd?: EdgeEnd;
  toNode: string;
  toSide?: NodeSide;
  toEnd?: EdgeEnd;
  color?: CanvasColor;
  label?: string;
}

export interface CanvasData {
  nodes: Record<string, CanvasNode>;
  edges: Record<string, CanvasEdge>;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type SpecNode = DistributiveOmit<CanvasNode, "z">;

/** Spec wire format (what agents read and PUT). */
export interface SpecCanvas {
  nodes: SpecNode[];
  edges: CanvasEdge[];
}

export function emptyCanvas(): CanvasData {
  return { nodes: {}, edges: {} };
}

export function newCanvasId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}

export function nextZ(canvas: CanvasData): number {
  let max = 0;
  for (const node of Object.values(canvas.nodes)) max = Math.max(max, node.z ?? 0);
  return max + 1;
}

/** Export the CRDT shape as spec JSON: arrays, stacking order, no `z`. */
export function canvasToSpec(canvas: CanvasData | undefined): SpecCanvas {
  if (!canvas) return { nodes: [], edges: [] };
  const nodes = Object.values(canvas.nodes)
    .sort((a, b) => (a.z ?? 0) - (b.z ?? 0) || a.id.localeCompare(b.id))
    .map(({ z: _z, ...node }) => prune(node));
  const edges = Object.values(canvas.edges)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(edge => prune(edge));
  return { nodes: nodes as SpecCanvas["nodes"], edges: edges as CanvasEdge[] };
}

function prune<T extends object>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out as T;
}

const SIDES: readonly string[] = ["top", "right", "bottom", "left"];
const ENDS: readonly string[] = ["none", "arrow"];

export class CanvasValidationError extends Error {}

function bad(msg: string): never {
  throw new CanvasValidationError(msg);
}

function str(v: unknown, what: string): string {
  if (typeof v !== "string" || v.length === 0) bad(`${what} must be a non-empty string`);
  return v;
}

function int(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) bad(`${what} must be a number`);
  return Math.round(v);
}

function color(v: unknown, what: string): CanvasColor | undefined {
  if (v === undefined || v === null) return undefined;
  const s = str(v, what);
  if (!/^[1-6]$/.test(s) && !/^#[0-9a-fA-F]{6}$/.test(s)) bad(`${what} must be "1"–"6" or "#rrggbb"`);
  return s;
}

/** Validate spec JSON (agent input) into clean node/edge objects. */
export function parseSpecCanvas(input: unknown): SpecCanvas {
  if (typeof input !== "object" || input === null) bad("canvas must be an object with nodes/edges arrays");
  const raw = input as { nodes?: unknown; edges?: unknown };
  const rawNodes = raw.nodes === undefined ? [] : raw.nodes;
  const rawEdges = raw.edges === undefined ? [] : raw.edges;
  if (!Array.isArray(rawNodes)) bad("nodes must be an array");
  if (!Array.isArray(rawEdges)) bad("edges must be an array");

  const nodes: SpecCanvas["nodes"] = [];
  const seen = new Set<string>();
  for (const n of rawNodes as Record<string, unknown>[]) {
    const id = str(n.id, "node.id");
    if (seen.has(id)) bad(`duplicate node id ${id}`);
    seen.add(id);
    const base = {
      id,
      x: int(n.x, `node ${id}: x`),
      y: int(n.y, `node ${id}: y`),
      width: int(n.width, `node ${id}: width`),
      height: int(n.height, `node ${id}: height`),
      ...(color(n.color, `node ${id}: color`) !== undefined ? { color: color(n.color, "color") } : {}),
    };
    switch (n.type) {
      case "text":
        nodes.push({ ...base, type: "text", text: typeof n.text === "string" ? n.text : "" });
        break;
      case "file":
        nodes.push({
          ...base,
          type: "file",
          file: str(n.file, `node ${id}: file`),
          ...(typeof n.subpath === "string" && n.subpath.startsWith("#") ? { subpath: n.subpath } : {}),
        });
        break;
      case "link":
        nodes.push({ ...base, type: "link", url: str(n.url, `node ${id}: url`) });
        break;
      case "group":
        nodes.push({
          ...base,
          type: "group",
          ...(typeof n.label === "string" ? { label: n.label } : {}),
          ...(typeof n.background === "string" ? { background: n.background } : {}),
          ...(n.backgroundStyle === "cover" || n.backgroundStyle === "ratio" || n.backgroundStyle === "repeat"
            ? { backgroundStyle: n.backgroundStyle }
            : {}),
        });
        break;
      default:
        bad(`node ${id}: type must be text | file | link | group`);
    }
  }

  const edges: CanvasEdge[] = [];
  const seenEdges = new Set<string>();
  for (const e of rawEdges as Record<string, unknown>[]) {
    const id = str(e.id, "edge.id");
    if (seenEdges.has(id)) bad(`duplicate edge id ${id}`);
    seenEdges.add(id);
    const fromNode = str(e.fromNode, `edge ${id}: fromNode`);
    const toNode = str(e.toNode, `edge ${id}: toNode`);
    if (!seen.has(fromNode)) bad(`edge ${id}: fromNode ${fromNode} is not a node id`);
    if (!seen.has(toNode)) bad(`edge ${id}: toNode ${toNode} is not a node id`);
    edges.push(
      prune({
        id,
        fromNode,
        toNode,
        fromSide: SIDES.includes(e.fromSide as string) ? (e.fromSide as NodeSide) : undefined,
        toSide: SIDES.includes(e.toSide as string) ? (e.toSide as NodeSide) : undefined,
        fromEnd: ENDS.includes(e.fromEnd as string) ? (e.fromEnd as EdgeEnd) : undefined,
        toEnd: ENDS.includes(e.toEnd as string) ? (e.toEnd as EdgeEnd) : undefined,
        color: color(e.color, `edge ${id}: color`),
        label: typeof e.label === "string" && e.label.length > 0 ? e.label : undefined,
      })
    );
  }

  return { nodes, edges };
}

/**
 * Merge spec JSON into the live CRDT shape (call inside handle.change):
 * upsert per node/edge and per property, delete what the spec no longer
 * contains. Untouched nodes keep their objects — and their concurrent edits.
 */
export function reconcileCanvas(canvas: CanvasData, spec: SpecCanvas): void {
  let z = nextZ(canvas);
  const specNodeIds = new Set(spec.nodes.map(n => n.id));
  for (const id of Object.keys(canvas.nodes)) {
    if (!specNodeIds.has(id)) delete canvas.nodes[id];
  }
  for (const node of spec.nodes) {
    const existing = canvas.nodes[node.id];
    if (!existing) {
      canvas.nodes[node.id] = { ...node, z: z++ } as CanvasNode;
    } else {
      assignDiff(existing as unknown as Record<string, unknown>, node as unknown as Record<string, unknown>, ["z"]);
    }
  }

  const specEdgeIds = new Set(spec.edges.map(e => e.id));
  for (const id of Object.keys(canvas.edges)) {
    if (!specEdgeIds.has(id)) delete canvas.edges[id];
  }
  for (const edge of spec.edges) {
    const existing = canvas.edges[edge.id];
    if (!existing) canvas.edges[edge.id] = { ...edge };
    else assignDiff(existing as unknown as Record<string, unknown>, edge as unknown as Record<string, unknown>, []);
  }
}

/** Assign only changed properties; remove properties the source dropped. */
function assignDiff(target: Record<string, unknown>, source: Record<string, unknown>, keep: string[]): void {
  for (const [k, v] of Object.entries(source)) {
    if (target[k] !== v) target[k] = v;
  }
  for (const k of Object.keys(target)) {
    if (!(k in source) && !keep.includes(k)) delete target[k];
  }
}

/** The six preset canvas colors (spec section "Color"), tuned to the app. */
export const CANVAS_PRESETS: Record<string, { fg: string; bg: string }> = {
  "1": { fg: "#c92a2a", bg: "#ffe3e3" }, // red
  "2": { fg: "#d9480f", bg: "#ffe8cc" }, // orange
  "3": { fg: "#e67700", bg: "#fff3bf" }, // yellow
  "4": { fg: "#2b8a3e", bg: "#d3f9d8" }, // green
  "5": { fg: "#0b7285", bg: "#c5f6fa" }, // cyan
  "6": { fg: "#862e9c", bg: "#eebefa" }, // purple
};
