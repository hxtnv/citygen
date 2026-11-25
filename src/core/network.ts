import { heightAt, type TerrainData } from "./data";
import { BAY_RAMP, BAY_WIDTH, BAY_LENGTH, barrierKindOf, liftOf, sectionOf, useMapSections, walkSides, type BarrierKind, type BarrierMode, type ResolvedSection } from "./road-sections";
import {
  ROAD_STEP,
  roadWidth,
  roadVerge,
  vergeOf,
  type Verge,
  centreLine,
  roadLine,
  closedRing,
  shoulderOf,
  acrossRoad,
  markFolds,
  sampleRoad,
  type RoadKind,
  type RoadSample,
  type RoadsideSetting,
  type StreetClass,
  type TerrainRoad,
} from "./roads";

/**
 * The road network: roads joined at nodes, and the shapes that join them.
 *
 * A road (`TerrainRoad`) runs from one node to another (`from`, `to`); its first and last control
 * points sit on them. Where two or more roads meet, the node is a JUNCTION: each road is cut back
 * ("trimmed") far enough that it does not overlap its neighbours, and the hole is filled with one
 * flat polygon of plain asphalt whose outline curves from each road's edge round to the next
 * one's - a kerb fillet - so a T or a crossroads looks laid, not two ribbons crossing. A road with
 * a sidewalk carries it along both sides and round those curves.
 *
 * Three-free and pure: `roads-geometry.ts` draws {@link layoutNetwork}'s output.
 */

/** A point roads meet at. */
export interface RoadNode {
  id: number;
  x: number;
  z: number;
  /** Surface height here: every road into it is held at it, and the junction is flat at it. */
  y: number;
  /**
   * A dead end's turnaround (a cul-de-sac's bulb): the radius of its kerb round the node, metres.
   * Only a node with one road in uses it; see {@link bulbCurve}.
   */
  bulb?: number;
  /**
   * Its kerb corners' radius, metres, in place of its roads' profiles' (`RoadSection.corner`).
   */
  corner?: number;
  /**
   * What its traffic answers to, in place of the usual (`auto`: who gives way by the roads' ranks,
   * signals at busy main streets): `stop` an all-way stop, `yield` the lesser roads give way (a
   * dashed line, no stop), `signals` traffic lights on every approach, `none` no control at all.
   */
  control?: JunctionControl;
  /**
   * A joint between two segments of one road (`TerrainRoad.segment`): no junction. With its two
   * roads as wide as each other it is seamless (everything runs on through it); a road that
   * widens or narrows there tapers from one to the other over `taper` metres.
   */
  joint?: true;
  /** A joint's taper, metres: the length over which the asphalt goes from one width to the other. */
  taper?: number;
}

/** A joint's taper unless it says: four metres of length per metre the edge moves out or in, 6 m at least. */
export function jointTaper(node: Pick<RoadNode, "taper">, a: number, b: number): number {
  return node.taper ?? Math.min(60, Math.max(6, Math.abs(a - b) * 8));
}

/** See {@link RoadNode.control}. */
export type JunctionControl = "auto" | "stop" | "yield" | "signals" | "none";

/** Sidewalk width either side of a road that has one, metres (a classed street's is its class's). */
export const SIDEWALK = 3;
/** How high a sidewalk stands over the road. */
export const KERB = 0.14;
/** Two arms closer to straight on than this (radians off opposite) join without a corner curve. */
const STRAIGHT_ON = 0.35;

/**
 * A road's sidewalks side by side (left of travel, then right): their depths (0: none), walk
 * kinds and parking bays. Both as its profile has them (or {@link SIDEWALK} deep where it has none
 * of its own and the road is told to have them: `sidewalk`), unless a side says otherwise.
 */
export function roadWalkSides(road: TerrainRoad): ReturnType<typeof walkSides> {
  const section = sectionOf(road);
  const both = (road.sidewalk ?? section.walk > 0) ? (section.walk > 0 ? section.walk : SIDEWALK) : 0;
  const sides = walkSides(road, both, section);
  // A segment narrower than its road: its sidewalks wider by as much, so their back edge (the
  // blocks' edge) runs on straight past it, unless a side has a depth of its own there.
  if (road.segment) {
    const { segment: _own, ...rest } = road;
    const extra = sectionOf(rest).half - section.half;
    if (extra > 0.01) for (const k of [0, 1] as const) if (sides.walk[k] > 0 && road.segment[k === 0 ? "walkLeft" : "walkRight"] === undefined) sides.walk[k] += extra;
  }
  return sides;
}

/** The radius of a road's kerb corners at a junction. */
function cornerOf(road: TerrainRoad): number {
  return sectionOf(road).corner;
}

/** One road's end at a junction. */
export interface Arm {
  road: number;
  /** 0: the road's start is here; 1: its end. */
  end: 0 | 1;
  /** Unit direction from the node out along the road. */
  dx: number;
  dz: number;
  half: number;
  walk: number;
  /** Its gravel fringe either side (0 with sidewalks), and how far it stands over the grass. */
  fringe: number;
  lift: number;
  kind: RoadKind;
  /** Its street class, if a classed street: its lanes and paint. */
  class?: StreetClass;
  /** Its road's cross-section (profile and overrides). */
  section: ResolvedSection;
  /** Its road's sidewalks by side of the road's travel (left, right): depth and walk kind (`walk` is the wider). */
  walks: [number, number];
  kinds: [string, string];
  /** Radius of its kerb corners. */
  corner: number;
  angle: number;
  /** Metres from the node to where the road's own ribbon starts. */
  trim: number;
}

/** A curve of a junction's outline between two arms, and the sidewalk round it, if any. */
export interface Corner {
  points: [number, number][];
  /** Sidewalk width at the curve's start, and at its end (it tapers between). */
  walk: number;
  walkEnd: number;
  /** Stretches of its curve (by distance along it) where its kerb is dropped for a crossing. */
  ramps?: [number, number][];
}

/**
 * A zebra across an arm of a junction, in line with the sidewalks round its corners: from `c0` to
 * `c1` metres out from the node along the arm.
 */
export interface JunctionCrossing {
  road: number;
  end: 0 | 1;
  c0: number;
  c1: number;
}

export interface Junction {
  node: RoadNode;
  arms: Arm[];
  /** The asphalt: a closed outline round the node, counter-clockwise in X-Z. Empty for a dead end. */
  outline: [number, number][];
  corners: Corner[];
  /** Every arm a dirt track: drawn in dirt. */
  dirt: boolean;
  /** Zebras across its arms (a walked junction of three or more), see {@link JunctionCrossing}. */
  crossings?: JunctionCrossing[];
  /**
   * The seam of a closed loop: the node one road runs round from and back into, with nothing else
   * there. No junction at all: the road runs on through it (its ends meet edge to edge, its lines
   * carried through), no apron, no trims. Its two arms are kept for traffic and blocks to follow.
   */
  seam?: boolean;
  /** A joint between two segments of one road (`RoadNode.joint`): a seam, or a taper between their widths. */
  joint?: "seam" | "taper";
}

/**
 * One side of a laid road's sidewalk: how deep, what of (null: procedural), its top over the road,
 * and the stretch with parking bays, where the kerb steps back {@link BAY_WIDTH} into it: full from
 * `s0` to `s1` along the road, stepping out from `lo` and back in by `hi` (no step at an end that
 * runs on into another segment's bays).
 */
export interface WalkSide {
  walk: number;
  top: number;
  bay: { lo: number; s0: number; s1: number; hi: number } | null;
}

/** How far a side's kerb is stepped back for its parking bays `s` along the road (0 where it has none). */
export function kerbStep(side: Pick<WalkSide, "bay">, s: number): number {
  const b = side.bay;
  if (!b || s < b.lo - 1e-6 || s > b.hi + 1e-6) return 0;
  if (s < b.s0) return (BAY_WIDTH * (s - b.lo)) / Math.max(1e-6, b.s0 - b.lo);
  if (s > b.s1) return (BAY_WIDTH * (b.hi - s)) / Math.max(1e-6, b.hi - b.s1);
  return BAY_WIDTH;
}

/** Where a side's kerb step changes (for drawing it with points there). */
export function bayBreaks(side: Pick<WalkSide, "bay">): number[] {
  const b = side.bay;
  return b ? [b.lo, b.s0, b.s1, b.hi] : [];
}

