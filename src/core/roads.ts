import { heightAt, type TerrainData } from "./data";
import { liftOf, sectionOf, type RoadOverrides, type SegmentOverrides } from "./road-sections";

/** Metres round a town's pad that belong to the town: a road outside grades up to here and no further. */
const PAD_KEEP = 6;

/** The town whose pad holds a point, or undefined. */
function padAt(_terrain: TerrainData, _x: number, _z: number, _margin: number): { height: number } | undefined {
  return undefined;
}

/**
 * Roads on a terrain: a smooth line through a few control points and a height profile along it,
 * limited in slope. Three-free and pure; `roads-geometry.ts` draws the asphalt a few centimetres
 * above the ground.
 *
 * A road is stored as its control points only (`TerrainData.roads`); everything else is derived,
 * so editing a road is moving a point and grading again.
 */

export type RoadKind = "highway" | "road" | "street" | "dirt";

/** A road's override of an automatic roadside extra on one side: always there, or never. */
export type RoadsideSetting = "on" | "off";

/**
 * What kind of town street a street is, Motortown style: a main street is wide (two lanes and a
 * parking lane each way) with broad sidewalks; a local street is a narrow residential one; a lane
 * is a service road into a yard or behind shops, no sidewalks. A street with none is the plain
 * 10 m street the older towns were laid with.
 */
export type StreetClass = "main" | "local" | "lane";

export interface TerrainRoad {
  /**
   * The old fixed kind. A road with a profile (`section`) carries its profile's kind here (written
   * when the profile is set), for older readers; one without reads through the legacy profile for it.
   */
  kind: RoadKind;
  /** Its road profile's id (`road-sections.ts`): its lanes, paint, shoulder, verge. Unset: by `kind` and `class`. */
  section?: string;
  /** Its own changes to its profile's fields (lane count and width, paint, shoulder, lift, turn lanes). */
  overrides?: RoadOverrides;
  /**
   * A segment's own changes over the road's (its overrides, guard rails): set on a stretch of a
   * road laid as a road of its own between two joints (`RoadNode.joint`), so it reads differently
   * from the rest of its road there. The road's own fields (`overrides`, profile) are the same on
   * every segment of it (`roadChain`).
   */
  segment?: SegmentOverrides;
  /** A street's name, given by hand ("Oak Street"); unnamed streets get one made up in the editor. */
  name?: string;
  /** Set on a town's streets: the town (`TerrainTown.id`) it goes with. */
  town?: number;
  /**
   * Heights its first and last points are held at: where it was snapped onto another road, so the
   * two meet level instead of one cutting a step into the other.
   */
  pinStart?: number;
  pinEnd?: number;
  /**
   * Control points, world X and Z. A spline road passes through every one; a fillet road (`line`)
   * runs straight from one to the next, its inner points corners rounded off by `fillet`.
   */
  points: [number, number][];
  /**
   * How its centre line runs through its points: unset, one smooth curve through them all (free
   * drawing); `fillet`, straight legs between them with each inner point a corner rounded to
   * `fillet` (the grid helper's town streets).
   */
  line?: "fillet";
  /** A fillet road's corner radius: the kerb's (the asphalt edge's) on the inside of each corner, metres. */
  fillet?: number;
  /**
   * A zebra across it where it comes into the junction at its start / end (true or false); unset is
   * its profile's say (`RoadSection.crossings`: on where the junction's corners have sidewalks).
   */
  crossStart?: boolean;
  crossEnd?: boolean;
  /** The nodes it runs between (`RoadNode.id`, see `network.ts`); its end points sit on them. */
  from?: number;
  to?: number;
  /** Sidewalks either side. Default: streets have them (but a lane), nothing else does. */
  sidewalk?: boolean;
  /** A street's class (see {@link StreetClass}): its width, sidewalks and paint. Streets only. */
  class?: StreetClass;
  /** Zebra crossings, metres along it from its start. */
  crossings?: number[];
  /**
   * A country road's automatic roadside, overridden by side of travel (left, right): guard rails
   * where it drops away, bends or meets a bridge, and the power line along one side. "on" all along
   * that side, "off" never; unset is auto (the usual). Only overrides are stored.
   */
  railsLeft?: RoadsideSetting;
  railsRight?: RoadsideSetting;
  polesLeft?: RoadsideSetting;
  polesRight?: RoadsideSetting;
  /**
   * Its inner control points (where they stand, X and Z) at which the automatic roadside is off:
   * no guard rail and no power pole from halfway to the point before to halfway to the one after.
   */
  quiet?: [number, number][];
  /**
   * Its heights as last graded, one per centre-line sample, and the shape they were graded for
   * (`key`). Re-profiling from the ground after grading reads ground the grade itself moved, so a
   * road worked out again on load drifts a few centimetres off the cutting made for it and the
   * ground shows through; kept, the road stays exactly where its ground was shaped. Ignored once
   * the road's points or end heights change.
   */
  profile?: { key: string; y: number[]; bridges?: [number, number][] };
}

