import { useEffect, useState } from "react";
import { MD_COLORS, type FormatAction, type MdColor } from "../editor/formatKeys";
import type { SelectionInfo } from "../editor/Editor";

interface ToolbarProps {
  selection: SelectionInfo;
  onFormat(action: FormatAction): void;
  onColor(color: MdColor | null, background: boolean): void;
  onComment(): void;
}

const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
const mod = isMac ? "⌘" : "Ctrl+";

const BUTTONS: { action: FormatAction; label: React.ReactNode; title: string }[] = [
  { action: "bold", label: <strong>B</strong>, title: `Bold (${mod}B)` },
  { action: "italic", label: <em style={{ fontFamily: "serif" }}>i</em>, title: `Italic (${mod}I)` },
  { action: "strike", label: <s>S</s>, title: `Strikethrough (${mod}⇧X)` },
  { action: "code", label: <code style={{ fontSize: "11px" }}>{"<>"}</code>, title: `Code (${mod}E)` },
  {
    action: "link",
    label: (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
      </svg>
    ),
    title: `Link (${mod}K)`,
  },
];

function PaletteRow(p: { background: boolean; onPick(color: MdColor | null, background: boolean): void }) {
  return (
    <div className="sel-palette-row">
      <button
        className="sel-swatch sel-swatch--default"
        title="Default"
        onMouseDown={e => {
          e.preventDefault();
          p.onPick(null, p.background);
        }}
      >
        A
      </button>
      {MD_COLORS.map(c => (
        <button
          key={c}
          className={"sel-swatch" + (p.background ? " sel-swatch--bg" : "")}
          data-c={c}
          title={c}
          onMouseDown={e => {
            e.preventDefault();
            p.onPick(c, p.background);
          }}
        >
          A
        </button>
      ))}
    </div>
  );
}

/** Floating toolbar above the current selection: formatting + color + comment. */
export function SelectionToolbar(p: ToolbarProps) {
  const { x, y, active } = p.selection;
  const [palette, setPalette] = useState(false);
  // moving to a different selection closes the palette
  useEffect(() => setPalette(false), [p.selection.from, p.selection.to]);
  const pick = (c: MdColor | null, bg: boolean) => {
    setPalette(false);
    p.onColor(c, bg);
  };
  return (
    <div
      className="sel-toolbar"
      style={{ left: `clamp(140px, ${Math.round(x)}px, calc(100% - 60px))`, top: y }}
      // preserve the editor selection for every button press
      onMouseDown={e => e.preventDefault()}
    >
      {BUTTONS.map(b => (
        <button
          key={b.action}
          className={"sel-btn" + (active.has(b.action) ? " sel-btn--on" : "")}
          title={b.title}
          onMouseDown={e => {
            e.preventDefault();
            p.onFormat(b.action);
          }}
        >
          {b.label}
        </button>
      ))}
      <button
        className={"sel-btn sel-btn--color" + (palette ? " sel-btn--on" : "")}
        title="Text & background color"
        onMouseDown={e => {
          e.preventDefault();
          setPalette(s => !s);
        }}
      >
        A
      </button>
      {palette && (
        <div className="sel-palette" onMouseDown={e => e.preventDefault()}>
          <div className="sel-palette-label">Text</div>
          <PaletteRow background={false} onPick={pick} />
          <div className="sel-palette-label">Background</div>
          <PaletteRow background={true} onPick={pick} />
        </div>
      )}
      <span className="sel-divider" />
      <button
        className="sel-btn sel-btn--comment"
        title="Comment on selection"
        onMouseDown={e => {
          e.preventDefault();
          p.onComment();
        }}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
        <span>Comment</span>
      </button>
    </div>
  );
}
