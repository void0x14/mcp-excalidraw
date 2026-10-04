/**
 * Terminal rendering backend for Excalidraw elements.
 *
 * Terminal TUIs (grok CLI, opencode) do not render MCP Apps widgets, so the
 * SVG returned by create_view is invisible there. This module converts the
 * same element array into text the TUI can actually print:
 *
 *   ascii   — pure Unicode box-drawing grid. No ANSI. Renders in any TUI,
 *             labels stay perfectly legible. Default.
 *   symbols — chafa half-block/braille art with 256 colors (ANSI truecolor).
 *             Prettier, but the host must pass ANSI through.
 *   kitty   — chafa kitty graphics protocol. Real raster image. Requires a
 *             kitty-graphics terminal (Ghostty) AND host escape passthrough.
 *
 * No URL is produced anywhere in this path.
 */
import { spawnSync } from "node:child_process";

export type TerminalFormat = "ascii" | "symbols" | "kitty";

const DRAWABLE = new Set([
  "rectangle",
  "ellipse",
  "diamond",
  "text",
  "arrow",
  "line",
]);

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const XML_ESC: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};

function esc(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) => XML_ESC[c]);
}

function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function chars(s: string): string[] {
  return Array.from(s);
}

function drawable(elements: unknown[]): any[] {
  return (elements as any[]).filter(
    (el) => el && typeof el === "object" && DRAWABLE.has(el.type),
  );
}

interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Scene-space bounding box of every drawable element. */
function bounds(els: any[]): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const hit = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };

  for (const el of els) {
    const x = num(el.x);
    const y = num(el.y);

    if (el.type === "arrow" || el.type === "line") {
      const pts: any[] = Array.isArray(el.points) ? el.points : [[0, 0]];
      for (const p of pts) hit(x + num(p?.[0]), y + num(p?.[1]));
      continue;
    }

    if (el.type === "text") {
      const fs = num(el.fontSize, 20);
      const t = Array.isArray(el.text) ? el.text.join("\n") : String(el.text ?? "");
      const lines = t.split("\n");
      const w = Math.max(...lines.map((l: string) => chars(l).length), 1) * fs * 0.5;
      hit(x, y);
      hit(x + w, y + lines.length * fs * 1.25);
      continue;
    }

    hit(x, y);
    hit(x + num(el.width), y + num(el.height));
  }

  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  return { minX, minY, maxX, maxY };
}

function labelOf(el: any): { text: string; fontSize: number } | null {
  const l = el?.label;
  if (!l) return null;
  const text = typeof l === "string" ? l : String(l.text ?? "");
  if (!text) return null;
  return { text, fontSize: num(l.fontSize, num(el.fontSize, 20)) };
}

function strokeOf(el: any, fallback = "#1e1e1e"): string {
  const c = el?.strokeColor;
  return typeof c === "string" && c && c !== "transparent" ? c : fallback;
}

function fillOf(el: any): string | null {
  const c = el?.backgroundColor;
  return typeof c === "string" && c && c !== "transparent" ? c : null;
}

/* ------------------------------------------------------------------ */
/* backend 1 — ascii grid                                              */
/* ------------------------------------------------------------------ */

class Grid {
  readonly w: number;
  readonly h: number;
  private rows: string[][];
  private locked: boolean[][];

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.rows = Array.from({ length: h }, () => Array.from({ length: w }, () => " "));
    this.locked = Array.from({ length: h }, () => Array.from({ length: w }, () => false));
  }

  set(x: number, y: number, ch: string): void {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= this.w || yi >= this.h) return;
    this.rows[yi][xi] = ch;
  }

  /** Draws only if the cell was not claimed by a shape outline. */
  soft(x: number, y: number, ch: string): void {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= this.w || yi >= this.h) return;
    if (this.locked[yi][xi]) return;
    this.rows[yi][xi] = ch;
  }

  /** Marks the cell as part of a shape outline so arrows cannot clobber it. */
  lock(x: number, y: number): void {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= this.w || yi >= this.h) return;
    this.locked[yi][xi] = true;
  }

  put(x: number, y: number, text: string): void {
    const cs = chars(text);
    for (let i = 0; i < cs.length; i++) this.set(x + i, y, cs[i]);
  }

  hline(y: number, x0: number, x1: number, ch = "─", soft = false): void {
    if (x1 < x0) [x0, x1] = [x1, x0];
    for (let x = x0; x <= x1; x++) (soft ? this.soft : this.set).call(this, x, y, ch);
  }

  vline(x: number, y0: number, y1: number, ch = "│", soft = false): void {
    if (y1 < y0) [y0, y1] = [y1, y0];
    for (let y = y0; y <= y1; y++) (soft ? this.soft : this.set).call(this, x, y, ch);
  }

  line(x0: number, y0: number, x1: number, y1: number, ch = "·", soft = false): void {
    let x = Math.round(x0);
    let y = Math.round(y0);
    const ex = Math.round(x1);
    const ey = Math.round(y1);
    const dx = Math.abs(ex - x);
    const dy = Math.abs(ey - y);
    const sx = x < ex ? 1 : -1;
    const sy = y < ey ? 1 : -1;
    let err = dx - dy;
    for (let guard = 0; guard < 10000; guard++) {
      (soft ? this.soft : this.set).call(this, x, y, ch);
      if (x === ex && y === ey) return;
      const e2 = 2 * err;
      if (e2 > -dy) {
        err -= dy;
        x += sx;
      }
      if (e2 < dx) {
        err += dx;
        y += sy;
      }
    }
  }

  toString(): string {
    const lines = this.rows.map((r) => r.join("").replace(/\s+$/, ""));
    // drop leading and trailing blank rows so the block sits flush in chat
    while (lines.length && lines[0] === "") lines.shift();
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    return lines.join("\n");
  }
}