/** How a road's profile is held at its ends. */
export interface RoadHold {
  pinStart?: number;
  pinEnd?: number;
  /** Metres from each end held at the pin. */
  holdStart?: number;
  holdEnd?: number;
  /** Metres from each end a junction takes: a short road held at both ends is level over those. */
  trimStart?: number;
  trimEnd?: number;
}

export interface RoadStyle {
  /** Driving width, metres. */
  width: number;
  /** Graded ground either side of the road, blending back into the terrain. */
  shoulder: number;
  /** Steepest climb allowed, rise over run. Highways are gentle; a dirt track goes where it likes. */
  maxGrade: number;
  /** Metres of terrain the profile averages over: how much a road ignores small bumps. */
  smoothing: number;
}

/** The fields of a road its profile is read from. */
export type SectionedRoad = Pick<TerrainRoad, "kind" | "class" | "section" | "overrides" | "town" | "segment">;

/** A road's asphalt width, metres: its lanes and hard shoulders (see `sectionOf`). */
export function roadWidth(road: SectionedRoad): number {
  return sectionOf(road).half * 2;
}

/** A road's grading style: its profile's steepest climb, smoothing and graded bed. */
export function roadStyle(road: SectionedRoad): RoadStyle {
  const section = sectionOf(road);
  return { width: section.half * 2, shoulder: section.grade.bed, maxGrade: section.grade.maxGrade, smoothing: section.grade.smoothing };
}

/** Metres between samples of the centre line. */
export const ROAD_STEP = 2;

/** One point along a road's centre line. */
export interface RoadSample {
  x: number;
  z: number;
  /** Unit direction of travel, in X and Z. */
  dx: number;
  dz: number;
  /** Distance along the road from its start, metres. */
  s: number;
  /** Road surface height. */
  y: number;
  /** Over water: carried on a bridge, with nothing graded under it. */
  bridge?: boolean;
  /**
   * The furthest anything may be put across the road from here to its left (`left`, + in
   * {@link acrossRoad}) and its right before it would fold back over itself: the radius of a bend
   * on its inside, a little short of the bend's centre (see {@link markFolds}). Unset: no limit.
   */
  left?: number;
  right?: number;
}

/**
 * Marks each sample with how far across it its edges may go (`left`, `right`): on the inside of a
 * bend, the bend's radius there (from the turn between the legs either side of it, and its
 * neighbours', whichever is tightest), a hair short of its centre, so an edge offset by more than
 * that - a wide road's inner edge round a tight bend, its shoulder, its sidewalk, its rail - is
 * held at the bend's centre instead of crossing over it and folding back into a twisted triangle.
 * In place; returns the samples.
 */
export function markFolds<T extends RoadSample>(samples: T[]): T[] {
  const n = samples.length;
  if (n < 2) return samples;
  // Each leg's bend: its length over the turn between its two ends' directions (what the edges
  // are offset along), and which way.
  const radius = new Float64Array(n - 1).fill(Infinity);
  const turn = new Int8Array(n - 1);
  for (let i = 0; i + 1 < n; i++) {
    const a = samples[i]!;
    const b = samples[i + 1]!;
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    const cross = a.dx * b.dz - a.dz * b.dx;
    const angle = Math.abs(Math.atan2(cross, a.dx * b.dx + a.dz * b.dz));
    if (angle < 1e-5) continue;
    // A left turn (toward (-dz, dx)) has its inside on the left.
    radius[i] = length / angle;
    turn[i] = cross > 0 ? 1 : -1;
  }
  // A closed ring (its last sample on its first): its ends' legs are each other's neighbours.
  const first = samples[0]!;
  const end = samples[n - 1]!;
  const ring = n > 3 && Math.hypot(first.x - end.x, first.z - end.z) < 1e-6;
  for (let i = 0; i < n; i++) {
    let left = Infinity;
    let right = Infinity;
    const legs: number[] = [];
    for (let k = Math.max(0, i - 1); k <= Math.min(n - 2, i); k++) legs.push(k);
    if (ring && i === 0) legs.push(n - 2);
    if (ring && i === n - 1) legs.push(0);
    for (const k of legs) {
      if (turn[k] === 1) left = Math.min(left, radius[k]!);
      else if (turn[k] === -1) right = Math.min(right, radius[k]!);
    }
    const p = samples[i]!;
    if (Number.isFinite(left)) p.left = left * 0.97;
    else delete p.left;
    if (Number.isFinite(right)) p.right = right * 0.97;
    else delete p.right;
  }
  return samples;
}