/** One road, laid: its full centre line with heights, and how much of each end the junctions take. */
export interface LaidRoad {
  road: TerrainRoad;
  index: number;
  samples: RoadSample[];
  trimStart: number;
  trimEnd: number;
  half: number;
  walk: number;
  /** Its soft shoulder's width either side (see `shoulderOf`); 0 with sidewalks. */
  shoulder: number;
  /** Its cross-section: its profile with the road's own overrides. */
  section: ResolvedSection;
  /**
   * Its sidewalks' height over the road at their back (what a lot or a driveway beside them meets):
   * {@link KERB} for the procedural ones, a walk kind's own (its section's back) for pieces.
   */
  walkTop: number;
  /**
   * A closed loop run on through its own node (a seam, see {@link Junction.seam}): its ends meet
   * edge to edge, so nothing along it stops or tapers at them.
   */
  closed?: boolean;
  /** A raised verge (lifted over the grass on a bank), or null where it lies flush. */
  verge: Verge | null;
  /**
   * Whether each end of each of its sidewalks carries on round a junction's corner: start then end,
   * each [left, right] (the side to the left of its direction of travel first). One that does not
   * ends in a dropped kerb, a ramp down to the road, not a block.
   */
  walkOn: [[boolean, boolean], [boolean, boolean]];
  /** Its sidewalks side by side (left of travel, then right); `walk` and `walkKind` are the wider's, or the left's. */
  sides: [WalkSide, WalkSide];
  /**
   * Whether it runs on at its start and end into the next segment of its road through a seamless
   * joint (`Junction.joint`): its paint, median and walks carry on there with no end.
   */
  runsOn: [boolean, boolean];
  /**
   * Driveways across its sidewalks (a site's entrances): the side (1 the left of travel) and the
   * stretch, metres along it. The kerb is dropped there and the sidewalk slopes up from it.
   */
  drives?: { side: 1 | -1; s0: number; s1: number; core?: [number, number] }[];
}

export interface NetworkLayout {
  roads: LaidRoad[];
  junctions: Junction[];
  /** The terrain it was laid out on. */
  terrain?: TerrainData;
}

/** The node with this id. */
export function nodeById(terrain: TerrainData, id: number | undefined): RoadNode | undefined {
  return id === undefined ? undefined : terrain.nodes?.find((n) => n.id === id);
}

/** The next free node id. */
function nextNodeId(terrain: TerrainData): number {
  return (terrain.nodes ?? []).reduce((m, n) => Math.max(m, n.id), 0) + 1;
}

/**
 * The height a new node takes: the ground averaged over a few metres (so one bump does not set a
 * junction's height), never under the sea.
 */
export function groundForNode(terrain: TerrainData, x: number, z: number): number {
  let sum = 0;
  let n = 0;
  for (const [ox, oz] of [
    [0, 0],
    [6, 0],
    [-6, 0],
    [0, 6],
    [0, -6],
    [4, 4],
    [-4, 4],
    [4, -4],
    [-4, -4],
  ] as const) {
    sum += heightAt(terrain, x + ox, z + oz);
    n++;
  }
  const floor = terrain.seaLevel === undefined ? -Infinity : terrain.seaLevel + 1.2;
  return Math.max(floor, sum / n);
}

/** A node at a point: the one already there (within `merge` metres), else a new one. */
export function nodeAt(terrain: TerrainData, x: number, z: number, merge = 1, y?: number): RoadNode {
  const near = (terrain.nodes ?? []).find((n) => Math.hypot(n.x - x, n.z - z) <= merge);
  if (near) return near;
  const node: RoadNode = { id: nextNodeId(terrain), x, z, y: y ?? groundForNode(terrain, x, z) };
  terrain.nodes = [...(terrain.nodes ?? []), node];
  return node;
}

/**
 * Gives every road outside a town nodes at its ends, sharing a node where two ends meet. A map
 * made before roads had nodes is linked this way on load; the editor links each road it lays.
 */
export function linkRoads(terrain: TerrainData): void {
  for (const road of terrain.roads ?? []) {
    if (road.town !== undefined || road.points.length < 2) continue;
    if (nodeById(terrain, road.from) === undefined) {
      const [x, z] = road.points[0]!;
      road.from = nodeAt(terrain, x, z, 1, road.pinStart).id;
    }
    if (nodeById(terrain, road.to) === undefined) {
      const [x, z] = road.points[road.points.length - 1]!;
      road.to = nodeAt(terrain, x, z, 1, road.pinEnd).id;
    }
    // The end points sit on their nodes.
    const a = nodeById(terrain, road.from)!;
    const b = nodeById(terrain, road.to)!;
    road.points[0] = [a.x, a.z];
    road.points[road.points.length - 1] = [b.x, b.z];
  }
}

/** The roads with an end at a node. */
export function roadsAt(terrain: TerrainData, id: number): { index: number; end: 0 | 1 }[] {
  const out: { index: number; end: 0 | 1 }[] = [];
  (terrain.roads ?? []).forEach((road, index) => {
    if (road.from === id) out.push({ index, end: 0 });
    if (road.to === id) out.push({ index, end: 1 });
  });
  return out;
}

/** Unit direction out of a road's end, from its centre line a few metres in. */
function armDirection(line: ReturnType<typeof centreLine>, end: 0 | 1): [number, number] {
  const length = line[line.length - 1]!.s;
  // Far enough out to see the way the road really comes in: a road that curves into a junction,
  // judged a few metres out, pointed somewhere its asphalt then was not.
  const reach = Math.min(16, length / 3);
  const at = end === 0 ? reach : length - reach;
  const p = pointAt(line, at);
  const o = end === 0 ? line[0]! : line[line.length - 1]!;
  const dx = p.x - o.x;
  const dz = p.z - o.z;
  const len = Math.hypot(dx, dz) || 1;
  return [dx / len, dz / len];
}

/** A point `s` metres along a sampled line, interpolated. */
export function pointAt<T extends { x: number; z: number; s: number }>(line: readonly T[], s: number): { x: number; z: number } {
  if (s <= 0) return line[0]!;
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i]!;
    const b = line[i + 1]!;
    if (b.s >= s) {
      const t = (s - a.s) / Math.max(1e-6, b.s - a.s);
      return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t };
    }
  }
  return line[line.length - 1]!;
}

/**
 * Lays the network out: each junction's arms, trims, outline and kerb corners, and each road's
 * centre line, held at its nodes' heights over the part the junction takes.
 */
