// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Which node labels the knowledge graph actually draws (issue #1104).
 *
 * The graph used to decide this with one boolean: label `self` and `team`
 * always, label *everything* the moment a pillar was focused. That rule failed
 * at both ends — at rest every agent was an anonymous circle, and in focus a
 * whole tree's worth of names turned on at once and smeared into each other.
 *
 * The replacement is two pure steps, both here:
 *
 * 1. the component nominates **candidates** with a priority (the roster at
 *    rest, the focused node and its direct children in focus, plus whatever is
 *    hovered or selected);
 * 2. {@link planLabels} runs a greedy declutter over them — highest priority
 *    placed first, and any later label whose box overlaps one already placed is
 *    dropped. Every node keeps a `<title>`, so a dropped label still has a
 *    native tooltip underneath it.
 *
 * ## Why the collision pass measures in SCREEN space
 *
 * Labels are deliberately a constant on-screen size at every camera depth: the
 * camera publishes its zoom as `--kg-cam-k` and each font counter-scales
 * through it. So zooming changes how far apart nodes are, never how wide a
 * label is. Comparing boxes in graph units would therefore get the answer
 * backwards at every depth but one — the same two labels overlap or not
 * depending purely on the camera. {@link planLabels} projects each node through
 * the camera first and measures in pixels.
 *
 * Only the camera's *scale* matters: a pan shifts every box by the same vector
 * and cannot change which pairs overlap, so the caller only has to re-run this
 * when the zoom changes.
 */

/** The live camera rect — the SVG's `viewBox`, in graph units. */
export type LabelCamera = { x: number; y: number; w: number };

export type LabelCandidate = {
  id: string;
  /** the text as rendered (already shortened, if the caller shortens it) */
  text: string;
  /** the node's centre, in graph units */
  x: number;
  y: number;
  /** centre → label baseline, in graph units (radius + row stagger) */
  dy: number;
  /** the label's on-screen font size in px — constant at every camera depth */
  fontPx: number;
  /** higher wins a collision; ties break on the order given */
  priority: number;
};

/**
 * Label priorities, highest first. The bands are far enough apart that a
 * caller can add a small tie-breaker (degree, say) without crossing a band.
 */
export const LABEL_PRIORITY = {
  /** the node under the pointer — the one name the reader just asked for */
  hovered: 1000,
  /** whatever the detail panel is currently showing */
  selected: 900,
  /** the company at the core */
  self: 800,
  /** the node a focused tree is built around */
  focused: 700,
  /** a department: the trunk in focus, the whole ring at rest */
  team: 600,
  /** the focused node's direct children */
  child: 500,
  /** the roster — agents and people — named at rest */
  worker: 400,
} as const;

/**
 * Monospace advance width as a fraction of the font size. The labels are set in
 * `var(--font-mono)` (Geist Mono), whose advance is 0.6em; every glyph is that
 * wide, so a character count is an exact width rather than an estimate.
 */
const MONO_ADVANCE = 0.6;

/**
 * Horizontal breathing room around a label box, in px, so two survivors on the
 * same row never quite touch. There is no vertical counterpart on purpose: the
 * rows a label can sit on are already staggered by a fixed amount, and padding
 * the box past its own line height turns that stagger into a collision and
 * throws away a label that reads perfectly well.
 */
const LABEL_GAP_X = 3;

export type LabelBox = { x0: number; y0: number; x1: number; y1: number };

/**
 * A candidate's label box in screen px, padded by {@link LABEL_GAP_X}.
 * `scale` is px per graph unit (canvas width ÷ camera width).
 */
export function labelBoxPx(c: LabelCandidate, cam: LabelCamera, scale: number): LabelBox {
  const cx = (c.x - cam.x) * scale;
  // `dy` rides the graph, so it scales with the camera; the font does not.
  const baseline = (c.y - cam.y) * scale + c.dy * scale;
  const halfW = (c.text.length * MONO_ADVANCE * c.fontPx) / 2 + LABEL_GAP_X;
  return {
    x0: cx - halfW,
    x1: cx + halfW,
    // a baseline sits ~0.8em below the cap line and ~0.2em above the descender
    y0: baseline - c.fontPx * 0.8,
    y1: baseline + c.fontPx * 0.2,
  };
}

const overlaps = (a: LabelBox, b: LabelBox): boolean =>
  a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

/**
 * The ids whose labels survive the declutter, measured in screen px.
 *
 * `canvasW` is the width the camera rect maps onto — the nominal SVG width, so
 * the px here are the same px `fontPx` is quoted in. Candidates are placed
 * highest priority first; a label that collides with one already placed is
 * dropped rather than nudged, because nudging is what the old two-row stagger
 * did and it only moved the pile-up.
 */
export function planLabels(
  candidates: readonly LabelCandidate[],
  cam: LabelCamera,
  canvasW: number,
): Set<string> {
  const scale = cam.w > 0 ? canvasW / cam.w : 1;
  const order = candidates.map((c, i) => ({ c, i }));
  order.sort((a, b) => b.c.priority - a.c.priority || a.i - b.i);
  const placed: LabelBox[] = [];
  const kept = new Set<string>();
  for (const { c } of order) {
    const box = labelBoxPx(c, cam, scale);
    if (placed.some((p) => overlaps(p, box))) continue;
    placed.push(box);
    kept.add(c.id);
  }
  return kept;
}

/**
 * The focused node and its direct children in a focused tree — the only nodes
 * guaranteed a label there. `branches` is the tree's edge list; a child is any
 * branch whose source is the focused node.
 *
 * Focus follows what was clicked: a pillar names its tasks, an agent names its
 * tools. Everything else in the tree is one hover (or one native tooltip) away.
 */
export function focusLabelIds(
  branches: readonly { source: string; target: string }[],
  focusId: string | null,
): Set<string> {
  const set = new Set<string>();
  if (!focusId) return set;
  set.add(focusId);
  for (const b of branches) if (b.source === focusId) set.add(b.target);
  return set;
}