/**
 * The point `k` metres across a road from a sample (+ to the left of travel), held at the bend's
 * centre on the inside of a bend too tight for it (see {@link markFolds}): X and Z.
 */
export function acrossRoad(p: RoadSample, k: number): [number, number] {
  const c = k > 0 ? Math.min(k, p.left ?? Infinity) : Math.max(k, -(p.right ?? Infinity));
  return [p.x - p.dz * c, p.z + p.dx * c];
}

/** The most a road's grade changes per metre along it (a vertical curve's tightness). */
const BEND = 0.022;
/**
 * How far a shoulder falls across its width below the road: past the ground under it (`ROAD_SINK`),
 * so the ground closes over its outer part instead of it ending in a raised edge.
 */
export const SHOULDER_DROP = 0.125;

/**
 * A road's shoulder width: country roads and highways have one; a street has sidewalks instead, a
 * dirt track is all shoulder already, and an old tiled town's roads have neither.
 */
export function shoulderOf(road: TerrainRoad): number {
  if (road.town !== undefined) return 0;
  return (road.sidewalk ?? false) ? 0 : sectionOf(road).verge.fringe;
}

/** Metres a bridge's deck stands over the water. */
export const BRIDGE_CLEARANCE = 4;

/**
 * The centre line through the control points (Catmull-Rom), at roughly {@link ROAD_STEP} spacing,
 * with heights from {@link profile}. Fewer than two points is no road.
 */
export function sampleRoad(terrain: TerrainData, road: TerrainRoad, hold?: RoadHold): RoadSample[] {
  const line = roadLine(road);
  if (line.length < 2) return [];
  // Held at its nodes' heights, when it has nodes.
  const from = road.from === undefined ? undefined : terrain.nodes?.find((n) => n.id === road.from);
  const to = road.to === undefined ? undefined : terrain.nodes?.find((n) => n.id === road.to);
  const pinStart = hold?.pinStart ?? from?.y ?? road.pinStart;
  const pinEnd = hold?.pinEnd ?? to?.y ?? road.pinEnd;
  const kept = road.profile;
  // A closed loop through its own node: its heights run on smoothly through the seam.
  const seam = closedRing(road.points) && pinStart !== undefined && pinStart === pinEnd ? pinStart : undefined;
  if (kept && kept.y.length === line.length && kept.key === profileKey(road, pinStart, pinEnd)) {
    const out: RoadSample[] = line.map((p, i) => ({ ...p, y: kept.y[i]! }));
    for (const [a, b] of kept.bridges ?? []) for (let i = a; i <= b && i < out.length; i++) out[i]!.bridge = true;
    if (hold) levelEnds(out, pinStart, pinEnd, hold.holdStart ?? 6, hold.holdEnd ?? 6, roadStyle(road).maxGrade);
    if (seam !== undefined) easeSeam(out, seam);
    return out;
  }
  const out = profile(terrain, line, roadStyle(road), road.town === undefined, pinStart, pinEnd, hold?.holdStart ?? 6, hold?.holdEnd ?? 6, hold?.trimStart ?? 0, hold?.trimEnd ?? 0);
  if (seam !== undefined) easeSeam(out, seam);
  return out;
}

/** How far either side of a closed loop's seam its heights are eased through it, metres. */
const SEAM_EASE = 24;

/**
 * A closed loop's heights eased through its seam: at its node's height there (`pin`), at the slope
 * the road takes across it, and onto its own heights and slope `SEAM_EASE` metres either side. Held
 * at the node from both ends alone, the two ends met at the node's height at two different slopes,
 * a crease (or a bump) across the road. In place.
 */
function easeSeam(out: RoadSample[], pin: number): void {
  const n = out.length;
  const length = out[n - 1]!.s;
  if (n < 8 || length < SEAM_EASE * 3) return;
  const ys = out.map((p) => p.y);
  const yAt = (s: number): number => {
    let i = 0;
    while (i < n - 2 && out[i + 1]!.s < s) i++;
    const t = clamp((s - out[i]!.s) / Math.max(1e-6, out[i + 1]!.s - out[i]!.s), 0, 1);
    return ys[i]! + (ys[i + 1]! - ys[i]!) * t;
  };
  const r = SEAM_EASE;
  // The slope across the seam: the road's own, from one side of the ease to the other.
  const g = (yAt(r) - yAt(length - r)) / (2 * r);
  const hermite = (y0: number, g0: number, y1: number, g1: number, u: number): number =>
    (2 * u ** 3 - 3 * u ** 2 + 1) * y0 + (u ** 3 - 2 * u ** 2 + u) * r * g0 + (-2 * u ** 3 + 3 * u ** 2) * y1 + (u ** 3 - u ** 2) * r * g1;
  const startY = yAt(r);
  const startG = (yAt(r + 1) - yAt(r - 1)) / 2;
  const endY = yAt(length - r);
  const endG = (yAt(length - r + 1) - yAt(length - r - 1)) / 2;
  for (const p of out) {
    if (p.bridge) continue;
    if (p.s < r) p.y = hermite(pin, g, startY, startG, p.s / r);
    else if (p.s > length - r) p.y = hermite(endY, endG, pin, g, (p.s - (length - r)) / r);
  }
}