export function layoutNetwork(terrain: TerrainData): NetworkLayout {
  // The map's own road profiles over the shipped ones (a no-op when they are in use already).
  useMapSections(terrain);
  const roads = terrain.roads ?? [];
  const lines = roads.map((road) => roadLine(road));
  const trims = roads.map(() => [0, 0] as [number, number]);
  // Every sidewalk end carries on unless a junction says it stops (filled in below).
  const walkOn = roads.map(
    () =>
      [
        [true, true],
        [true, true],
      ] as [[boolean, boolean], [boolean, boolean]],
  );
  /** An arm's edge on `side` (as `edge` below) is its road's sidewalk on this side of travel. */
  const walkSide = (arm: Arm, side: 1 | -1): 0 | 1 => ((arm.end === 0 ? side : -side) === 1 ? 0 : 1);
  const junctions: Junction[] = [];
  /** Each junction's corners by the arm they are left of (see `junctionCrossings`). */
  const corners = new Map<Junction, Map<Arm, Corner>>();
  /** Closed loops run on through their own node (see `Junction.seam`). */
  const seams = new Set<number>();
  /** Each road's ends that run on into another segment through a seamless joint, and the end they meet. */
  const runsOn = roads.map(() => [null, null] as [{ road: number; end: 0 | 1 } | null, { road: number; end: 0 | 1 } | null]);
  /** Each road's sidewalks side by side, worked out once. */
  const walkSidesOf = roads.map((road) => roadWalkSides(road));
  /** An arm's sidewalk on one side of its way out of the node (1 its left), and the walk kind there. */
  const armWalk = (arm: Arm, side: 1 | -1): number => arm.walks[walkSide(arm, side)];
  const armKind = (arm: Arm, side: 1 | -1): string => arm.kinds[walkSide(arm, side)];

  for (const node of terrain.nodes ?? []) {
    const arms: Arm[] = [];
    for (const { index, end } of roadsAt(terrain, node.id)) {
      const line = lines[index]!;
      if (line.length < 2) continue;
      const road = roads[index]!;
      const [dx, dz] = armDirection(line, end);
      const section = sectionOf(road);
      const sides = walkSidesOf[index]!;
      const walk = Math.max(...sides.walk);
      const fringe = walk > 0 ? 0 : shoulderOf(road);
      arms.push({
        road: index,
        end,
        dx,
        dz,
        half: section.half,
        walk,
        walks: [...sides.walk],
        kinds: [...sides.kind],
        fringe,
        lift: liftOf(section, walk, fringe),
        section,
        kind: road.kind,
        class: road.kind === "street" ? road.class : undefined,
        corner: cornerOf(road),
        angle: Math.atan2(dz, dx),
        trim: 0,
      });
    }
    if (arms.length === 0) continue;
    // At a junction (or a dead end) a sidewalk stops, unless a corner below carries it round.
    for (const arm of arms) if (arm.walk > 0) walkOn[arm.road]![arm.end] = [false, false];
    arms.sort((a, b) => a.angle - b.angle);
    const junction: Junction = { node, arms, outline: [], corners: [], dirt: arms.every((a) => a.kind === "dirt") };
    junctions.push(junction);
    // A closed loop's own node, and nothing else there: a seam, not a junction (no trims, no apron).
    if (arms.length === 2 && arms[0]!.road === arms[1]!.road && closedRing(roads[arms[0]!.road]!.points)) {
      junction.seam = true;
      seams.add(arms[0]!.road);
      walkOn[arms[0]!.road] = [
        [true, true],
        [true, true],
      ];
      continue;
    }
    // A joint between two segments of a road, more or less straight on.
    let taper = false;
    if (node.joint && arms.length === 2 && arms[0]!.road !== arms[1]!.road && arms[0]!.dx * arms[1]!.dx + arms[0]!.dz * arms[1]!.dz < -0.9) {
      const [a, b] = arms as [Arm, Arm];
      const alike = Math.abs(a.half - b.half) < 0.01 && Math.abs(a.section.inner - b.section.inner) < 0.01 && a.section.median.kind === b.section.median.kind;
      // Each one's walk on a side carries on into the other's on the same side (a's left of its way
      // out is b's right of its own), where both have one there.
      for (const side of [1, -1] as const) {
        const on = armWalk(a, side) > 0 && armWalk(b, -side as 1 | -1) > 0;
        walkOn[a.road]![a.end]![walkSide(a, side)] = on && alike;
        walkOn[b.road]![b.end]![walkSide(b, -side as 1 | -1)] = on && alike;
      }
      if (alike) {
        // Seamless: no junction at all, the two run on into each other.
        junction.seam = true;
        junction.joint = "seam";
        runsOn[a.road]![a.end] = { road: b.road, end: b.end };
        runsOn[b.road]![b.end] = { road: a.road, end: a.end };
        continue;
      }
      // Wider on one side: the asphalt tapers from one to the other over the junction's length.
      junction.joint = "taper";
      taper = true;
      const length = jointTaper(node, a.half, b.half);
      for (const arm of [a, b]) arm.trim = Math.min(length / 2, lines[arm.road]![lines[arm.road]!.length - 1]!.s * 0.45);
    }
    if (arms.length === 1) {
      // A cul-de-sac: the street ends in a round bulb of asphalt, its sidewalks carried round it.
      const arm = arms[0]!;
      const line = lines[arm.road]!;
      const length = line[line.length - 1]!.s;
      const trim = node.bulb ? bulbTrim(node.bulb, arm.half) : Infinity;
      const p = trim <= length * 0.45 ? endOf(line, arm.end === 0 ? trim : length - trim) : null;
      // Out of the node along the street where its ribbon ends.
      const ox = p ? (arm.end === 0 ? p.dx : -p.dx) : 0;
      const oz = p ? (arm.end === 0 ? p.dz : -p.dz) : 0;
      // Fitted to where the street's ribbon really ends (it may bend a little before), so the two
      // meet square.
      const bulb = p ? bulbCurve(node, { x: p.x, z: p.z, dx: ox, dz: oz }, arm.half, node.bulb!) : null;
      if (p && bulb) {
        arm.trim = trim;
        trims[arm.road]![arm.end] = trim;
        // Exactly the street ribbon's end corners, so the two meet edge to edge.
        const left: [number, number] = [p.x - oz * arm.half, p.z + ox * arm.half];
        const right: [number, number] = [p.x + oz * arm.half, p.z - ox * arm.half];
        junction.outline.push(right, left, ...bulb);
        // Round from its left side's walk to its right's (both, or neither).
        const wl = armWalk(arm, 1);
        const wr = armWalk(arm, -1);
        if (wl > 0 && wr > 0) {
          junction.corners.push({ points: [left, ...bulb, right], walk: wl, walkEnd: wr });
          walkOn[arm.road]![arm.end] = [true, true];
        }
      }
      continue;
    }

    // Each neighbouring pair, counter-clockwise: where arm i's left edge meets arm j's right edge.
    const pairs = arms.map((a, i) => {
      const b = arms[(i + 1) % arms.length]!;
      let gap = b.angle - a.angle;
      if (gap <= 0) gap += Math.PI * 2;
      // A joint's taper: straight edges from one road's ends to the other's.
      const hit = gap < Math.PI - 0.02 && !taper ? meet(node, a, b) : null;
      // The outside of a bend (an L's outer corner): where the two edges meet behind the node.
      const outer = gap > Math.PI + 0.3 && gap < Math.PI * 2 - 0.3 && !taper ? meet(node, a, b, true) : null;
      return { a, b, gap, hit, outer };
    });
    const radiusOf = (a: Arm, b: Arm): number => node.corner ?? (a.corner + b.corner) / 2;
    for (const { a, b, gap, hit } of pairs) {
      if (!hit || taper) continue;
      // Straight on (a bend in one road): only far enough back to close the wedge.
      const radius = Math.PI - gap < STRAIGHT_ON ? 0.5 : radiusOf(a, b);
      a.trim = Math.max(a.trim, hit.t + radius);
      b.trim = Math.max(b.trim, hit.u + radius);
      // And far enough that neither's asphalt runs onto the other's sidewalk: the same meeting,
      // of the two roads' outer edges, sidewalks and all.
      if (a.walk > 0 || b.walk > 0) {
        const wide = meet(node, { ...a, half: a.half + a.walk }, { ...b, half: b.half + b.walk });
        if (wide) {
          a.trim = Math.max(a.trim, wide.t + 1);
          b.trim = Math.max(b.trim, wide.u + 1);
        }
      }
    }
    for (const arm of arms) {
      const length = lines[arm.road]![lines[arm.road]!.length - 1]!.s;
      // Never more than most of the road (two junctions share a short one), and at least far
      // enough that a road into a wider one does not poke through it.
      const widest = Math.max(...arms.filter((o) => o !== arm).map((o) => o.half + o.walk));
      // Capped: two roads meeting at a shallow angle would otherwise pave a long wedge between them.
      if (!taper) arm.trim = Math.min(Math.max(arm.trim, widest * 0.6), length * 0.45, 22);
      trims[arm.road]![arm.end] = arm.trim;
    }

    // The corner on each arm's left (the next arm's right), for its crossings.
    const cornerOfArm = new Map<Arm, Corner>();
    corners.set(junction, cornerOfArm);
    // The outline: each arm's right then left corner, and the curve on to the next arm.
    // A corner of the asphalt: exactly where the road's own ribbon ends (`trimmedSamples`), so the
    // two meet edge to edge with no sliver between them, even where the road curves in.
    const edge = (arm: Arm, side: 1 | -1): [number, number] => {
      const line = lines[arm.road]!;
      const length = line[line.length - 1]!.s;
      const p = endOf(line, arm.end === 0 ? arm.trim : length - arm.trim);
      // Out of the node along the road.
      const ox = arm.end === 0 ? p.dx : -p.dx;
      const oz = arm.end === 0 ? p.dz : -p.dz;
      return [p.x - oz * arm.half * side, p.z + ox * arm.half * side];
    };
    for (const pair of pairs) {
      const { a, b, hit } = pair;
      const from = edge(a, 1);
      const to = edge(b, -1);
      if (junction.outline.length === 0) junction.outline.push(edge(a, -1));
      junction.outline.push(from);
      const curve: [number, number][] = [from];
      if (pair.outer) curve.push([pair.outer.x, pair.outer.z]);
      else if (hit && Math.hypot(hit.x - from[0], hit.z - from[1]) > 0.05) {
        const steps = 8;
        for (let k = 1; k < steps; k++) {
          const t = k / steps;
          const u = 1 - t;
          curve.push([u * u * from[0] + 2 * u * t * hit.x + t * t * to[0], u * u * from[1] + 2 * u * t * hit.z + t * t * to[1]]);
        }
      }
      curve.push(to);
      for (const p of curve.slice(1, -1)) junction.outline.push(p);
      if (b !== arms[0]) junction.outline.push(to);
      // The sidewalk round the corner, where both roads have one. Where only one does it ends at
      // the junction's edge (tapering it round onto a road without one made thin spikes across
      // the asphalt at a slanted join).
      const wa = armWalk(a, 1);
      const wb = armWalk(b, -1);
      if (wa > 0 && wb > 0) {
        junction.corners.push({ points: curve, walk: wa, walkEnd: wb });
        cornerOfArm.set(a, junction.corners[junction.corners.length - 1]!);
        walkOn[a.road]![a.end]![walkSide(a, 1)] = true;
        walkOn[b.road]![b.end]![walkSide(b, -1)] = true;
      }
    }
  }

  for (const junction of junctions) junctionCrossings(junction, roads, corners.get(junction));

  const laid: LaidRoad[] = roads.map((road, index) => {
    const [trimStart, trimEnd] = trims[index]!;
    const from = nodeById(terrain, road.from);
    const to = nodeById(terrain, road.to);
    const [onStart, onEnd] = runsOn[index]!;
    const samples = markFolds(
      sampleRoad(terrain, road, {
        pinStart: from?.y ?? road.pinStart,
        pinEnd: to?.y ?? road.pinEnd,
        // Level over the whole junction (its asphalt is flat), and a little past.
        // At least a sample step past the edge: the sample straddling the edge must be level too, or
        // the road meets the flat junction a centimetre or two high (a crack seen side on).
        // A loop's seam is no junction, nor a seamless joint: held only at the point itself.
        holdStart: seams.has(index) || onStart ? 0 : trimStart + ROAD_STEP + 0.5,
        holdEnd: seams.has(index) || onEnd ? 0 : trimEnd + ROAD_STEP + 0.5,
        trimStart,
        trimEnd,
      }),
    );
    const ws = walkSidesOf[index]!;
    const walk = Math.max(...ws.walk);
    const section = sectionOf(road);
    const sides = ws.walk.map((w, k): WalkSide => {
      return { walk: w, top: KERB, bay: null };
    }) as [WalkSide, WalkSide];
    // The wider side's (the left's when alike), for what reads one walk off a road.
    const main = sides[1].walk > sides[0].walk ? sides[1] : sides[0];
    return {
      road,
      index,
      ...(seams.has(index) ? { closed: true } : {}),
      samples,
      trimStart,
      trimEnd,
      half: roadWidth(road) / 2,
      walk,
      shoulder: walk > 0 ? 0 : shoulderOf(road),
      section,
      walkTop: walk > 0 ? main.top : KERB,
      verge: walk > 0 ? null : roadVerge(road, terrain.spacing, walk),
      walkOn: walkOn[index]!,
      sides,
      runsOn: [!!onStart, !!onEnd],
    };
  });
  // A seamless joint's two ends point one way (the two halves' last legs differ a little on a curve).
  runsOn.forEach((ends, index) =>
    ends.forEach((other, end) => {
      if (!other || other.road < index) return;
      const a = laid[index]!.samples;
      const b = laid[other.road]!.samples;
      if (a.length < 2 || b.length < 2) return;
      const pa = end === 0 ? a[0]! : a[a.length - 1]!;
      const pb = other.end === 0 ? b[0]! : b[b.length - 1]!;
      // Each one's way along its own road: the same way when one ends where the other starts.
      const same = end !== other.end;
      let dx = pa.dx + (same ? pb.dx : -pb.dx);
      let dz = pa.dz + (same ? pb.dz : -pb.dz);
      const len = Math.hypot(dx, dz) || 1;
      dx /= len;
      dz /= len;
      pa.dx = dx;
      pa.dz = dz;
      pb.dx = same ? dx : -dx;
      pb.dz = same ? dz : -dz;
    }),
  );
  // Parking bays: along each side that has them, clear of its ends (a junction's corner and
  // zebras), running on into the next segment's bays through a seamless joint.
  laid.forEach((one, index) => {
    const ws = walkSidesOf[index]!;
    if (!ws.parking[0] && !ws.parking[1]) return;
    const length = one.samples[one.samples.length - 1]?.s ?? 0;
    for (const k of [0, 1] as const) {
      if (!ws.parking[k] || one.sides[k].walk <= 0) continue;
      // Whether the bays run on through the joint at an end: the road there has bays on the same side.
      const open = (end: 0 | 1): boolean => {
        const other = runsOn[index]![end];
        if (!other) return false;
        return walkSidesOf[other.road]!.parking[end !== other.end ? k : 1 - k]!;
      };
      const os = open(0);
      const oe = open(1);
      const lo = one.trimStart + (os ? 0 : BAY_CLEAR);
      const hi = length - one.trimEnd - (oe ? 0 : BAY_CLEAR);
      const s0 = lo + (os ? 0 : BAY_RAMP);
      const s1 = hi - (oe ? 0 : BAY_RAMP);
      if (s1 - s0 < (os || oe ? BAY_RAMP : BAY_LENGTH)) continue;
      one.sides[k].bay = { lo, s0, s1, hi };
    }
  });
  // A block lot's ways in (`TerrainBlock.entrance` and its `lot.ways`): the kerb dropped and the walk left out there.
  for (const block of terrain.blocks ?? []) {
    if (block.ground !== "lot") continue;
    for (const way of [...(block.entrance ? [block.entrance] : []), ...(block.lot?.ways ?? [])]) {
      const mouth = lotMouth(laid, way);
      if (!mouth) continue;
      (mouth.laid.drives ??= []).push({ side: mouth.side, s0: mouth.s - LOT_MOUTH / 2, s1: mouth.s + LOT_MOUTH / 2 });
    }
  }
  return { roads: laid, junctions, terrain };
}

