import type { Junction, LaidRoad } from "./network";
import { roadLanes, type Turn } from "./lanes";

export { armOf, laneTurns, turnsAt, type Turn } from "./lanes";

/**
 * Lane markings from the lane graph (`lanes.ts`), American style, so the paint shows the lanes
 * traffic will use. A main street is one wide lane each way along the block, a double yellow
 * between. Approaching a real junction with room for it, the lane splits in two equal lanes:
 *
 *  - a white lane line between them from where they split to the stop line, broken at first and
 *    solid for the last stretch;
 *  - a turn arrow centred in each for the ways it may go, from the junction's actual arms (the
 *    inner lane the left turn, the outer one the rest);
 *  - a stop bar across the approach, behind any zebra.
 *
 * Any other street gets a stop bar where it meets a busier road (a stop sign or a signal), and
 * nothing at all where it has priority, at a bend or at a dead end. Three-free and pure:
 * `roads-geometry.ts` paints it.
 */

/** Clear of the stop bar ahead of an arrow's tip, metres. */
const ARROW_GAP = 2;
/**
 * An arrow's length, tail to tip: drawn 3 m long and stretched along the road, as real ones are,
 * since a driver sees it nearly edge on.
 */
const ARROW_DRAWN = 3;
const ARROW_STRETCH = 1.4;
export const ARROW_LENGTH = ARROW_DRAWN * ARROW_STRETCH;
/** The solid end of a lane line, before the stop bar: at most this, and at most this share of it. */
const SOLID = 12;
const SOLID_SHARE = 0.5;
/** A second pair of arrows this much further back along the lanes, where they are long enough for it. */
const SECOND_ARROWS = 14;

/** One painted arrow: its tail along the road, the offset of its middle, and which way it points. */
export interface LaneArrow {
  /** Metres along the road of its tail. */
  s: number;
  /** Offset of its centre line from the road's (positive: right of the road's own direction). */
  offset: number;
  /** The direction of travel along the road: +1 toward its end, -1 toward its start. */
  sign: 1 | -1;
  turns: Turn[];
}

/** The marks on one approach to a junction. */
export interface ApproachMarks {
  /** Which end of the road. */
  end: 0 | 1;
  sign: 1 | -1;
  /** The ways on from the junction. */
  turns: Turn[];
  /** The stop bar, along the road from `s0` to `s1`, across from `o0` to `o1` (signed offsets); `dashed`: a give-way line. */
  stop: { s0: number; s1: number; o0: number; o1: number; dashed?: boolean } | null;
  arrows: LaneArrow[];
}

/** A white line between two lanes, along the road from `s0` to `s1` at an offset, broken or solid. */
export interface LaneLine {
  s0: number;
  s1: number;
  offset: number;
  dashed: boolean;
}

/** Every lane mark along one road: its approaches' stop bars and arrows, and its lane lines. */
export interface RoadMarks {
  approaches: ApproachMarks[];
  lines: LaneLine[];
}

/** Whether a road gets lane marks at all: anything paved but a lane (an alley). */
export function marksLanes(road: { kind: string; class?: string }): boolean {
  return road.kind !== "dirt" && !(road.kind === "street" && road.class === "lane");
}

/**
 * A road's lane marks from its lanes and the junctions at its ends (`junctionAt`, by node id).
 * Distances are along its full centre line, as its samples'.
 */