/** What a kept profile was worked out for: the road's shape, kind and end heights. */
function profileKey(road: TerrainRoad, pinStart: number | undefined, pinEnd: number | undefined): string {
  let h = 2166136261;
  const mix = (v: number): void => {
    h = Math.imul(h ^ Math.round(v * 100), 16777619) >>> 0;
  };
  for (const [x, z] of road.points) {
    mix(x);
    mix(z);
  }
  mix(pinStart ?? -99999);
  mix(pinEnd ?? -99999);
  // A fillet road's corners shape its line too (only then: a spline road's key is as it always was).
  if (road.line === "fillet") mix(filletRadius(road));
  return `${road.kind}:${road.points.length}:${h.toString(36)}`;
}

/**
 * Holds a kept profile level over the junctions at its ends, as {@link profile} holds a new one: a
 * road split for a new junction keeps the heights it ran at (see `splitRoad`), and only the stretch
 * the junction's flat asphalt takes is brought level with the node, easing back onto the road's own
 * heights past it. A profile kept level there already, as every graded road's is, is left exactly
 * as it was.
 */
function levelEnds(out: RoadSample[], pinStart: number | undefined, pinEnd: number | undefined, holdStart: number, holdEnd: number, maxGrade: number): void {
  const length = out[out.length - 1]!.s;
  // A short road held at both ends is a ramp between them, kept as it was.
  if (pinStart !== undefined && pinEnd !== undefined && holdStart + holdEnd >= length) return;
  const ys = out.map((p) => p.y);
  if (pinStart !== undefined) levelEnd(out, ys, pinStart, holdStart, false, maxGrade);
  if (pinEnd !== undefined) levelEnd(out, ys, pinEnd, holdEnd, true, maxGrade);
}

/** Below this the kept heights already are level with a junction (they are kept to the millimetre). */
const LEVEL_TOLERANCE = 0.005;

/**
 * One end of {@link levelEnds} (its start, or its end with `fromEnd`); `ys` are the heights as kept.
 * Level at `pin` out to `hold`, then a cubic from there (level) onto the kept heights and their
 * slope, over a stretch long enough that the climb back is no steeper than the road's steepest
 * (its style's, or its own there if it already was steeper).
 */
function levelEnd(out: RoadSample[], ys: readonly number[], pin: number, hold: number, fromEnd: boolean, maxGrade: number): void {
  const length = out[out.length - 1]!.s;
  const from = (p: RoadSample): number => (fromEnd ? length - p.s : p.s);
  let off = 0;
  out.forEach((p, i) => {
    if (from(p) <= hold) off = Math.max(off, Math.abs(ys[i]! - pin));
  });
  if (off < LEVEL_TOLERANCE) return;
  /** The kept height `x` metres in from this end. */
  const keptAt = (x: number): number => {
    const s = clamp(fromEnd ? length - x : x, 0, length);
    let i = 0;
    while (i < out.length - 2 && out[i + 1]!.s < s) i++;
    const t = clamp((s - out[i]!.s) / Math.max(1e-6, out[i + 1]!.s - out[i]!.s), 0, 1);
    return ys[i]! + (ys[i + 1]! - ys[i]!) * t;
  };
  /** The height `x` metres in, eased back over `ease` metres past the hold. */
  const eased = (x: number, ease: number): number => {
    if (x <= hold) return pin;
    if (x >= hold + ease) return keptAt(x);
    // Hermite: level at the hold, onto the kept height and slope at the far end.
    const y1 = keptAt(hold + ease);
    const g1 = (keptAt(hold + ease + 1) - keptAt(hold + ease - 1)) / 2;
    const u = (x - hold) / ease;
    return (2 * u ** 3 - 3 * u ** 2 + 1) * pin + (-2 * u ** 3 + 3 * u ** 2) * y1 + (u ** 3 - u ** 2) * ease * g1;
  };
  // Longer until the climb back is no steeper than it may be, never past the road's middle.
  const most = Math.max(2, length / 2 - hold);
  let ease = Math.min(14, most);
  for (; ease < Math.min(60, most); ease += 4) {
    let steepest = 0;
    let own = maxGrade;
    for (let x = hold; x < hold + ease; x += ROAD_STEP) {
      steepest = Math.max(steepest, Math.abs(eased(x + ROAD_STEP, ease) - eased(x, ease)) / ROAD_STEP);
      own = Math.max(own, Math.abs(keptAt(x + ROAD_STEP) - keptAt(x)) / ROAD_STEP);
    }
    if (steepest <= own + 0.002) break;
  }
  for (const p of out) {
    const x = from(p);
    if (x < hold + ease) p.y = eased(x, ease);
  }
}

