/** Pure geometry for canvas edges — shared by the interactive editor and
 * the read-only thumbnails embedded in markdown pages. */
import type { CanvasNode, NodeSide } from "../../shared/canvas";

export function anchorPoint(node: CanvasNode, side: NodeSide): { x: number; y: number } {
  switch (side) {
    case "top":
      return { x: node.x + node.width / 2, y: node.y };
    case "bottom":
      return { x: node.x + node.width / 2, y: node.y + node.height };
    case "left":
      return { x: node.x, y: node.y + node.height / 2 };
    case "right":
      return { x: node.x + node.width, y: node.y + node.height / 2 };
  }
}

export function nearestSide(node: CanvasNode, at: { x: number; y: number }): NodeSide {
  const sides: NodeSide[] = ["top", "right", "bottom", "left"];
  let best: NodeSide = "left";
  let bestDist = Infinity;
  for (const side of sides) {
    const pt = anchorPoint(node, side);
    const d = (pt.x - at.x) ** 2 + (pt.y - at.y) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = side;
    }
  }
  return best;
}

export function defaultSides(from: CanvasNode, to: CanvasNode): { fromSide: NodeSide; toSide: NodeSide } {
  const dx = to.x + to.width / 2 - (from.x + from.width / 2);
  const dy = to.y + to.height / 2 - (from.y + from.height / 2);
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? { fromSide: "right", toSide: "left" } : { fromSide: "left", toSide: "right" };
  return dy > 0 ? { fromSide: "bottom", toSide: "top" } : { fromSide: "top", toSide: "bottom" };
}

export function edgePath(a: { x: number; y: number }, aSide: NodeSide, b: { x: number; y: number }, bSide: NodeSide): string {
  const dist = Math.max(50, Math.hypot(b.x - a.x, b.y - a.y) / 2.2);
  const out = (side: NodeSide, pt: { x: number; y: number }) => {
    switch (side) {
      case "top": return { x: pt.x, y: pt.y - dist };
      case "bottom": return { x: pt.x, y: pt.y + dist };
      case "left": return { x: pt.x - dist, y: pt.y };
      case "right": return { x: pt.x + dist, y: pt.y };
    }
  };
  const c1 = out(aSide, a);
  const c2 = out(bSide, b);
  return `M ${a.x} ${a.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${b.x} ${b.y}`;
}