/** Metres parking bays keep clear of a junction's edge (its corner's kerb, its zebra). */
const BAY_CLEAR = 3;

/** A block lot's way in: its width along the street, metres (`LOT_ENTRANCE` in blocks.ts). */
const LOT_MOUTH = 7;

/**
 * A block lot's way in: the walked street nearest its `entrance` point, the side of it the block
 * is on, and how far along it (clear of its ends), or null with none near.
 */
export function lotMouth(roads: readonly LaidRoad[], entrance: readonly [number, number]): { laid: LaidRoad; side: 1 | -1; s: number } | null {
  let best: { laid: LaidRoad; side: 1 | -1; s: number; d: number } | null = null;
  for (const laid of roads) {
    if (laid.walk <= 0 || laid.road.town !== undefined) continue;
    const samples = trimmedSamples(laid);
    if (samples.length < 2) continue;
    const s0 = samples[0]!.s;
    const s1 = samples[samples.length - 1]!.s;
    if (s1 - s0 < LOT_MOUTH + 4) continue;
    for (const p of samples) {
      const d = Math.hypot(p.x - entrance[0], p.z - entrance[1]);
      if (d > laid.half + laid.walk + 6 || (best && d >= best.d)) continue;
      const cross = p.dx * (entrance[1] - p.z) - p.dz * (entrance[0] - p.x);
      const side: 1 | -1 = cross > 0 ? 1 : -1;
      if (laid.sides?.[side === 1 ? 0 : 1]?.walk === 0) continue;
      const s = Math.min(s1 - LOT_MOUTH / 2 - 2, Math.max(s0 + LOT_MOUTH / 2 + 2, p.s + (entrance[0] - p.x) * p.dx + (entrance[1] - p.z) * p.dz));
      best = { laid, side, s, d };
    }
  }
  return best ? { laid: best.laid, side: best.side, s: best.s } : null;
}

/** How far out from the cross street's kerb line a junction's zebra starts and ends, for a walk of a kind (null: the procedural one). */
function crossingBand(walk: number): [number, number] {
  const from = Math.min(0.5, walk * 0.2);
  return [from, Math.max(from + 1.5, walk - 0.3)];
}