/**
 * Whether a road's points close on themselves (its last point exactly its first, with at least two
 * others between): a loop, run round as one closed curve (see {@link centreLine}).
 */
export function closedRing(points: readonly (readonly [number, number])[]): boolean {
  const n = points.length;
  return n >= 4 && points[0]![0] === points[n - 1]![0] && points[0]![1] === points[n - 1]![1];
}

/**
 * The spline, unprofiled: X, Z, direction and distance along. A closed ring of points
 * ({@link closedRing}) is one closed curve: the spline runs on through its first point as through
 * any other, so its two ends meet at the same point, in the same direction.
 */
export function centreLine(points: readonly [number, number][], fillet?: number): Omit<RoadSample, "y">[] {
  if (points.length < 2) return [];
  const closed = closedRing(points);
  const n = points.length;
  // Straights and arcs (a fillet road, `fillet` its centre line's corner radius), else the spline.
  const dense: [number, number][] = fillet !== undefined ? filletPolyline(points, fillet) : [];
  for (let i = 0; fillet === undefined && i < points.length - 1; i++) {
    // Closed: the point before the first is the one before the last (the last is the first).
    const p0 = points[i > 0 ? i - 1 : closed ? n - 2 : 0]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[i + 2 < n ? i + 2 : closed ? 1 : n - 1]!;
    const length = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    const steps = Math.max(1, Math.ceil(length / (ROAD_STEP / 2)));
    const span: [number, number][] = [];
    for (let k = 0; k <= steps; k++) span.push(catmull(p0, p1, p2, p3, k / steps));
    // Uneven legs (a short one between long ones) swing the uniform spline past its points into a
    // loop, a cusp the road folds over: that span is drawn centripetally instead, which never loops.
    const use = loops(span) ? Array.from({ length: steps + 1 }, (_, k) => centripetal(p0, p1, p2, p3, k / steps)) : span;
    for (let k = 0; k < steps; k++) dense.push(use[k]!);
  }
  if (fillet === undefined) dense.push(points[points.length - 1]!);

  // Resample evenly by distance: the spline's own parameter bunches points on tight curves.
  const out: Omit<RoadSample, "y">[] = [];
  let s = 0;
  let next = 0;
  for (let i = 0; i < dense.length - 1; i++) {
    const a = dense[i]!;
    const b = dense[i + 1]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len === 0) continue;
    while (next <= s + len) {
      const t = (next - s) / len;
      out.push({ x: a[0] + (b[0] - a[0]) * t, z: a[1] + (b[1] - a[1]) * t, dx: 0, dz: 0, s: next });
      next += ROAD_STEP;
    }
    s += len;
  }
  const last = dense[dense.length - 1]!;
  if (out.length === 0 || s - out[out.length - 1]!.s > ROAD_STEP * 0.25) out.push({ x: last[0], z: last[1], dx: 0, dz: 0, s });
  else if (closed && out.length > 2) {
    // Closed: it ends exactly on its start, not a step short of it.
    const end = out[out.length - 1]!;
    end.x = last[0];
    end.z = last[1];
    end.s = s;
  }
  const m = out.length;
  const ring = closed && m > 3;
  for (let i = 0; i < m; i++) {
    // Closed: its ends look past the seam (the last sample is the first), so they share one direction.
    const a = out[i > 0 ? i - 1 : ring ? m - 2 : 0]!;
    const b = out[i < m - 1 ? i + 1 : ring ? 1 : m - 1]!;
    const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    out[i]!.dx = (b.x - a.x) / len;
    out[i]!.dz = (b.z - a.z) / len;
  }
  return out;
}

/** A fillet road's corner radius on its centre line: the kerb's radius plus the road's half width. */
export function filletRadius(road: Pick<TerrainRoad, "kind" | "class" | "section" | "overrides" | "town" | "fillet">): number {
  const section = sectionOf(road);
  return Math.max(0, road.fillet ?? section.corner) + section.half;
}

/** A road's centre line as it is drawn: a spline through its points, or straights and arcs (`line: "fillet"`). */
export function roadLine(road: Pick<TerrainRoad, "points" | "line" | "kind" | "class" | "section" | "overrides" | "town" | "fillet">): Omit<RoadSample, "y">[] {
  return centreLine(road.points, road.line === "fillet" ? filletRadius(road) : undefined);
}