/**
 * Renders elements as a Unicode box-drawing grid. Text labels are written as
 * real characters, so they stay crisp in any terminal or TUI.
 */
export function elementsToAscii(
  elements: unknown[],
  cols = 100,
  rows = 32,
): string {
  const els = drawable(elements);
  if (els.length === 0) return "(empty diagram)";

  const b = bounds(els);
  const spanX = Math.max(b.maxX - b.minX, 1);
  const spanY = Math.max(b.maxY - b.minY, 1);

  const pad = 1;

  // Size the drawing from its CONTENT, not from the terminal width: a box
  // should be just wide enough for its label. Stretching boxes to fill the
  // terminal produces huge empty frames with tiny text.
  const boxEls = els.filter(
    (el: any) =>
      el.type === "rectangle" || el.type === "ellipse" || el.type === "diamond",
  );
  const maxLabelCells = Math.max(
    0,
    ...els.map((el: any) => chars(labelOf(el)?.text ?? "").length),
  );
  const widestBox = Math.max(
    1,
    ...boxEls.map((el: any) => num(el.width)),
  );
  // inner text width + 4 cells of breathing room, +2 for the border
  const targetBoxCells = Math.max(maxLabelCells + 6, 10);
  let sx = targetBoxCells / widestBox;
  // never exceed the terminal
  const fitX = (cols - pad * 2) / spanX;
  if (sx > fitX) sx = fitX;

  // Height comes from its own target, not from sx: a box should be three
  // rows (top border, label, bottom border) whatever its pixel height is.
  const tallestBox = Math.max(1, ...boxEls.map((el: any) => num(el.height)));
  const TARGET_BOX_ROWS = 3;
  // a box occupies TARGET_BOX_ROWS rows, i.e. TARGET-1 cell gaps between borders
  let sy = (TARGET_BOX_ROWS - 1) / tallestBox;
  const maxRows = rows - pad * 2;
  if (spanY * sy > maxRows) {
    const k = maxRows / (spanY * sy);
    sx *= k;
    sy *= k;
  }

  const gx = (x: number) => Math.round((x - b.minX) * sx) + pad;
  const gy = (y: number) => Math.round((y - b.minY) * sy) + pad;

  const g = new Grid(cols, rows);

  const labels: Array<{ text: string; x: number; y: number }> = [];
  const arrows: any[] = [];

  for (const el of els) {
    const x = num(el.x);
    const y = num(el.y);

    if (el.type === "rectangle" || el.type === "ellipse" || el.type === "diamond") {
      const x0 = gx(x);
      const y0 = gy(y);
      const x1 = gx(x + num(el.width));
      const y1 = gy(y + num(el.height));
      if (x1 - x0 < 2 || y1 - y0 < 2) continue;

      if (el.type === "diamond") {
        const cx = Math.round((x0 + x1) / 2);
        const cy = Math.round((y0 + y1) / 2);
        g.line(x0, cy, cx, y0, "╱");
        g.line(cx, y0, x1, cy, "╲");
        g.line(x1, cy, cx, y1, "╱");
        g.line(cx, y1, x0, cy, "╲");
      } else {
        const round = el.type === "ellipse" || el.roundness;
        g.hline(y0, x0 + 1, x1 - 1);
        g.hline(y1, x0 + 1, x1 - 1);
        g.vline(x0, y0 + 1, y1 - 1);
        g.vline(x1, y0 + 1, y1 - 1);
        g.set(x0, y0, round ? "╭" : "┌");
        g.set(x1, y0, round ? "╮" : "┐");
        g.set(x0, y1, round ? "╰" : "└");
        g.set(x1, y1, round ? "╯" : "┘");
        // claim the outline so connectors stop at the border
        for (let yy = y0; yy <= y1; yy++) { g.lock(x0, yy); g.lock(x1, yy); }
        for (let xx = x0; xx <= x1; xx++) { g.lock(xx, y0); g.lock(xx, y1); }
      }

      const lab = labelOf(el);
      if (lab) {
        const text = lab.text.split("\n")[0];
        labels.push({
          text,
          x: x0 + Math.max(1, Math.floor((x1 - x0 + 1 - chars(text).length) / 2)),
          y: Math.round((y0 + y1) / 2),
        });
      }
      continue;
    }

    if (el.type === "text") {
      const t = Array.isArray(el.text) ? el.text.join("\n") : String(el.text ?? "");
      const lines = t.split("\n");
      for (let i = 0; i < lines.length; i++) {
        labels.push({ text: lines[i], x: gx(x), y: gy(y) + i });
      }
      continue;
    }

    arrows.push(el);
  }

  for (const el of arrows) {
    const x = num(el.x);
    const y = num(el.y);
    const pts: any[] = Array.isArray(el.points) ? el.points : [];
    if (pts.length < 2) continue;
    const first = pts[0];
    const last = pts[pts.length - 1];
    const ax = gx(x + num(first?.[0]));
    const ay = gy(y + num(first?.[1]));
    const bx = gx(x + num(last?.[0]));
    const by = gy(y + num(last?.[1]));

    const head =
      el.type === "arrow" && el.endArrowhead !== null && el.endArrowhead !== undefined;

    const dx = bx - ax;
    const dy = by - ay;
    const sx = dx >= 0 ? 1 : -1;
    const sy = dy >= 0 ? 1 : -1;

    // stop one cell short of the target border so the arrowhead sits outside it
    const ex = Math.abs(dx) > Math.abs(dy) ? bx - sx : bx;
    const ey = Math.abs(dx) > Math.abs(dy) ? by : by - sy;

    if (Math.abs(dy) <= Math.abs(dx)) {
      g.hline(ay, ax, ex, "─", true);
      if (head) g.soft(ex, ay, dx >= 0 ? "▶" : "◀");
    } else if (Math.abs(dx) === 0) {
      g.vline(ax, ay, ey, "│", true);
      if (head) g.soft(ax, ey, dy >= 0 ? "▼" : "▲");
    } else {
      g.line(ax, ay, ex, ey, "·", true);
      if (head) g.soft(ex, ey, dx >= 0 ? "▶" : "◀");
    }
  }

  // labels last so connectors never overwrite them
  for (const l of labels) g.put(l.x, l.y, l.text);

  return g.toString();
}