/**
 * A junction's zebras: across each arm with a walked corner either side (or the one it has), in
 * line with the cross street's sidewalk, where its road's end says so (`crossStart` / `crossEnd`)
 * or, unset, its profile does (`RoadSection.crossings`: three arms or more, a walked corner beside it). Each
 * corner's kerb is dropped where a zebra meets it.
 */
function junctionCrossings(junction: Junction, roads: readonly TerrainRoad[], cornerOfArm: Map<Arm, Corner> | undefined): void {
  const { node, arms } = junction;
  if (junction.seam || arms.length < 3 || !cornerOfArm) return;
  const n = arms.length;
  const crossings: JunctionCrossing[] = [];
  arms.forEach((arm, i) => {
    const road = roads[arm.road]!;
    const left = cornerOfArm.get(arm);
    const right = cornerOfArm.get(arms[(i - 1 + n) % n]!);
    const own = arm.end === 0 ? road.crossStart : road.crossEnd;
    const auto = arm.section.crossings && arm.section.use !== "legacy" && (!!left || !!right);
    if (!(own ?? auto) || (!left && !right) || arm.walk <= 0) return;
    const along = (p: readonly [number, number]): number => (p[0] - node.x) * arm.dx + (p[1] - node.z) * arm.dz;
    // The cross streets either side (not one carrying straight on: a T's far side).
    const neighbours = [left ? arms[(i + 1) % n]! : null, right ? arms[(i - 1 + n) % n]! : null].filter((o): o is Arm => !!o && Math.abs(o.dx * arm.dx + o.dz * arm.dz) < 0.9);
    if (neighbours.length === 0) return;
    const walk = Math.min(...neighbours.map((o) => o.walk));
    const [p0, p1] = crossingBand(walk);
    // In line with the cross streets' sidewalks: out from where their kerb lines cross this arm.
    const kerb = Math.max(0, ...neighbours.map((o) => cornerKerbLine(arm, o)));
    const c0 = kerb + p0;
    const c1 = Math.min(kerb + p1, Math.max(c0 + 1.5, arm.trim));
    crossings.push({ road: arm.road, end: arm.end, c0, c1 });
    // Each corner's kerb dropped where the zebra meets it.
    for (const corner of [left, right]) {
      if (!corner) continue;
      const pts = corner.points;
      let s = 0;
      const hits: number[] = [];
      for (let j = 0; j + 1 < pts.length; j++) {
        const p = pts[j]!;
        const q = pts[j + 1]!;
        const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
        const ap = along(p);
        const aq = along(q);
        for (const c of [c0, c1]) if ((ap - c) * (aq - c) <= 0 && Math.abs(aq - ap) > 1e-9) hits.push(s + (len * (c - ap)) / (aq - ap));
        s += len;
      }
      if (hits.length === 0) continue;
      const lo = Math.min(...hits);
      const hi = Math.max(...hits);
      // The zebra past the corner's end: dropped from the end it is at.
      const span: [number, number] = hits.length >= 2 ? [lo, hi] : corner === left ? [0, hi] : [lo, s];
      (corner.ramps ??= []).push(span);
    }
  });
  if (crossings.length) junction.crossings = crossings;
}

/** How far out along `arm` the kerb line of the street `other` crosses it (the nearer edge of its asphalt, on this arm's centre line). */
function cornerKerbLine(arm: Arm, other: Arm): number {
  const cos = Math.abs(arm.dx * other.dx + arm.dz * other.dz);
  const sin = Math.sqrt(Math.max(1e-6, 1 - cos * cos));
  return other.half / sin;
}

/** Metres over which a cul-de-sac bulb's kerb is filleted into its street's edges. */
export const BULB_FILLET = 5;
/** The smallest bulb radius laid, metres. */
export const MIN_BULB = 8;

/** How far from a cul-de-sac's node its street's ribbon ends: past where the bulb's fillet meets the street's edges. */
export function bulbTrim(radius: number, half: number): number {
  const r = Math.max(radius, half + 2);
  return Math.sqrt((r + BULB_FILLET) ** 2 - half ** 2) + 1;
}

/**
 * A cul-de-sac's turnaround: the kerb line round a dead end's bulb, a disc of `radius` round the
 * node joined smoothly (a {@link BULB_FILLET} fillet) to the street's two edges, from the street's
 * left edge (looking out of the node along it) counter-clockwise round the back to its right. The
 * street is the strip of its ribbon's end (`end`: the centre point there and the unit direction on
 * out of the node), so the bulb meets the ribbon square even where the street bends a little
 * before it; the curve's two ends are that end's corners, left off (they are the ribbon's). Null
 * under {@link MIN_BULB}. The shape is the smooth union of the disc and the strip, found along rays
 * from the node, so it is star-shaped from the node (drawn as a fan from it).
 */
export function bulbCurve(node: { x: number; z: number }, end: { x: number; z: number; dx: number; dz: number }, half: number, radius: number): [number, number][] | null {
  if (radius < MIN_BULB) return null;
  const r = Math.max(radius, half + 2);
  const k = BULB_FILLET;
  // The node's frame: a along the street out of it, b across (left positive).
  const lx = -end.dz;
  const lz = end.dx;
  const ea = (end.x - node.x) * end.dx + (end.z - node.z) * end.dz;
  const eb = (end.x - node.x) * lx + (end.z - node.z) * lz;
  if (ea <= r * 0.5) return null;
  const smin = (p: number, q: number): number => {
    const h = Math.max(k - Math.abs(p - q), 0) / k;
    return Math.min(p, q) - (h * h * k) / 4;
  };
  const sdf = (a: number, b: number): number => smin(Math.hypot(a, b) - r, Math.max(Math.abs(b - eb) - half, -a));
  const from = Math.atan2(eb + half, ea);
  const until = Math.atan2(eb - half, ea) + Math.PI * 2;
  const sweep = until - from;
  const steps = Math.max(24, Math.ceil((sweep * r) / 1.2));
  const points: [number, number][] = [];
  for (let i = 1; i < steps; i++) {
    const th = from + (sweep * i) / steps;
    const ca = Math.cos(th);
    const sb = Math.sin(th);
    let lo = 0;
    let hi = ea + r + half;
    for (let it = 0; it < 40; it++) {
      const mid = (lo + hi) / 2;
      if (sdf(ca * mid, sb * mid) < 0) lo = mid;
      else hi = mid;
    }
    points.push([node.x + end.dx * ca * lo + lx * sb * lo, node.z + end.dz * ca * lo + lz * sb * lo]);
  }
  return points;
}

/** Where arm a's left edge line meets arm b's right edge line: the point, and how far out along each. */
function meet(node: RoadNode, a: Arm, b: Arm, behind = false): { x: number; z: number; t: number; u: number } | null {
  // a's left edge: node + L_a * half_a + t * d_a, with L = (-dz, dx). b's right: R = (dz, -dx).
  const px = node.x - a.dz * a.half;
  const pz = node.z + a.dx * a.half;
  const qx = node.x + b.dz * b.half;
  const qz = node.z - b.dx * b.half;
  // px + t a.dx = qx + u b.dx ; pz + t a.dz = qz + u b.dz
  const det = a.dx * -b.dz - a.dz * -b.dx;
  if (Math.abs(det) < 1e-6) return null;
  const rx = qx - px;
  const rz = qz - pz;
  const t = (rx * -b.dz - rz * -b.dx) / det;
  const u = (a.dx * rz - a.dz * rx) / det;
  if (behind) {
    // Behind the node, and not far: past a few road widths the corner is better cut.
    if (Math.abs(t) > a.half * 3 || Math.abs(u) > b.half * 3) return null;
    return { x: px + a.dx * t, z: pz + a.dz * t, t, u };
  }
  if (t < -0.01 || u < -0.01) return null;
  return { x: px + a.dx * t, z: pz + a.dz * t, t: Math.max(0, t), u: Math.max(0, u) };
}

/** A point `s` along a centre line as a trimmed ribbon ends there: position, and the direction of the sample before. */
function endOf(line: ReturnType<typeof centreLine>, s: number): { x: number; z: number; dx: number; dz: number } {
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i]!;
    const b = line[i + 1]!;
    if (b.s >= s) {
      const t = (s - a.s) / Math.max(1e-6, b.s - a.s);
      return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, dx: a.dx, dz: a.dz };
    }
  }
  return line[line.length - 1]!;
}