/** Metres of an arc's chord at most: fine enough that a 5 m kerb piece bent along it is true. */
const ARC_STEP = 0.5;

/**
 * Straight legs between the points, each inner point a corner rounded off by an arc of `radius`
 * (the centre line's), tangent to both legs. An arc is made smaller where its legs are too short
 * for it: it takes at most half of a leg between two corners (most of one that ends the road). A
 * closed ring's seam is left a sharp corner: the line starts and ends on its node.
 */
export function filletPolyline(points: readonly [number, number][], radius: number): [number, number][] {
  const n = points.length;
  const out: [number, number][] = [points[0]!];
  for (let i = 1; i < n - 1; i++) {
    const p = points[i]!;
    const a = points[i - 1]!;
    const b = points[i + 1]!;
    const l1 = Math.hypot(p[0] - a[0], p[1] - a[1]);
    const l2 = Math.hypot(b[0] - p[0], b[1] - p[1]);
    if (l1 < 1e-6 || l2 < 1e-6) continue;
    const d1: [number, number] = [(p[0] - a[0]) / l1, (p[1] - a[1]) / l1];
    const d2: [number, number] = [(b[0] - p[0]) / l2, (b[1] - p[1]) / l2];
    const cross = d1[0] * d2[1] - d1[1] * d2[0];
    const turn = Math.atan2(Math.abs(cross), d1[0] * d2[0] + d1[1] * d2[1]);
    if (turn < 1e-3 || radius <= 0) {
      out.push(p);
      continue;
    }
    const room = Math.min(i === 1 ? l1 * 0.6 : l1 / 2, i === n - 2 ? l2 * 0.6 : l2 / 2);
    const tangent = Math.min(radius * Math.tan(turn / 2), room * 0.999);
    const r = tangent / Math.tan(turn / 2);
    const side = cross > 0 ? 1 : -1;
    // Toward the arc's centre from the first leg: its left (-dz, dx) on a left turn.
    const nx = -d1[1] * side;
    const nz = d1[0] * side;
    const sx = p[0] - d1[0] * tangent;
    const sz = p[1] - d1[1] * tangent;
    const cx = sx + nx * r;
    const cz = sz + nz * r;
    const start = Math.atan2(sz - cz, sx - cx);
    const steps = Math.max(2, Math.ceil((r * turn) / ARC_STEP));
    for (let k = 0; k <= steps; k++) {
      const angle = start + side * turn * (k / steps);
      out.push([cx + Math.cos(angle) * r, cz + Math.sin(angle) * r]);
    }
  }
  out.push(points[n - 1]!);
  return out;
}

/** Whether a span of a spline doubles back on itself: a turn of over 60 degrees between two steps (each a metre or so). */
function loops(span: readonly [number, number][]): boolean {
  for (let k = 1; k + 1 < span.length; k++) {
    const ax = span[k]![0] - span[k - 1]![0];
    const az = span[k]![1] - span[k - 1]![1];
    const bx = span[k + 1]![0] - span[k]![0];
    const bz = span[k + 1]![1] - span[k]![1];
    const la = Math.hypot(ax, az);
    const lb = Math.hypot(bx, bz);
    if (la < 1e-6 || lb < 1e-6) continue;
    if ((ax * bx + az * bz) / (la * lb) < 0.5) return true;
  }
  return false;
}

/**
 * A centripetal Catmull-Rom point (knots spaced by the square root of each leg's length), `t` of the
 * way from p1 to p2: no loops or cusps, however uneven the legs. An end's missing neighbour (the
 * same point as the end) is the other leg reflected.
 */
function centripetal(p0: readonly [number, number], p1: readonly [number, number], p2: readonly [number, number], p3: readonly [number, number], t: number): [number, number] {
  const d = (a: readonly [number, number], b: readonly [number, number]): number => Math.hypot(b[0] - a[0], b[1] - a[1]);
  const q0: readonly [number, number] = d(p0, p1) < 1e-6 ? [2 * p1[0] - p2[0], 2 * p1[1] - p2[1]] : p0;
  const q3: readonly [number, number] = d(p2, p3) < 1e-6 ? [2 * p2[0] - p1[0], 2 * p2[1] - p1[1]] : p3;
  const t0 = 0;
  const t1 = t0 + Math.max(1e-6, Math.sqrt(d(q0, p1)));
  const t2 = t1 + Math.max(1e-6, Math.sqrt(d(p1, p2)));
  const t3 = t2 + Math.max(1e-6, Math.sqrt(d(p2, q3)));
  const u = t1 + (t2 - t1) * t;
  const mix = (a: readonly [number, number], b: readonly [number, number], ta: number, tb: number): [number, number] => {
    const w = (u - ta) / (tb - ta);
    return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w];
  };
  const a1 = mix(q0, p1, t0, t1);
  const a2 = mix(p1, p2, t1, t2);
  const a3 = mix(p2, q3, t2, t3);
  const b1 = mix(a1, a2, t0, t2);
  const b2 = mix(a2, a3, t1, t3);
  return mix(b1, b2, t1, t2);
}