/* ------------------------------------------------------------------ */
/* backend 2 — SVG (feeds chafa)                                       */
/* ------------------------------------------------------------------ */

/** Minimal Excalidraw-element to SVG serializer. No DOM required. */
export function elementsToSvg(elements: unknown[], pad = 20): string {
  const els = drawable(elements);
  if (els.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>`;
  }

  const b = bounds(els);
  const minX = b.minX - pad;
  const minY = b.minY - pad;
  const w = Math.max(b.maxX - b.minX + pad * 2, 10);
  const h = Math.max(b.maxY - b.minY + pad * 2, 10);

  const out: string[] = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${minX} ${minY} ${w} ${h}">`,
  );
  out.push(`<rect x="${minX}" y="${minY}" width="${w}" height="${h}" fill="#ffffff"/>`);

  for (const el of els) {
    const x = num(el.x);
    const y = num(el.y);
    const sw = num(el.strokeWidth, 2) || 2;
    const stroke = strokeOf(el);
    const fill = fillOf(el) ?? "none";
    const op = num(el.opacity, 100) / 100;
    const opAttr = op < 1 ? ` opacity="${op.toFixed(2)}"` : "";
    const common = `fill="${fill}" stroke="${stroke}" stroke-width="${sw}"${opAttr}`;

    if (el.type === "rectangle") {
      const rx = el.roundness ? Math.min(16, num(el.width) / 4) : 0;
      out.push(
        `<rect x="${x}" y="${y}" width="${num(el.width)}" height="${num(el.height)}" rx="${rx}" ${common}/>`,
      );
    } else if (el.type === "ellipse") {
      const rx = num(el.width) / 2;
      const ry = num(el.height) / 2;
      out.push(
        `<ellipse cx="${x + rx}" cy="${y + ry}" rx="${rx}" ry="${ry}" ${common}/>`,
      );
    } else if (el.type === "diamond") {
      const hw = num(el.width) / 2;
      const hh = num(el.height) / 2;
      out.push(
        `<polygon points="${x + hw},${y} ${x + num(el.width)},${y + hh} ${x + hw},${y + num(el.height)} ${x},${y + hh}" ${common}/>`,
      );
    } else if (el.type === "arrow" || el.type === "line") {
      const pts: any[] = Array.isArray(el.points) ? el.points : [];
      if (pts.length < 2) continue;
      const d = pts
        .map((p, i) => `${i === 0 ? "M" : "L"}${x + num(p?.[0])} ${y + num(p?.[1])}`)
        .join(" ");
      out.push(
        `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${sw}"${opAttr}/>`,
      );
      if (el.type === "arrow" && el.endArrowhead) {
        const last = pts[pts.length - 1];
        const prev = pts[pts.length - 2];
        const lx = x + num(last?.[0]);
        const ly = y + num(last?.[1]);
        const px = x + num(prev?.[0]);
        const py = y + num(prev?.[1]);
        const ang = Math.atan2(ly - py, lx - px);
        const s = 12;
        const a1x = lx - s * Math.cos(ang - 0.4);
        const a1y = ly - s * Math.sin(ang - 0.4);
        const a2x = lx - s * Math.cos(ang + 0.4);
        const a2y = ly - s * Math.sin(ang + 0.4);
        out.push(
          `<polygon points="${lx},${ly} ${a1x},${a1y} ${a2x},${a2y}" fill="${stroke}"/>`,
        );
      }
    }

    const lab = labelOf(el);
    if (lab) {
      const fs = lab.fontSize;
      const cx = x + num(el.width) / 2;
      const cy = y + num(el.height) / 2;
      const lines = lab.text.split("\n");
      const startY = cy - ((lines.length - 1) * fs * 1.2) / 2;
      for (let i = 0; i < lines.length; i++) {
        out.push(
          `<text x="${cx}" y="${startY + i * fs * 1.2}" font-family="DejaVu Sans, sans-serif" font-size="${fs}" fill="${stroke}" text-anchor="middle" dominant-baseline="middle">${esc(lines[i])}</text>`,
        );
      }
    }

    if (el.type === "text") {
      const fs = num(el.fontSize, 20);
      const t = Array.isArray(el.text) ? el.text.join("\n") : String(el.text ?? "");
      const lines = t.split("\n");
      for (let i = 0; i < lines.length; i++) {
        out.push(
          `<text x="${x}" y="${y + fs * (i + 0.8)}" font-family="DejaVu Sans, sans-serif" font-size="${fs}" fill="${stroke}">${esc(lines[i])}</text>`,
        );
      }
    }
  }

  out.push("</svg>");
  return out.join("\n");
}