/** The samples of a laid road between its trims, with exact end points. */
export function trimmedSamples(laid: LaidRoad): RoadSample[] {
  const { samples, trimStart, trimEnd } = laid;
  if (samples.length < 2) return [];
  const length = samples[samples.length - 1]!.s;
  const s0 = trimStart;
  const s1 = length - trimEnd;
  if (s1 - s0 < 0.2) return [];
  const at = (s: number): RoadSample => {
    for (let i = 0; i < samples.length - 1; i++) {
      const a = samples[i]!;
      const b = samples[i + 1]!;
      if (b.s >= s) {
        const t = (s - a.s) / Math.max(1e-6, b.s - a.s);
        return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, dx: a.dx, dz: a.dz, s, y: a.y + (b.y - a.y) * t, ...foldsBetween(a, b) };
      }
    }
    return samples[samples.length - 1]!;
  };
  // A closed loop runs whole, its ends its own first and last samples (the same point, one
  // direction), so the two ends of its every strip meet exactly; so does an end that runs on into
  // the next segment through a seamless joint.
  if (laid.closed) return [...samples];
  const open = laid.runsOn ?? [false, false];
  const out: RoadSample[] = [open[0] && s0 <= 1e-6 ? samples[0]! : at(s0)];
  for (const p of samples) if (p.s > s0 + 0.1 && p.s < s1 - 0.1) out.push(p);
  out.push(open[1] && s1 >= length - 1e-6 ? samples[samples.length - 1]! : at(s1));
  return out;
}

/** The nearest point of a sampled line to a point: how far along, and how far off. */
function nearestOnLine(line: ReturnType<typeof centreLine>, x: number, z: number): { s: number; d: number } {
  let best = { s: 0, d: Infinity };
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i]!;
    const b = line[i + 1]!;
    const ex = b.x - a.x;
    const ez = b.z - a.z;
    const len2 = ex * ex + ez * ez || 1;
    const t = Math.min(1, Math.max(0, ((x - a.x) * ex + (z - a.z) * ez) / len2));
    const d = Math.hypot(x - (a.x + ex * t), z - (a.z + ez * t));
    if (d < best.d) best = { s: a.s + (b.s - a.s) * t, d };
  }
  return best;
}

/** A point between two samples' fold limits (see `roads.markFolds`): the tighter of the two. */
function foldsBetween(a: RoadSample, b: RoadSample): Pick<RoadSample, "left" | "right"> {
  const left = Math.min(a.left ?? Infinity, b.left ?? Infinity);
  const right = Math.min(a.right ?? Infinity, b.right ?? Infinity);
  return { ...(Number.isFinite(left) ? { left } : {}), ...(Number.isFinite(right) ? { right } : {}) };
}

/** A sample at `s` along, interpolated. */
export function sampleAt(samples: readonly RoadSample[], s: number): RoadSample {
  for (let i = 0; i < samples.length - 1; i++) {
    const a = samples[i]!;
    const b = samples[i + 1]!;
    if (b.s >= s) {
      const t = (s - a.s) / Math.max(1e-6, b.s - a.s);
      return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, dx: a.dx, dz: a.dz, s, y: a.y + (b.y - a.y) * t, ...foldsBetween(a, b) };
    }
  }
  return samples[samples.length - 1]!;
}

/**
 * Where people cross a road, as stretches along it (from its start, metres): the zebras across its
 * ends at its junctions (`Junction.crossings`) and its own between them (`TerrainRoad.crossings`).
 * Its median opens there (`medianRuns`).
 */
export function medianCuts(laid: LaidRoad, junctionAt: (id: number) => Junction | undefined): [number, number][] {
  const out: [number, number][] = [];
  if (laid.samples.length < 2) return out;
  const length = laid.samples[laid.samples.length - 1]!.s;
  for (const end of [0, 1] as const) {
    const id = end === 0 ? laid.road.from : laid.road.to;
    const junction = id === undefined ? undefined : junctionAt(id);
    for (const z of junction?.crossings ?? []) if (z.road === laid.index && z.end === end) out.push(end === 0 ? [z.c0, z.c1] : [length - z.c1, length - z.c0]);
  }
  for (const c of laid.road.crossings ?? []) out.push([c - 1.5, c + 1.5]);
  return out;
}

export { ROAD_STEP };

/** The shoulder round a junction: as wide as the widest of its arms' (0 when none has one). */
export function junctionShoulder(junction: Junction): number {
  return junction.dirt ? 0 : Math.max(0, ...junction.arms.map((a) => (a.walk > 0 ? 0 : a.fringe)));
}

/**
 * A junction's raised verge, measured out from its outline (`half` 0): lifted as its least lifted
 * raised arm (a higher arm's bank then runs into ground a little higher than its foot, rather than a
 * lower arm's bank ending in the air over ground dug for the higher one), with the junction's
 * fringe on top; null when no arm is raised (or it has sidewalks round it).
 */
export function junctionVerge(junction: Junction, spacing: number): Verge | null {
  const raised = junction.arms.filter((a) => a.lift > 0);
  if (junction.dirt || raised.length === 0 || junction.arms.some((a) => a.walk > 0)) return null;
  const fringe = junctionShoulder(junction);
  if (fringe <= 0) return null;
  const lowest = raised.reduce((a, b) => (b.lift < a.lift ? b : a));
  const lift = lowest.lift;
  const bank = lowest.section.verge.bank;
  return vergeOf(0, fringe, lift, bank, spacing);
}

/**
 * A raised junction's verge at each point of its outline: at a road's mouth, that road's own (its
 * lift and bank, so its bank runs on into the junction's with no step), eased from one road's to
 * the next's round the corner between them. Null when the junction is not raised (`junctionVerge`).
 */
export function junctionVerges(junction: Junction, spacing: number): Verge[] | null {
  const lowest = junctionVerge(junction, spacing);
  if (!lowest) return null;
  const { node, outline } = junction;
  const n = outline.length;
  const mouth = junctionMouths(junction);
  const fringe = junctionShoulder(junction);
  // The arm each mouth is: the one pointing most nearly through its middle.
  const armAt = new Map<number, Arm>();
  for (let i = 0; i < n; i++) {
    if (!mouth[i]) continue;
    const a = outline[i]!;
    const b = outline[(i + 1) % n]!;
    const mx = (a[0] + b[0]) / 2 - node.x;
    const mz = (a[1] + b[1]) / 2 - node.z;
    const d = Math.hypot(mx, mz) || 1;
    let best: Arm | undefined;
    let score = -Infinity;
    for (const arm of junction.arms) {
      const dot = (arm.dx * mx + arm.dz * mz) / d;
      if (dot > score) {
        score = dot;
        best = arm;
      }
    }
    if (best) armAt.set(i, best);
  }
  if (armAt.size === 0) return outline.map(() => lowest);
  // Perimeter distance from point 0 to each point, round the outline.
  const along = [0];
  for (let i = 1; i <= n; i++) along.push(along[i - 1]! + Math.hypot(outline[i % n]![0] - outline[i - 1]![0], outline[i % n]![1] - outline[i - 1]![1]));
  const total = along[n]!;
  const own = (arm: Arm): { lift: number; bank: number } => ({ lift: Math.max(0, arm.lift), bank: arm.section.verge.bank });
  return outline.map((_, k) => {
    // The mouth before this point (ending at or before it) and the one after (starting at or after it).
    let back = Infinity;
    let before: Arm | undefined;
    let ahead = Infinity;
    let after: Arm | undefined;
    for (const [i, arm] of armAt) {
      const end = (i + 1) % n;
      const db = (((along[k]! - along[end]!) % total) + total) % total;
      if (db < back) {
        back = db;
        before = arm;
      }
      const da = (((along[i]! - along[k]!) % total) + total) % total;
      if (da < ahead) {
        ahead = da;
        after = arm;
      }
    }
    const p = own(before!);
    const q = own(after!);
    const t = back + ahead > 1e-6 ? back / (back + ahead) : 0;
    const e = t * t * (3 - 2 * t);
    return vergeOf(0, fringe, p.lift + (q.lift - p.lift) * e, p.bank + (q.bank - p.bank) * e, spacing);
  });
}