function catmull(p0: readonly [number, number], p1: readonly [number, number], p2: readonly [number, number], p3: readonly [number, number], t: number): [number, number] {
  const t2 = t * t;
  const t3 = t2 * t;
  const f = (a: number, b: number, c: number, d: number): number => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
  return [f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])];
}

/**
 * Heights along the centre line: the ground averaged over the style's smoothing distance, then
 * limited so no stretch climbs faster than `maxGrade` (cutting into hills and filling dips), then
 * smoothed once more so the limit's corners are not kinks.
 */
function profile(
  terrain: TerrainData,
  line: Omit<RoadSample, "y">[],
  style: RoadStyle,
  /** Outside any town: where it crosses a town's pad it is held at the pad's height. */
  pinToTowns = false,
  pinStart?: number,
  pinEnd?: number,
  holdStart = 6,
  holdEnd = 6,
  trimStart = 0,
  trimEnd = 0,
): RoadSample[] {
  const ground = line.map((p) => heightAt(terrain, p.x, p.z));
  // A road into a town arrives at the town's height: held there over the pad, and the grade limit
  // below carries that height out along the road rather than the road digging into the town.
  const pinned = line.map((p) => (pinToTowns ? padAt(terrain, p.x, p.z, PAD_KEEP)?.height : undefined));
  // An end at a node is held at the node's height over the junction and a little past, so the
  // road arrives flat.
  const length = line[line.length - 1]!.s;
  // A short road held at both ends all along: a straight slope from one to the other, not two
  // flats with a step between.
  const overlap = pinStart !== undefined && pinEnd !== undefined && holdStart + holdEnd >= length;
  line.forEach((p, i) => {
    // Level over each junction (its asphalt is flat at the node's height), sloping between.
    if (overlap) {
      const a = Math.min(trimStart, length * 0.45);
      const b = Math.max(a + 1e-3, length - Math.min(trimEnd, length * 0.45));
      pinned[i] = pinStart! + (pinEnd! - pinStart!) * clamp((p.s - a) / (b - a), 0, 1);
    } else if (pinStart !== undefined && p.s <= holdStart) pinned[i] = pinStart;
    else if (pinEnd !== undefined && length - p.s <= holdEnd) pinned[i] = pinEnd;
  });
  const sea = terrain.seaLevel;
  // Never under the sea: a road into the water is a ramp, and nobody wants that.
  const floor = sea === undefined ? -Infinity : sea + 1.2;
  const smoothed = average(ground, Math.max(1, Math.round(style.smoothing / ROAD_STEP / 2)));
  // Over a lake or a river: a bridge, its deck held clear of the water. The grade limit below
  // makes the ramps up to it.
  const water: (number | undefined)[] = line.map(() => undefined);
  // Each span at least its water's clearance, or level with its banks: a floor under the road,
  // not a pin, so a span can rise into a climb on the far side instead of leaving a step.
  const under: number[] = line.map(() => -Infinity);
  for (let i = 0; i < line.length; ) {
    if (water[i] === undefined) {
      i++;
      continue;
    }
    let j = i;
    let deck = -Infinity;
    while (j < line.length && water[j] !== undefined) deck = Math.max(deck, water[j++]! + BRIDGE_CLEARANCE);
    const bank = (k: number): number => (k >= 0 && k < line.length ? ground[k]! : -Infinity);
    deck = Math.max(deck, Math.min(Math.max(bank(i - 2), bank(i - 1)), Math.max(bank(j), bank(j + 1))));
    for (let k = i; k < j; k++) under[k] = deck;
    i = j;
  }
  let h = smoothed.map((v, i) => pinned[i] ?? Math.max(v, floor, under[i]!));
  const rise = style.maxGrade * ROAD_STEP;
  // Passes each way meet in the middle: up from the low points, down from the high ones; a
  // bridge's floor holds through them, and the ramps off it form either side.
  for (let pass = 0; pass < 4; pass++) {
    for (let i = 1; i < h.length; i++) if (pinned[i] === undefined) h[i] = Math.max(under[i]!, clamp(h[i]!, h[i - 1]! - rise, h[i - 1]! + rise));
    for (let i = h.length - 2; i >= 0; i--) if (pinned[i] === undefined) h[i] = Math.max(under[i]!, clamp(h[i]!, h[i + 1]! - rise, h[i + 1]! + rise));
  }
  // Vertical curves: wherever the grade changes by more than `BEND` per step (a road leaving a
  // level junction, cresting a rise), that sample is eased toward its neighbours, a little at a
  // time, until none is. Local: it rounds a kink off over a few metres and leaves the rest of the
  // road where it was, rather than letting the whole line drift off its ground.
  const bend = BEND * ROAD_STEP;
  for (let pass = 0; pass < 40; pass++) {
    let eased = false;
    for (let i = 1; i < h.length - 1; i++) {
      if (pinned[i] !== undefined) continue;
      const kink = h[i - 1]! - 2 * h[i]! + h[i + 1]!;
      if (Math.abs(kink) <= bend) continue;
      h[i] = Math.max(under[i]!, h[i]! + kink * 0.25);
      eased = true;
    }
    if (!eased) break;
  }
  h = average(h, 2).map((v, i) => pinned[i] ?? Math.max(v, under[i]!));
  return line.map((p, i) => (water[i] !== undefined ? { ...p, y: h[i]!, bridge: true } : { ...p, y: h[i]! }));
}