/* ------------------------------------------------------------------ */
/* backend 3 — chafa                                                   */
/* ------------------------------------------------------------------ */

function chafaAvailable(): boolean {
  const r = spawnSync("chafa", ["--version"], { encoding: "utf-8" });
  return !r.error && r.status === 0;
}

function renderWithChafa(
  svg: string,
  cols: number,
  rows: number,
  format: Exclude<TerminalFormat, "ascii">,
): string {
  if (!chafaAvailable()) {
    throw new Error("chafa is not installed (pacman -S chafa)");
  }
  const args =
    format === "kitty"
      ? ["--format", "kitty", "--size", `${cols}x${rows}`, "-"]
      : [
          "--format",
          "symbols",
          "--symbols",
          "block+border+space",
          "--colors",
          "256",
          "--size",
          `${cols}x${rows}`,
          "-",
        ];

  const r = spawnSync("chafa", args, {
    input: svg,
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`chafa exited ${r.status}: ${(r.stderr ?? "").trim()}`);
  }
  return r.stdout ?? "";
}

/* ------------------------------------------------------------------ */
/* public entry                                                        */
/* ------------------------------------------------------------------ */

export interface RenderOptions {
  cols?: number;
  rows?: number;
  format?: TerminalFormat;
}

/** Converts elements into terminal-printable text. Never returns a URL. */
export function renderTerminal(
  elements: unknown[],
  opts: RenderOptions = {},
): { text: string; format: TerminalFormat } {
  const cols = Math.min(Math.max(Math.round(opts.cols ?? 100), 20), 240);
  const rows = Math.min(Math.max(Math.round(opts.rows ?? 32), 8), 80);
  const format: TerminalFormat = opts.format ?? "ascii";

  if (format === "ascii") {
    return { text: elementsToAscii(elements, cols, rows), format };
  }
  const svg = elementsToSvg(elements);
  return { text: renderWithChafa(svg, cols, rows, format), format };
}