/** The runs of a road's samples that are bridge, each with a sample of solid ground either end. */
export function bridgeRuns(samples: readonly RoadSample[]): RoadSample[][] {
  // Each span, and three samples (6 m) of solid ground either end: the deck runs on into the
  // bank instead of stopping where the water does and leaving a sliver of road over a gap.
  const runs: RoadSample[][] = [];
  for (let i = 0; i < samples.length; ) {
    if (!samples[i]!.bridge) {
      i++;
      continue;
    }
    let j = i;
    while (j < samples.length && samples[j]!.bridge) j++;
    runs.push(samples.slice(Math.max(0, i - 3), Math.min(samples.length, j + 3)));
    i = j;
  }
  return runs;
}

/** How tall a bridge's railing is. */
export const RAILING = 1.1;

/** Roadside furniture along a country road: where it goes, worked out from the road and its ground. */
export interface Roadside {
  /** Guard rails: each a run of points along the road's edge, at road height, and its side. */
  rails: { side: 1 | -1; kind: BarrierKind; points: [number, number, number][]; dx: number[]; dz: number[] }[];
  /** Reflector posts: a point on the ground and the road's direction there. */
  posts: { at: [number, number, number]; dx: number; dz: number }[];
  /** Curve warning chevrons: a point on the ground, the road's direction, and which way it bends. */
  chevrons: { at: [number, number, number]; dx: number; dz: number; turn: 1 | -1 }[];
}

/** How the roadside is placed. */
export const ROADSIDE = {
  /** A drop this deep (metres) off the edge gets a guard rail. */
  railDrop: 2.2,
  /** Metres past the rail's line the ground is looked at for that drop. */
  railProbe: [3.5, 6, 9] as readonly number[],
  /** A bend tighter than this (radius, metres) gets a rail on its outside, and chevrons. */
  railRadius: 55,
  chevronRadius: 75,
  /** Metres between reflector posts, and between chevrons through a bend. */
  postEvery: 50,
  chevronEvery: 14,
  /** Rails run on this far past where they are needed, and past a bridge's ends. */
  railRunOn: 12,
};

/** Whether a road's control point is one of its quiet ones: no automatic rail or power pole round it. */
export function quietPoint(road: TerrainRoad, index: number): boolean {
  const p = road.points[index];
  return !!p && (road.quiet ?? []).some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 0.05);
}

/**
 * The stretches of a laid road (metres along it) where its automatic roadside is off: round each
 * of its quiet points, from halfway to the point before to halfway to the one after.
 */
export function quietStretches(laid: LaidRoad): [number, number][] {
  const road = laid.road;
  if (!road.quiet?.length || laid.samples.length < 2) return [];
  const along = road.points.map((p) => nearestOnLine(laid.samples, p[0], p[1]).s);
  const out: [number, number][] = [];
  for (let i = 1; i < road.points.length - 1; i++) {
    if (!quietPoint(road, i)) continue;
    out.push([(along[i - 1]! + along[i]!) / 2, (along[i]! + along[i + 1]!) / 2]);
  }
  return out;
}

/** A profile's barrier mode as a road's own setting would put it: always is on, none is off, auto unset. */
function modeSetting(mode: BarrierMode): RoadsideSetting | undefined {
  return mode === "always" ? "on" : mode === "none" ? "off" : undefined;
}

/** A road's roadside setting for rails or poles on one side of travel (1 the left); undefined is auto. */
export function roadsideSetting(road: TerrainRoad, what: "rails" | "poles", side: 1 | -1): RoadsideSetting | undefined {
  return road[`${what}${side === 1 ? "Left" : "Right"}`];
}

/**
 * Where a country road's guard rails, reflector posts and curve chevrons go. A rail where the
 * ground falls away steeply beside it, on the outside of a tight bend, and off each end of a
 * bridge; chevrons round the outside of a sharp bend; reflector posts every so often on both
 * sides wherever there is no rail. Only roads with a shoulder (country roads and highways), and
 * never within a junction's reach.
 */
export function roadsideOf(terrain: TerrainData, laid: LaidRoad): Roadside {
  const out: Roadside = { rails: [], posts: [], chevrons: [] };
  if (laid.shoulder <= 0) return out;
  const samples = trimmedSamples(laid);
  const n = samples.length;
  if (n < 6) return out;
  const edgeOut = laid.half + laid.shoulder * 0.7;
  // Curvature: the turn over 10 m either way, signed (+ bends left of travel).
  const bendAt = samples.map((_, i) => {
    const a = samples[Math.max(0, i - 5)]!;
    const b = samples[Math.min(n - 1, i + 5)]!;
    const cross = a.dx * b.dz - a.dz * b.dx;
    const dot = a.dx * b.dx + a.dz * b.dz;
    const angle = Math.atan2(cross, dot);
    const run = Math.max(1, b.s - a.s);
    return { radius: Math.abs(angle) > 1e-4 ? run / Math.abs(angle) : Infinity, turn: (angle > 0 ? 1 : -1) as 1 | -1 };
  });
  const nearBridge = (i: number): boolean => {
    for (let k = Math.max(0, i - 6); k <= Math.min(n - 1, i + 6); k++) if (samples[k]!.bridge) return true;
    return false;
  };
  const length = samples[n - 1]!.s - samples[0]!.s;
  // Clear of the junctions at its ends: their corners are not the road's edge.
  const clear = (p: RoadSample): boolean => p.s - samples[0]!.s > 6 && samples[n - 1]!.s - p.s > 6 && length > 20;
  const quiet = quietStretches(laid);
  for (const side of [1, -1] as const) {
    // Nothing in a site's driveway: no rail across it, no post in it.
    const driveway = (p: RoadSample): boolean => {
      const x = p.x - p.dz * side * edgeOut;
      const z = p.z + p.dx * side * edgeOut;
      // A post stands out past the shoulder: not on a driveway's apron there either.
      const px = p.x - p.dz * side * (laid.half + laid.shoulder + 0.4);
      const pz = p.z + p.dx * side * (laid.half + laid.shoulder + 0.4);
      return false;
    };
    // The road's own say, else its profile's (a highway's barriers all along, say).
    const setting = roadsideSetting(laid.road, "rails", side) ?? modeSetting(laid.section.barriers[side === 1 ? "left" : "right"]);
    const kind = barrierKindOf(laid.road, side, laid.section);
    const needs = samples.map((p, i) => {
      if (setting === "off" || !clear(p) || p.bridge || driveway(p)) return false;
      if (setting === "on") return true;
      // The outside of a tight bend: to the right of travel for a left bend.
      const bend = bendAt[i]!;
      if (bend.radius < ROADSIDE.railRadius && bend.turn === -side) return true;
      if (nearBridge(i)) return true;
      // A drop anywhere down the bank, not only just past the shoulder: a graded embankment's top
      // eases out level for a few metres before it falls, either side alike.
      for (const out of ROADSIDE.railProbe) {
        const gx = p.x - p.dz * side * (edgeOut + out);
        const gz = p.z + p.dx * side * (edgeOut + out);
        if (p.y - heightAt(terrain, gx, gz) > ROADSIDE.railDrop) return true;
      }
      return false;
    });
    // Run on past each stretch, so a rail starts before the danger and is not a stub.
    const reach = Math.round(ROADSIDE.railRunOn / 2);
    const want = needs.map((_, i) => {
      const p = samples[i]!;
      if (!clear(p) || p.bridge || driveway(p) || quiet.some(([a, b]) => p.s >= a && p.s <= b)) return false;
      for (let k = Math.max(0, i - reach); k <= Math.min(n - 1, i + reach); k++) if (needs[k]) return true;
      return false;
    });
    let run: number[] = [];
    const flush = (): void => {
      if (run.length >= 4) {
        const at = run.map((i) => samples[i]!);
        out.rails.push({
          side,
          kind,
          points: at.map((p) => {
            const [x, z] = acrossRoad(p, side * edgeOut);
            return [x, p.y, z];
          }),
          dx: at.map((p) => p.dx),
          dz: at.map((p) => p.dz),
        });
      }
      run = [];
    };
    want.forEach((w, i) => {
      if (w) run.push(i);
      else flush();
    });
    flush();
    // Reflector posts where there is no rail, staggered side to side.
    const offset = side === 1 ? 0 : ROADSIDE.postEvery / 2;
    for (let i = 0; i < n; i++) {
      const p = samples[i]!;
      if (!clear(p) || p.bridge || want[i] || driveway(p)) continue;
      const along = p.s - samples[0]!.s + offset;
      const prev = i > 0 ? samples[i - 1]!.s - samples[0]!.s + offset : -1;
      if (Math.floor(along / ROADSIDE.postEvery) === Math.floor(prev / ROADSIDE.postEvery)) continue;
      // On a raised road, on its fringe at the bank's top (the ground under the bank is held low).
      if (laid.verge) {
        const [x, z] = acrossRoad(p, side * (laid.verge.top - 0.3));
        out.posts.push({ at: [x, p.y - 0.02, z], dx: p.dx, dz: p.dz });
        continue;
      }
      const [x, z] = acrossRoad(p, side * (laid.half + laid.shoulder + 0.4));
      out.posts.push({ at: [x, heightAt(terrain, x, z), z], dx: p.dx, dz: p.dz });
    }
  }
  // Chevrons round the outside of a sharp bend, every so often through it.
  let last = -Infinity;
  for (let i = 0; i < n; i++) {
    const p = samples[i]!;
    const bend = bendAt[i]!;
    if (!clear(p) || p.bridge || bend.radius >= ROADSIDE.chevronRadius || p.s - last < ROADSIDE.chevronEvery) continue;
    const side = -bend.turn as 1 | -1;
    const cx = p.x - p.dz * side * (laid.half + laid.shoulder + 1.2);
    const cz = p.z + p.dx * side * (laid.half + laid.shoulder + 1.2);
    const x = p.x - p.dz * side * (laid.half + laid.shoulder + 1.2);
    const z = p.z + p.dx * side * (laid.half + laid.shoulder + 1.2);
    out.chevrons.push({ at: [x, heightAt(terrain, x, z), z], dx: p.dx, dz: p.dz, turn: bend.turn });
    last = p.s;
  }
  return out;
}