export function roadMarks(laid: LaidRoad, junctionAt: (id: number) => Junction | undefined): RoadMarks {
  const out: RoadMarks = { approaches: [], lines: [] };
  if (!marksLanes(laid.road)) return out;
  const { lanes, approaches } = roadLanes(laid, junctionAt);
  // The lanes' band each way: the stop bar runs across it (not over a hard shoulder, nor the median).
  const inner = laid.section.inner;
  const half = laid.section.band - inner;
  for (const a of approaches) {
    if (!a.stop) continue;
    const { sign } = a;
    const marks: ApproachMarks = {
      end: a.end,
      sign,
      turns: a.turns,
      stop: { ...a.stop, o0: sign * (inner + 0.3), o1: sign * (inner + half - 0.3), ...(a.control === "yield" ? { dashed: true } : {}) },
      arrows: [],
    };
    out.approaches.push(marks);
    if (a.split === null && a.arrows !== null) {
      // Turn arrows on the lanes as they are, and solid lines between them over that stretch.
      const bar = sign === 1 ? a.stop.s0 : a.stop.s1;
      const length = Math.abs(bar - a.arrows);
      if (length < ARROW_GAP + ARROW_LENGTH + 1) continue;
      const tail = bar - sign * (ARROW_GAP + ARROW_LENGTH);
      const pairs = length >= ARROW_GAP + SECOND_ARROWS + ARROW_LENGTH + 3 ? [tail, tail - sign * SECOND_ARROWS] : [tail];
      for (const s of pairs)
        for (const id of a.lanes) {
          const lane = lanes[id]!;
          if (lane.turns.length) marks.arrows.push({ s, offset: lane.offset, sign, turns: lane.turns });
        }
      const width = a.lanes.length ? half / a.lanes.length : half;
      for (let i = 1; i < a.lanes.length; i++) out.lines.push({ s0: Math.min(a.arrows, bar), s1: Math.max(a.arrows, bar), offset: sign * (inner + i * width), dashed: false });
      continue;
    }
    if (a.split === null) continue;
    // The stop bar's back edge: the lanes' marks run up to it.
    const bar = sign === 1 ? a.stop.s0 : a.stop.s1;
    const length = Math.abs(bar - a.split);
    const tail = bar - sign * (ARROW_GAP + ARROW_LENGTH);
    const pairs = length >= ARROW_GAP + SECOND_ARROWS + ARROW_LENGTH + 3 ? [tail, tail - sign * SECOND_ARROWS] : [tail];
    for (const s of pairs)
      for (const id of a.lanes) {
        const lane = lanes[id]!;
        marks.arrows.push({ s, offset: lane.offset, sign, turns: lane.turns });
      }
    // The line between them: broken from the split, solid for the last stretch.
    const solid = Math.min(SOLID, length * SOLID_SHARE);
    const mid = bar - sign * solid;
    const offset = sign * (inner + half / 2);
    out.lines.push({ s0: Math.min(a.split, mid), s1: Math.max(a.split, mid), offset, dashed: true });
    out.lines.push({ s0: Math.min(mid, bar), s1: Math.max(mid, bar), offset, dashed: false });
  }
  return out;
}

/* Arrows. */

/** Half the width of an arrow's stem, and its straight head's length and half width. */
const STEM = 0.13;
const HEAD = 1;
const HEAD_HALF = 0.45;
/** A turn's bend radius (to its stem's middle), and its head's length and half width. */
const BEND = 0.55;
const TURN_HEAD = 0.85;
const TURN_HEAD_HALF = 0.42;
/** Where a turn leaves the stem of an arrow that also points straight on, and of one that does not. */
const BRANCH_WITH_STRAIGHT = 0.75;
const BRANCH_ALONE = 1.55;

/**
 * An arrow for some ways on, as convex pieces (they overlap where they join): points are
 * [forward, right] in metres, its tail at forward 0 and no part past `ARROW_LENGTH`, centred
 * across. A straight arrow, a turn (a stem bending into a head pointing square to the side), or a
 * straight one with a turn branching off its stem.
 */
export function arrowShape(turns: readonly Turn[]): [number, number][][] {
  const pieces: [number, number][][] = [];
  const straight = turns.includes("straight");
  const sides = turns.filter((t) => t !== "straight").map((t) => (t === "right" ? 1 : -1));
  const branch = straight ? BRANCH_WITH_STRAIGHT : BRANCH_ALONE;
  const stem = straight ? ARROW_DRAWN - HEAD : branch;
  pieces.push([
    [0, -STEM],
    [stem, -STEM],
    [stem, STEM],
    [0, STEM],
  ]);
  if (straight)
    pieces.push([
      [stem, -HEAD_HALF],
      [ARROW_DRAWN, 0],
      [stem, HEAD_HALF],
    ]);
  for (const d of sides) {
    // The bend: a quarter circle from the stem round to square across.
    const steps = 6;
    const at = (k: number, w: number): [number, number] => {
      const a = (k / steps) * (Math.PI / 2);
      const r = BEND + w;
      return [branch + r * Math.sin(a), d * (BEND - r * Math.cos(a))];
    };
    // From the stem's end (or partway up it), its full width there, so the two join with no crack.
    for (let k = 0; k < steps; k++) pieces.push([at(k, -STEM), at(k + 1, -STEM), at(k + 1, STEM), at(k, STEM)]);
    const f = branch + BEND;
    pieces.push([
      [f - TURN_HEAD_HALF, d * BEND],
      [f, d * (BEND + TURN_HEAD)],
      [f + TURN_HEAD_HALF, d * BEND],
    ]);
  }
  // A turn stands to one side of its stem: shifted so the whole arrow sits in the lane's middle.
  const across = pieces.flat().map((p) => p[1]);
  const shift = -(Math.min(...across) + Math.max(...across)) / 2;
  return pieces.map((piece) => piece.map(([f, r]) => [f * ARROW_STRETCH, r + shift] as [number, number]));
}