function average(values: readonly number[], half: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < values.length; i++) {
    let sum = 0;
    let n = 0;
    for (let k = Math.max(0, i - half); k <= Math.min(values.length - 1, i + half); k++) {
      sum += values[k]!;
      n++;
    }
    out.push(sum / n);
  }
  return out;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** How far down the ground sits under a road's surface. */
export const ROAD_SINK = 0.06;

/**
 * A raised road's verge across from its centre line (or a junction's, from its outline): the
 * asphalt's edge, the gravel fringe on top of the bank, the bank down to the grass at its run per
 * rise, and where the grading holds the ground low enough not to show through any of it.
 */
export interface Verge {
  /** Centre to the asphalt's edge. */
  half: number;
  /** The fringe's outer edge: the bank's top. */
  top: number;
  /** The bank's foot, on the grass. */
  foot: number;
  /** How far the road stands over the grass. */
  lift: number;
  /**
   * Out to here the ground is held under the road as usual; past it, under the low grass line
   * (`RAISE_LOW` under the foot), out to the foot and {@link RAISE_APRON} on. Far enough in that no
   * grid triangle from a sample under the road to one past the foot rides up over the bank.
   */
  inner: number;
}

/** How far a raised road's fringe falls across it, from the asphalt's edge to the bank's top. */
export const RAISED_FRINGE_DROP = 0.04;
/** The ground under a raised road's verge sits this far under the grass line at the bank's foot. */
export const RAISE_LOW = 0.08;
/** Metres past a bank's foot the ground is held low (and the bank's toe tucks in under it). */
export const RAISE_APRON = 1;
/** The bank's toe: how far past the foot it runs on, and how far down, under the grass. */
export const BANK_TOE = 0.5;
/** The drawn asphalt's lift over its road's height (`ROAD_LIFT` in roads-geometry). */
const SURFACE = 0.02;

/** A raised verge's shape: `half` the asphalt's half width, `fringe` the gravel's, `lift` and `bank` (run per rise). */
export function vergeOf(half: number, fringe: number, lift: number, bank: number, spacing: number): Verge {
  const top = half + fringe;
  const drop = lift + SURFACE - RAISED_FRINGE_DROP;
  const foot = top + Math.max(0.05, drop * bank);
  const diag = spacing * Math.SQRT2;
  const inner = Math.min(half - 0.3, foot - (diag * (lift - ROAD_SINK)) / (lift + RAISE_LOW - ROAD_SINK) - 0.05);
  return { half, top, foot, lift, inner };
}

/**
 * The verge's section, out from the asphalt's edge: [across, height over the road's own height]
 * at the asphalt's edge, the fringe's middle, the bank's top, its foot and its toe.
 */
export function vergeSection(v: Verge): [number, number][] {
  return [
    [v.half, SURFACE],
    [(v.half + v.top) / 2, SURFACE - RAISED_FRINGE_DROP / 2],
    [v.top, SURFACE - RAISED_FRINGE_DROP],
    [v.foot, -v.lift],
    [v.foot + BANK_TOE, -v.lift - RAISE_LOW - 0.03],
  ];
}

/** A road's raised verge, or null when it lies flush (no lift, a sidewalk, no fringe, a town's). */
export function roadVerge(road: TerrainRoad, spacing: number, walk = 0): Verge | null {
  if (road.town !== undefined) return null;
  const section = sectionOf(road);
  const fringe = walk > 0 ? 0 : shoulderOf(road);
  const lift = liftOf(section, walk, fringe);
  return lift > 0 ? vergeOf(section.half, fringe, lift, section.verge.bank, spacing) : null;
}