/** A guard rail's top over the road, metres. */
export const RAIL_TOP = 0.78;

/** A dropped kerb's length, metres, and its height at the foot (just over the road). */
const RAMP_LENGTH = 3;
const RAMP_FOOT = 0.015;
/** Metres a driveway's dropped kerb takes to come back up to full height either side of it. */
const DRIVE_TAPER = 1.5;

/** The distances along a road a driveway's kerb changes at, for drawing it with points there. */
export function driveBreaks(laid: LaidRoad, side: 1 | -1): number[] {
  return (laid.drives ?? []).filter((d) => d.side === side).flatMap((d) => [d.s0 - DRIVE_TAPER, d.s0, d.s1, d.s1 + DRIVE_TAPER, ...(d.core ?? [])]);
}

/** A road's samples with points added where a driveway's kerb drops or rises (see {@link driveBreaks}), and where its parking bays' kerb steps. */
export function withDriveBreaks(laid: LaidRoad, samples: readonly RoadSample[], side: 1 | -1): RoadSample[] {
  const breaks = [...driveBreaks(laid, side), ...(laid.sides ? bayBreaks(laid.sides[side === 1 ? 0 : 1]) : [])];
  if (breaks.length === 0 || samples.length < 2) return [...samples];
  const s0 = samples[0]!.s;
  const s1 = samples[samples.length - 1]!.s;
  const extra = breaks.filter((b) => b > s0 + 0.05 && b < s1 - 0.05 && !samples.some((p) => Math.abs(p.s - b) < 0.05)).map((b) => sampleAt(samples, b));
  return [...samples, ...extra].sort((a, b) => a.s - b.s);
}

/**
 * The kerb's height over the road at each sample, on one side: the sidewalk's own top, except
 * across a driveway, where it is dropped to just over the road and the sidewalk slopes up from it
 * to its full height at the back (the height `walkTops` gives).
 */
export function kerbTops(laid: LaidRoad, samples: readonly RoadSample[], side: 1 | -1, tops: readonly number[]): number[] {
  const drives = (laid.drives ?? []).filter((d) => d.side === side);
  if (drives.length === 0) return [...tops];
  return samples.map((p, k) => {
    let t = 1;
    for (const d of drives) {
      const out = Math.max(d.s0 - p.s, p.s - d.s1, 0);
      t = Math.min(t, out / DRIVE_TAPER);
    }
    const top = tops[k]!;
    return Math.min(top, RAMP_FOOT + (top - RAMP_FOOT) * Math.min(1, Math.max(0, t)));
  });
}

/**
 * A sidewalk's height over the road at each sample: the kerb's, except over the last couple of
 * metres before an end that does not carry on round a corner, where it ramps down to the road (a
 * dropped kerb) instead of stopping as a block.
 */
export function walkTops(
  laid: LaidRoad,
  samples: readonly RoadSample[],
  side: 1 | -1,
  /** Where its sidewalk starts and ends along it: the given samples' first and last unless told. */
  first = samples[0]?.s ?? 0,
  last = samples[samples.length - 1]?.s ?? 0,
): number[] {
  const k = side === 1 ? 0 : 1;
  return samples.map((p) => {
    let t = 1;
    if (!laid.walkOn[0][k]) t = Math.min(t, (p.s - first) / RAMP_LENGTH);
    if (!laid.walkOn[1][k]) t = Math.min(t, (last - p.s) / RAMP_LENGTH);
    return RAMP_FOOT + (KERB - RAMP_FOOT) * Math.min(1, Math.max(0, t));
  });
}

/** For each edge of a junction's outline (from point i to i + 1), whether it runs straight across one of its roads' ends. */
export function junctionMouths(junction: Junction): boolean[] {
  const { node, outline } = junction;
  const n = outline.length;
  return outline.map((a, i) => {
    const b = outline[(i + 1) % n]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const mx = (a[0] + b[0]) / 2 - node.x;
    const mz = (a[1] + b[1]) / 2 - node.z;
    const md = Math.hypot(mx, mz) || 1;
    return junction.arms.some((arm) => Math.abs(len - arm.half * 2) < 0.6 && (mx * arm.dx + mz * arm.dz) / md > 0.9 && Math.abs(((b[0] - a[0]) * arm.dx + (b[1] - a[1]) * arm.dz) / len) < 0.25);
  });
}

/**
 * The edges of a junction's outline that are not a road's mouth, each with the direction its ends
 * go out from the junction (`ca`, `cb`): its edges' outward normals together at a corner, and
 * beside a mouth straight out along the mouth's line, square across the road, exactly where the
 * road's own shoulder ends. What its fringe (and a raised junction's bank) is laid out along.
 */
export function junctionEdges(junction: Junction): { a: [number, number]; b: [number, number]; ca: [number, number]; cb: [number, number]; i: number; j: number }[] {
  const { node, outline } = junction;
  const n = outline.length;
  const mouth = junctionMouths(junction);
  // Each edge's outward normal (away from the node), and each corner's: its edges' together.
  const normal = outline.map((a, i) => {
    const b = outline[(i + 1) % n]!;
    let nx = b[1] - a[1];
    let nz = -(b[0] - a[0]);
    const d = Math.hypot(nx, nz) || 1;
    nx /= d;
    nz /= d;
    if (nx * ((a[0] + b[0]) / 2 - node.x) + nz * ((a[1] + b[1]) / 2 - node.z) < 0) {
      nx = -nx;
      nz = -nz;
    }
    return [nx, nz] as [number, number];
  });
  const corner = outline.map((p, i) => {
    const prev = (i - 1 + n) % n;
    const across = mouth[prev] ? outline[prev]! : mouth[i] ? outline[(i + 1) % n]! : null;
    if (across) {
      const dx = p[0] - across[0];
      const dz = p[1] - across[1];
      const d = Math.hypot(dx, dz) || 1;
      return [dx / d, dz / d] as [number, number];
    }
    let x = 0;
    let z = 0;
    if (!mouth[prev]) {
      x += normal[prev]![0];
      z += normal[prev]![1];
    }
    if (!mouth[i]) {
      x += normal[i]![0];
      z += normal[i]![1];
    }
    const d = Math.hypot(x, z) || 1;
    return [x / d, z / d] as [number, number];
  });
  const out: { a: [number, number]; b: [number, number]; ca: [number, number]; cb: [number, number]; i: number; j: number }[] = [];
  for (let i = 0; i < n; i++) {
    if (mouth[i]) continue;
    const j = (i + 1) % n;
    out.push({ a: outline[i]!, b: outline[j]!, ca: corner[i]!, cb: corner[j]!, i, j });
  }
  return out;
}
