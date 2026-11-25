import type { TerrainData } from "./data";
import { mulberry32 } from "./noise";
import { nodeAt } from "./network";
import type { StreetClass, TerrainRoad } from "./roads";

/**
 * A town's streets, laid the way a small American town grew: a main street - the road through
 * town, wide, with parking and broad sidewalks - with a downtown grid round its middle (side
 * streets off it at uneven spacing and slight angles, a back street a block out each side gently
 * curved, a delivery alley behind the shops), and round that the newer parts: curving collector
 * streets that loop out and back, crescents, cul-de-sacs ending in a round turnaround, streets
 * that bend along the hill where the ground is hilly. A city gets a second main street across the
 * first and a bigger grid; a village is a main street, a back street and a few curving residential
 * streets. Where roads out of town are known (`exits`), the main street runs out toward them, so
 * the country road arrives along it, and any other exit gets a street of its own out to the edge.
 *
 * How a town grows is its {@link TownCharacter} (chosen by the world generator from its size, its
 * roads and its ground) and four knobs: how curvy its suburbs are, how many cul-de-sacs, how much
 * of its area is built up, how big its downtown grid is.
 *
 * A plan is nodes and streets between them; {@link layTownStreets} puts it on a terrain as roads
 * (`kind: "street"` with a class) joined at nodes, a cul-de-sac's end node with its bulb.
 * Deterministic for a seed. Three-free and pure.
 */

/**
 * What kind of town it is:
 * - `city`: a big downtown grid, a cross main street, alleys, suburbs of loops and cul-de-sacs;
 * - `crossroads`: two roads meet in the middle: a small grid round the crossing, a street out each way;
 * - `hill`: on hilly ground: a short main street, residential streets following the contours;
 * - `river`: beside water: built up on the far side from it, the near side left open;
 * - `village`: a main street, a back street on one side, a few curving streets and cul-de-sacs.
 */
export type TownCharacter = "city" | "crossroads" | "hill" | "river" | "village";
export const TOWN_CHARACTERS: readonly TownCharacter[] = ["city", "crossroads", "hill", "river", "village"];

/** The knobs, 0..1. */
export interface TownKnobs {
  /** How much the residential streets bend and wander. */
  curvy: number;
  /** How many residential streets end in a cul-de-sac (rather than loop back). */
  culdesacs: number;
  /** How much of the area round the downtown is built up with streets. */
  density: number;
  /** How big the downtown grid is, as a share of the town. */
  core: number;
}

/** Each character's knobs when none are given. */
export const TOWN_CHARACTER_KNOBS: Record<TownCharacter, TownKnobs> = {
  city: { curvy: 0.5, culdesacs: 0.45, density: 0.85, core: 0.55 },
  crossroads: { curvy: 0.55, culdesacs: 0.55, density: 0.7, core: 0.32 },
  hill: { curvy: 0.85, culdesacs: 0.6, density: 0.65, core: 0.24 },
  river: { curvy: 0.6, culdesacs: 0.5, density: 0.65, core: 0.34 },
  village: { curvy: 0.65, culdesacs: 0.6, density: 0.65, core: 0.3 },
};

export interface TownPlanSettings extends Partial<TownKnobs> {
  /** The area it is laid in, metres east-west and north-south (the ground levelled for it). */
  width: number;
  depth: number;
  /** About how far apart side streets are along the main street, metres. */
  block: number;
  /** 0..1: how much the downtown streets wander off square and the back streets bend. */
  irregular: number;
  seed: number;
  /**
   * Seeds where the town's middle sits (a few metres off the area's centre), apart from `seed`, so
   * a town re-rolled with a new seed keeps its main street's ends where its roads join. Default `seed`.
   */
  frameSeed?: number;
  /**
   * Which ways roads leave the town (radians, `atan2(dz, dx)`): the main street runs out along the
   * first, and out the far end along one roughly opposite if there is one. None: a direction of
   * its own (from the seed).
   */
  exits?: number[];
  /** A second main street across the first, at the middle. Default: for a city. */
  crossStreet?: boolean;
  /**
   * The way the main street runs (radians, `atan2(dz, dx)`), the area turned with it: `width`
   * along it, `depth` across. Omitted: the area is square to the world, the main street toward the
   * first exit.
   */
  angle?: number;
  /** Default: a city when `crossStreet`, else a village. */
  character?: TownCharacter;
  /**
   * The ground as it was before the town was levelled: a hill town's residential streets follow its
   * contours. Omitted: they wander on their own.
   */
  ground?: (x: number, z: number) => number;
  /** A river town's side of the main street facing the water (+1 or -1 across it): left open. */
  openSide?: 1 | -1;
  /** Told why each street it tried was not laid (for tuning). */
  debug?: (why: string) => void;
}

export interface PlannedStreet {
  /** Indices into the plan's `nodes`. */
  a: number;
  b: number;
  /** Points it bends through between them. */
  via?: [number, number][];
  class: StreetClass;
}

export interface TownStreetPlan {
  nodes: [number, number][];
  streets: PlannedStreet[];
  /** Where a road out of town should join: one per exit asked for (in order), the node and its direction out. */
  exits: { node: number; angle: number }[];
  /** Cul-de-sacs: each dead end's node and its turnaround's radius. */
  bulbs: { node: number; radius: number }[];
}

/** Metres kept between the streets' nodes and the edge of the area. */
const MARGIN = 10;
/** Nodes closer than this are one. */
const MERGE = 14;
/**
 * Along the main street: a side street ending this near one already there meets it (a crossroads),
 * and one ending nearer than `MAIN_GAP` is left out, so every block of the main street is long
 * enough for its turn lanes (see `lanes.ts`) and the blocks beside it simply run on.
 */
const MAIN_MERGE = 20;
const MAIN_GAP = 46;
/** A cul-de-sac's turnaround radius, kerb to node. */
export const BULB_RADIUS = 12;
/** Least metres between a residential street and another it does not meet: room for a lot each side. */
const SUBURB_CLEAR = 46;
/** Least metres from a cul-de-sac's node to a street it does not meet: houses round the bulb. */
const BULB_CLEAR = 40;

type P = [number, number];

interface Candidate extends PlannedStreet {
  rank: number;
}

/** Lays a town's streets out round a point. See the file's comment. */
export function planTownStreets(centre: { x: number; z: number }, settings: TownPlanSettings): TownStreetPlan {
  const character = settings.character ?? (settings.crossStreet ? "city" : "village");
  const knobs = TOWN_CHARACTER_KNOBS[character];
  const clamp = (v: number | undefined, d: number): number => Math.min(1, Math.max(0, v ?? d));
  const curvy = clamp(settings.curvy, knobs.curvy);
  const culdesacs = clamp(settings.culdesacs, knobs.culdesacs);
  const density = clamp(settings.density, knobs.density);
  const coreShare = clamp(settings.core, knobs.core);
  const frameRng = mulberry32((settings.frameSeed ?? settings.seed) * 7919 + 101);
  const rng = mulberry32(settings.seed * 6271 + 37);
  const irr = Math.min(1, Math.max(0, settings.irregular));
  const hw = settings.width / 2 - MARGIN;
  const hd = settings.depth / 2 - MARGIN;
  // The main street's line: along `angle` (the area turned with it), else toward the first exit.
  const exits = settings.exits ?? [];
  const along = settings.angle ?? (exits.length ? exits[0]! : frameRng() * Math.PI);
  // The area's own X: turned with the main street when an angle is given, else east.
  const ax = settings.angle !== undefined ? Math.cos(along) : 1;
  const az = settings.angle !== undefined ? Math.sin(along) : 0;
  /** In the area (`grow` metres larger, or smaller when negative): its rectangle with the corners rounded off. */
  const inside = (x: number, z: number, grow = 0): boolean => {
    const dx = x - centre.x;
    const dz = z - centre.z;
    const lx = Math.abs(dx * ax + dz * az) / (hw + grow);
    const lz = Math.abs(-dx * az + dz * ax) / (hd + grow);
    return lx <= 1 && lz <= 1 && lx ** 6 + lz ** 6 <= 1;
  };
  /** How far from (x, z) along a direction until the area's edge. */
  const reach = (x: number, z: number, dx: number, dz: number, grow = 0): number => {
    let lo = 0;
    let hi = Math.hypot(settings.width, settings.depth);
    if (!inside(x, z, grow)) return 0;
    for (let k = 0; k < 30; k++) {
      const mid = (lo + hi) / 2;
      if (inside(x + dx * mid, z + dz * mid, grow)) lo = mid;
      else hi = mid;
    }
    return lo;
  };
  const nodes: P[] = [];
  const add = (x: number, z: number): number => {
    nodes.push([x, z]);
    return nodes.length - 1;
  };
  const candidates: Candidate[] = [];
  const street = (a: number, b: number, cls: StreetClass, rank: number, via?: P[]): void => {
    if (a === b) return;
    candidates.push({ a, b, class: cls, rank, ...(via?.length ? { via } : {}) });
  };

  // Out the far side toward an exit roughly opposite, if there is one.
  const opposite = exits.slice(1).find((a) => Math.abs(Math.atan2(Math.sin(a - along - Math.PI), Math.cos(a - along - Math.PI))) < 0.8);
  const ux = Math.cos(along);
  const uz = Math.sin(along);
  // Across it: v.
  const vx = -uz;
  const vz = ux;
  const mx = centre.x + (frameRng() - 0.5) * settings.width * 0.06 * irr;
  const mz = centre.z + (frameRng() - 0.5) * settings.depth * 0.06 * irr;
  /** A point of the town's frame (u along the main street, v across it) in the world. */
  const world = (u: number, v: number): P => [mx + ux * u + vx * v, mz + uz * u + vz * v];
  /** A world point in the town's frame. */
  const frame = (p: P): P => [(p[0] - mx) * ux + (p[1] - mz) * uz, (p[0] - mx) * vx + (p[1] - mz) * vz];
  // The frame's extent over the area.
  let u0 = Infinity;
  let u1 = -Infinity;
  let v0 = Infinity;
  let v1 = -Infinity;
  for (const [lx, lz] of [
    [-hw, -hd],
    [hw, -hd],
    [hw, hd],
    [-hw, hd],
  ] as const) {
    const cx = lx * ax - lz * az;
    const cz = lx * az + lz * ax;
    const u = (centre.x + cx - mx) * ux + (centre.z + cz - mz) * uz;
    const v = (centre.x + cx - mx) * vx + (centre.z + cz - mz) * vz;
    u0 = Math.min(u0, u);
    u1 = Math.max(u1, u);
    v0 = Math.min(v0, v);
    v1 = Math.max(v1, v);
  }
  // Where the main street leaves the area each way.
  const mainEnd = [reach(mx, mz, -ux, -uz), reach(mx, mz, ux, uz)] as const;
  const tier = settings.block * 0.85;
  /** The downtown grid's half length along the main street. */
  const cu = Math.max(settings.block * 0.5, MAIN_GAP * 0.6, Math.min(mainEnd[0], mainEnd[1]) * Math.min(0.9, 0.12 + coreShare * 0.62));
  /** The crossing exit, for a crossroads: an exit near square to the main street, its side (+1 or -1 across). */
  const extra = exits.slice(1).filter((a) => a !== opposite);
  const crossing = extra.find((a) => Math.abs(Math.cos(a - along)) < 0.6);
  const crossSide = crossing === undefined ? 0 : Math.sin(crossing - along) > 0 ? 1 : -1;
  const crossStreet = settings.crossStreet ?? character === "city";

  // Rows: the main street (v = 0) and back streets parallel to it a block apart, each its own
  // wobble, over the downtown grid's length. How many each side: by the grid's size; a village's
  // or a hill town's one side only, a river town's none on the water's side.
  const oneSide = character === "hill" || character === "river" || (character === "village" && rng() < 0.6);
  const quietSide: 1 | -1 = settings.openSide ?? (rng() < 0.5 ? 1 : -1);
  const tiersOn = (side: 1 | -1): number => {
    if (settings.openSide === side) return 0;
    if (oneSide && side === quietSide) return 0;
    return coreShare >= 0.5 ? 2 : 1;
  };
  const rows: number[] = [0];
  for (let v = 0, n = tiersOn(1); n > 0; n--) {
    v += tier * (0.88 + rng() * 0.26);
    if (v > v1 - tier * 0.3) break;
    rows.push(v);
  }
  for (let v = 0, n = tiersOn(-1); n > 0; n--) {
    v -= tier * (0.88 + rng() * 0.26);
    if (v < v0 + tier * 0.3) break;
    rows.unshift(v);
  }
  const mainRow = rows.indexOf(0);
  /** Each row's wobble across, as a function of u: a slow wave, so a back street curves gently. */
  const waves = rows.map((_, k) =>
    k === mainRow
      ? // The main street's own gentle bend is the frame's: its ends stay put when the town is re-rolled.
        { a: character === "city" ? 0 : (frameRng() - 0.5) * 6 * curvy, f: 0.004 + frameRng() * 0.004, p: frameRng() * 6 }
      : { a: (rng() - 0.3) * (6 + 10 * curvy) * irr, f: 0.006 + rng() * 0.01, p: rng() * 6 },
  );
  const rowV = (k: number, u: number): number => rows[k]! + waves[k]!.a * Math.sin(u * waves[k]!.f + waves[k]!.p);
  /** Per row, its nodes: u along and the node. */
  const onRow: { u: number; node: number }[][] = rows.map(() => []);
  /** Each back row's half length along u: a little shorter the further out. */
  // The two back streets either side of the main street the same length, so the grid's ends
  // cross the main street together.
  const nearHalf = cu * (0.92 + rng() * 0.16);
  const rowHalf = rows.map((_, k) => (k === mainRow ? Infinity : Math.abs(k - mainRow) === 1 ? nearHalf : cu * (1 - 0.3 * (Math.abs(k - mainRow) - 1)) * (0.92 + rng() * 0.16)));
  // Where side streets meet the main street through the grid: the same for both sides (crossroads,
  // as a downtown grid has), never closer than its junctions may be.
  const mainCount = Math.max(1, Math.min(Math.round((nearHalf * 2) / (settings.block * 0.95)), Math.floor((nearHalf * 2) / (MAIN_GAP + 4))));
  const mainSpacing = (nearHalf * 2) / mainCount;
  const mainJitter = Math.min(mainSpacing * 0.35 * (0.4 + irr), Math.max(0, mainSpacing - MAIN_GAP - 1));
  const mainSpots: number[] = [];
  for (let i = 0; i <= mainCount; i++) mainSpots.push(-nearHalf + mainSpacing * i + (i === 0 || i === mainCount ? 0 : (rng() - 0.5) * mainJitter));
  if (crossStreet || crossSide !== 0) {
    const nearest = mainSpots.reduce((best, x, i) => (Math.abs(x) < Math.abs(mainSpots[best] ?? Infinity) ? i : best), 0);
    if (nearest > 0 && nearest < mainSpots.length - 1) mainSpots[nearest] = 0;
  }
  const exitNodes: { node: number; angle: number }[] = [];
  /** Onto a node already on a row when one is near (a crossroads), else a new one far enough from the others for a block between. */
  const onto = (row: number, u: number, at: P): number | null => {
    const [merge, gap] = row === mainRow ? [MAIN_MERGE, MAIN_GAP] : [12, 24];
    const near = onRow[row]!.filter((one) => Math.abs(one.u - u) < gap).sort((p, q) => Math.abs(p.u - u) - Math.abs(q.u - u))[0];
    if (near) return Math.abs(near.u - u) < merge ? near.node : null;
    const node = add(at[0], at[1]);
    onRow[row]!.push({ u, node });
    return node;
  };
  // Alleys behind the shops on the main street: a lane in the block either side, parallel to it,
  // between side streets, where the block is deep enough for the shops and something behind.
  const alleyChance = character === "city" ? 0.75 : character === "crossroads" ? 0.5 : 0.35;
  const alleyV = Math.min(33, tier * 0.55);

  for (let k = 0; k + 1 < rows.length; k++) {
    const nextToMain = k === mainRow || k + 1 === mainRow;
    const half = Math.min(rowHalf[k]!, rowHalf[k + 1]!);
    // Side streets in this band: the grid's two ends, and between them at uneven spacing (each
    // band its own, so side streets either side of a back street do not line up).
    // Next to the main street, never closer than its junctions may be.
    const count = Math.max(1, Math.round((half * 2) / (settings.block * 1.1)));
    const spacing = (half * 2) / count;
    const spots: number[] = [];
    if (nextToMain) spots.push(...mainSpots);
    else for (let i = 0; i <= count; i++) spots.push(-half + spacing * i + (i === 0 || i === count ? 0 : (rng() - 0.5) * spacing * 0.35 * (0.4 + irr)));
    // The cross street at the middle, through every band (a crossroads': through those on its side).
    const crossHere = crossStreet || (crossSide > 0 && k >= mainRow) || (crossSide < 0 && k + 1 <= mainRow);
    if (crossHere && spots.length > 2 && !nextToMain) {
      const nearest = spots.reduce((best, s, i) => (Math.abs(s) < Math.abs(spots[best] ?? Infinity) ? i : best), 0);
      if (nearest > 0 && nearest < spots.length - 1) spots[nearest] = 0;
    }
    const sides: { ua: number; ub: number; a: P; b: P; cross: boolean }[] = [];
    for (const su of spots) {
      const cross = crossHere && su === 0;
      // Slanted: its two ends a little apart along u.
      const end = Math.abs(Math.abs(su) - half) < 1;
      const slant = cross ? 0 : (rng() - 0.5) * (end ? 8 : 20) * irr;
      // Next to the main street, its end on the main street exactly at the spot (the other side's
      // side street meets it there too), the slant all at its far end.
      const wob = (rng() - 0.5) * 3 * irr;
      const ua = nextToMain ? (k === mainRow ? su : su - slant + wob) : su - slant / 2 + wob;
      const ub = nextToMain ? (k === mainRow ? su + slant + wob : su) : su + slant / 2 + (rng() - 0.5) * 3 * irr;
      const a = world(ua, rowV(k, ua));
      const b = world(ub, rowV(k + 1, ub));
      if (!inside(a[0], a[1]) || !inside(b[0], b[1])) continue;
      // Now and then left out (two blocks become one), never next to the main street.
      if (!cross && !end && rng() < 0.08 * irr && !nextToMain) continue;
      sides.push({ ua, ub, a, b, cross });
    }
    // Alleys: which pairs of neighbouring side streets get one between them.
    const alleyAt = new Set<number>();
    const alleyRow = k === mainRow ? k + 1 : k;
    const mainSide = k === mainRow ? 1 : -1;
    if (nextToMain && Math.abs(rows[alleyRow]!) - alleyV > 22 && character !== "hill") for (let i = 0; i + 1 < sides.length; i++) if (rng() < alleyChance) alleyAt.add(i);
    const mids = new Map<number, number>();
    sides.forEach((one, i) => {
      const na = onto(k, one.ua, one.a);
      const nb = na === null ? null : onto(k + 1, one.ub, one.b);
      if (na === null || nb === null) return;
      const cls: StreetClass = one.cross ? "main" : "local";
      const rank = nextToMain ? 1 : 2;
      if (!one.cross && (alleyAt.has(i) || alleyAt.has(i - 1))) {
        // Split where the alley meets it.
        const fa = frame(nodes[na]!);
        const fb = frame(nodes[nb]!);
        const t = (mainSide * alleyV - fa[1]) / (fb[1] - fa[1]);
        if (t > 0.25 && t < 0.75) {
          const mid = add(nodes[na]![0] + (nodes[nb]![0] - nodes[na]![0]) * t, nodes[na]![1] + (nodes[nb]![1] - nodes[na]![1]) * t);
          mids.set(i, mid);
          street(na, mid, cls, rank);
          street(mid, nb, cls, rank);
          return;
        }
      }
      street(na, nb, cls, rank);
    });
    for (const i of alleyAt) {
      const p = mids.get(i);
      const q = mids.get(i + 1);
      if (p !== undefined && q !== undefined) street(p, q, "lane", 2.5);
    }
  }

  // The main street's own two ends, out at the edge of the area.
  for (const [dir, angle] of [
    [1, along],
    [-1, opposite ?? along + Math.PI],
  ] as const) {
    const length = mainEnd[dir > 0 ? 1 : 0];
    const near = onRow[mainRow]!.find((one) => Math.abs(one.u - dir * length) < 24);
    const end = world(dir * length, rowV(mainRow, dir * length));
    const node = near ? near.node : add(end[0], end[1]);
    if (near) nodes[node] = end;
    else onRow[mainRow]!.push({ u: dir * length, node });
    if (exits.length && (dir === 1 || opposite !== undefined)) exitNodes.push({ node, angle });
  }
  // A crossroads: the cross street carried on out of the grid toward the crossing road, from the
  // outermost row it reaches on that side (the main street itself if there is none).
  let crossSpine: { node: number; side: 1 | -1 } | null = null;
  if (crossing !== undefined && !crossStreet) {
    let outer = mainRow;
    for (let k = 0; k < rows.length; k++) if (Math.sign(rows[k]!) === crossSide && Math.abs(rows[k]!) > Math.abs(rows[outer]!)) outer = k;
    const near = onRow[outer]!.filter((one) => Math.abs(one.u) < 30).sort((p, q) => Math.abs(p.u) - Math.abs(q.u))[0];
    const base =
      near ??
      (() => {
        const at = world(0, rowV(outer, 0));
        const node = onto(outer, 0, at);
        return node === null ? undefined : { u: 0, node };
      })();
    if (base) crossSpine = { node: base.node, side: crossSide as 1 | -1 };
  }
  // Rows: each row's nodes joined along it in order of u, the main street wide, the others local,
  // each piece bending with its row's wave.
  rows.forEach((_, k) => {
    const list = onRow[k]!.sort((p, q) => p.u - q.u);
    for (let i = 0; i + 1 < list.length; i++) {
      const p = list[i]!;
      const q = list[i + 1]!;
      if (q.u - p.u < 14) continue;
      const via: P[] = [];
      const pieces = Math.floor((q.u - p.u) / 30);
      for (let j = 1; j <= pieces; j++) {
        const u = p.u + ((q.u - p.u) * j) / (pieces + 1);
        if (waves[k]!.a !== 0) via.push(world(u, rowV(k, u)));
      }
      street(p.node, q.node, k === mainRow ? "main" : "local", k === mainRow ? 0 : 3, via);
    }
  });

  // Accept them in order of rank, each only if it crosses nothing accepted and passes no other node
  // close by: the main street first, then the side streets, then the back streets.
  candidates.sort((p, q) => p.rank - q.rank);
  const accepted: PlannedStreet[] = [];
  const bulbs = new Map<number, number>();
  const polyline = (st: PlannedStreet): P[] => [nodes[st.a]!, ...(st.via ?? []), nodes[st.b]!];
  const used = (n: number): boolean => accepted.some((o) => o.a === n || o.b === n);
  /**
   * Whether a chain of new streets (sharing their joints) may be laid: crossing nothing, near no
   * node it does not use, at no sharp angle to a street it meets, kept `clear` metres from streets
   * it does not meet (18 m, kerb to kerb, in the downtown grid; room for lots in the suburbs), and
   * a cul-de-sac's bulb clear of every street.
   */
  const no = (why: string): false => {
    settings.debug?.(why);
    return false;
  };
  const fits = (chain: PlannedStreet[], clear: number, bulb?: number): boolean => {
    const own = new Set(chain.flatMap((st) => [st.a, st.b]));
    for (const cand of chain) {
      const line = polyline(cand);
      const length = line.slice(1).reduce((sum, p, i) => sum + Math.hypot(p[0] - line[i]![0], p[1] - line[i]![1]), 0);
      if (length < 18) return no("short");
      if (accepted.some((o) => (o.a === cand.a && o.b === cand.b) || (o.a === cand.b && o.b === cand.a))) return no("dup");
      for (const other of accepted) {
        const shared = [other.a, other.b].filter((n) => own.has(n));
        const near = shared.length ? 18 : clear;
        if (
          crosses(
            line,
            polyline(other),
            shared.map((n) => nodes[n]!),
            near,
          )
        )
          return no("crosses");
      }
      // No other node within a street's reach of it.
      for (let n = 0; n < nodes.length; n++) {
        if (own.has(n) || !used(n)) continue;
        if (distanceToLine(nodes[n]!, line) < MERGE + 4) return no("node near");
      }
      // Not at too sharp an angle to a street already at either end.
      for (const end of [cand.a, cand.b]) {
        const dir = direction(line, end === cand.a);
        for (const other of [...accepted, ...chain]) {
          if (other === cand || (other.a !== end && other.b !== end)) continue;
          const od = direction(polyline(other), other.a === end);
          if (dir[0] * od[0] + dir[1] * od[1] > Math.cos(0.75)) return no("angle");
        }
      }
    }
    if (bulb !== undefined) {
      const p = nodes[bulb]!;
      if (!inside(p[0], p[1], -(BULB_RADIUS + 6))) return no("bulb out");
      for (const other of accepted) if (distanceToLine(p, polyline(other)) < BULB_CLEAR) return no("bulb near street");
      for (const [n] of bulbs) if (Math.hypot(nodes[n]![0] - p[0], nodes[n]![1] - p[1]) < BULB_CLEAR * 1.6) return no("bulb near bulb");
    }
    return true;
  };
  for (const cand of candidates) if (fits([cand], 18)) accepted.push({ a: cand.a, b: cand.b, class: cand.class, ...(cand.via ? { via: cand.via } : {}) });
  /** Lays a chain if it fits; true if it did. */
  const lay = (chain: PlannedStreet[], clear = SUBURB_CLEAR, bulb?: number): boolean => {
    if (!fits(chain, clear, bulb)) return false;
    accepted.push(...chain);
    if (bulb !== undefined) bulbs.set(bulb, BULB_RADIUS);
    return true;
  };

  // The suburbs: residential streets out from the grid's edge and the main street beyond it.
  /** Unit direction of the ground's contour at a point (along the hill), or null on the flat. */
  const contour = (x: number, z: number): P | null => {
    if (!settings.ground) return null;
    const e = 12;
    const gx = (settings.ground(x + e, z) - settings.ground(x - e, z)) / (2 * e);
    const gz = (settings.ground(x, z + e) - settings.ground(x, z - e)) / (2 * e);
    const g = Math.hypot(gx, gz);
    return g < 0.015 ? null : [-gz / g, gx / g];
  };
  const hill = character === "hill";
  /** A frame direction as a world one. */
  const toWorld = (du: number, dv: number): P => [ux * du + vx * dv, uz * du + vz * dv];
  /** Turns a unit direction by an angle. */
  const turned = ([x, z]: P, a: number): P => [x * Math.cos(a) - z * Math.sin(a), x * Math.sin(a) + z * Math.cos(a)];
  /**
   * A residential street's way from a node: along `heading`, bending gently as it goes (along the
   * contours on a hill, else a slow steady curve), until it is `maxLength` long, nears the edge of
   * the area or nears a street it does not start from. Just the points; nothing is laid.
   */
  const trace = (from: number, heading: P, maxLength: number): { pts: P[]; length: number } => {
    const pts: P[] = [nodes[from]!];
    let [hx, hz] = heading;
    // A steady curve one way, its sharpness by the knob; a hill's contours pull harder.
    const curve = (rng() - 0.5) * 2 * curvy * 0.012;
    const step = 6;
    let length = 0;
    while (length < maxLength) {
      const [px, pz] = pts[pts.length - 1]!;
      let turn = curve * step;
      const c = hill && length > 12 ? contour(px, pz) : null;
      if (c) {
        const sign = c[0] * hx + c[1] * hz >= 0 ? 1 : -1;
        const cross = hx * c[1] * sign - hz * c[0] * sign;
        turn += Math.max(-1, Math.min(1, cross * 3)) * 0.05;
      }
      turn = Math.max(-0.09, Math.min(0.09, turn));
      [hx, hz] = turned([hx, hz], turn);
      const nx = px + hx * step;
      const nz = pz + hz * step;
      if (!inside(nx, nz, -(BULB_RADIUS + 8))) {
        settings.debug?.("trace: edge");
        break;
      }
      const block = length > 6 ? accepted.find((o) => o.a !== from && o.b !== from && closeTo(nx, nz, hx, hz, polyline(o), SUBURB_CLEAR - 2)) : undefined;
      if (block) {
        settings.debug?.(`trace: near ${block.class}`);
        break;
      }
      pts.push([nx, nz]);
      length += step;
    }
    return { pts, length };
  };
  /** Points of a traced way made into a cul-de-sac's control points: straight over its last 24 m (its bulb meets it square), the tip last. */
  const straightEnd = (pts: P[]): { via: P[]; tip: P } => {
    const back = Math.min(pts.length - 2, 4);
    const cut = pts[pts.length - 1 - back]!;
    const before = pts[pts.length - 2 - back]!;
    const hl = Math.hypot(cut[0] - before[0], cut[1] - before[1]) || 1;
    const hx = (cut[0] - before[0]) / hl;
    const hz = (cut[1] - before[1]) / hl;
    const on = back * 6;
    const via = [...thin(pts.slice(1, pts.length - 1 - back), 12).filter((q) => Math.hypot(q[0] - cut[0], q[1] - cut[1]) > 8), cut, [cut[0] + hx * on * 0.5, cut[1] + hz * on * 0.5] as P];
    return { via, tip: [cut[0] + hx * on, cut[1] + hz * on] };
  };
  /** A cul-de-sac from a node: laid if it fits, at least `least` metres long. Its bulb's node, or null. */
  const culdesac = (from: number, heading: P, maxLength: number, least = 46): number | null => {
    const { pts, length } = trace(from, heading, maxLength);
    if (length < least) {
      settings.debug?.(`cul-de-sac too short (${length.toFixed(0)} m)`);
      return null;
    }
    const { via, tip: at } = straightEnd(pts);
    const tip = add(at[0], at[1]);
    if (!lay([{ a: from, b: tip, class: "local", via }], SUBURB_CLEAR, tip)) {
      nodes.pop();
      return null;
    }
    return tip;
  };
  /**
   * A court: a longer street from a node ending in a cul-de-sac, with a node half way along it
   * and a shorter cul-de-sac off that to one side. Laid if the trunk fits.
   */
  const court = (from: number, heading: P, maxLength: number): boolean => {
    const { pts, length } = trace(from, heading, maxLength);
    if (length < 90) return culdesac(from, heading, maxLength) !== null;
    const { via, tip: at } = straightEnd(pts);
    // The node half way: a point of the traced way.
    const half = Math.floor(pts.length / 2);
    const mid = add(pts[half]![0], pts[half]![1]);
    const tip = add(at[0], at[1]);
    const first = thin(pts.slice(1, half), 12).filter((q) => Math.hypot(q[0] - pts[half]![0], q[1] - pts[half]![1]) > 8);
    const second = via.filter((q) => pointIndex(pts, q) > half + 1 || !pts.includes(q));
    if (
      !lay(
        [
          { a: from, b: mid, class: "local", ...(first.length ? { via: first } : {}) },
          { a: mid, b: tip, class: "local", ...(second.length ? { via: second } : {}) },
        ],
        SUBURB_CLEAR,
        tip,
      )
    ) {
      nodes.length -= 2;
      return false;
    }
    // Off to one side from the middle: the side with more room, else the other.
    const p = pts[half]!;
    const q = pts[Math.min(pts.length - 1, half + 1)]!;
    const d = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
    const tx = (q[0] - p[0]) / d;
    const tz = (q[1] - p[1]) / d;
    const sides: P[] = [
      [-tz, tx],
      [tz, -tx],
    ];
    sides.sort((a, b) => reach(p[0], p[1], b[0], b[1]) - reach(p[0], p[1], a[0], a[1]));
    for (const side of sides) {
      const room = reach(p[0], p[1], side[0], side[1]);
      if (room < 70) continue;
      if (culdesac(mid, turned(side, (rng() - 0.5) * 0.4), Math.min(80, room - 22)) !== null) break;
    }
    return true;
  };
  /**
   * A loop out and back (a crescent): from node a out along `out` (world, unit), round, and back
   * in to node b along it; split at its far side so cul-de-sacs can leave it. Laid if it fits.
   * Returns its far nodes with their outward directions, or null.
   */
  const loop = (a: number, b: number, out: P, depth: number): { node: number; out: P }[] | null => {
    const A = nodes[a]!;
    const B = nodes[b]!;
    const span = Math.hypot(B[0] - A[0], B[1] - A[1]);
    const ax2 = (B[0] - A[0]) / span;
    const az2 = (B[1] - A[1]) / span;
    const wob = (rng() - 0.5) * span * 0.3 * curvy;
    const skew = (rng() - 0.5) * depth * 0.45 * curvy;
    const c1: P = [A[0] + out[0] * (depth * 1.33 + skew) + ax2 * (wob - span * 0.08), A[1] + out[1] * (depth * 1.33 + skew) + az2 * (wob - span * 0.08)];
    const c2: P = [B[0] + out[0] * (depth * 1.33 - skew) + ax2 * (wob + span * 0.08), B[1] + out[1] * (depth * 1.33 - skew) + az2 * (wob + span * 0.08)];
    const steps = 48;
    const pts: P[] = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const s = 1 - t;
      const k0 = s * s * s;
      const k1 = 3 * s * s * t;
      const k2 = 3 * s * t * t;
      const k3 = t * t * t;
      pts.push([k0 * A[0] + k1 * c1[0] + k2 * c2[0] + k3 * B[0], k0 * A[1] + k1 * c1[1] + k2 * c2[1] + k3 * B[1]]);
    }
    if (pts.some((p) => !inside(p[0], p[1], -12))) {
      settings.debug?.("loop: out of area");
      return null;
    }
    const lengthAt: number[] = [0];
    for (let i = 1; i <= steps; i++) lengthAt.push(lengthAt[i - 1]! + Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]));
    const total = lengthAt[steps]!;
    const splits = total > 270 ? [0.36, 0.64] : total > 170 ? [0.5] : [];
    const cut = splits.map((f) => lengthAt.findIndex((l) => l >= total * f));
    const ids: number[] = [a];
    const made: number[] = [];
    for (const i of cut) {
      const id = add(pts[i]![0], pts[i]![1]);
      ids.push(id);
      made.push(id);
    }
    ids.push(b);
    const bounds = [0, ...cut, steps];
    const chain: PlannedStreet[] = [];
    for (let k = 0; k + 1 < ids.length; k++) {
      const via = thin(pts.slice(bounds[k]! + 1, bounds[k + 1]!), 12);
      chain.push({ a: ids[k]!, b: ids[k + 1]!, class: "local", ...(via.length ? { via } : {}) });
    }
    if (!lay(chain)) {
      nodes.length -= made.length;
      return null;
    }
    return cut.map((i, k) => {
      const p = pts[i]!;
      const q = pts[Math.min(steps, i + 1)]!;
      const d = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
      let o: P = [(q[1] - p[1]) / d, -(q[0] - p[0]) / d];
      if (o[0] * out[0] + o[1] * out[1] < 0) o = [-o[0], -o[1]];
      return { node: made[k]!, out: o };
    });
  };
  /** Degree of a node among the accepted streets. */
  const degree = (n: number): number => accepted.reduce((c, st) => c + (st.a === n ? 1 : 0) + (st.b === n ? 1 : 0), 0);
  /**
   * A node on an accepted street at a point of it: the street split there in two. Returns the node
   * and how to put the street back as it was.
   */
  const splitAt = (a: number, b: number, at: P): { node: number; undo: () => void } | null => {
    const i = accepted.findIndex((st) => (st.a === a && st.b === b) || (st.a === b && st.b === a));
    if (i < 0) return null;
    const st = accepted[i]!;
    const line = polyline(st);
    // The nearest segment to the point.
    let best = { k: 0, d: Infinity };
    for (let k = 0; k + 1 < line.length; k++) {
      const d = distanceToLine(at, [line[k]!, line[k + 1]!]);
      if (d < best.d) best = { k, d };
    }
    const node = add(at[0], at[1]);
    const via1 = line.slice(1, best.k + 1).filter((q) => Math.hypot(q[0] - at[0], q[1] - at[1]) > 6);
    const via2 = line.slice(best.k + 1, -1).filter((q) => Math.hypot(q[0] - at[0], q[1] - at[1]) > 6);
    const one: PlannedStreet = { a: st.a, b: node, class: st.class, ...(via1.length ? { via: via1 } : {}) };
    const two: PlannedStreet = { a: node, b: st.b, class: st.class, ...(via2.length ? { via: via2 } : {}) };
    accepted.splice(i, 1, one, two);
    return {
      node,
      undo: () => {
        const j = accepted.indexOf(one);
        accepted.splice(j, 2, st);
        if (nodes.length - 1 === node) nodes.pop();
      },
    };
  };
  /**
   * A run of accepted streets end to end through these nodes, as one path: how far along each node
   * is, and where along it a distance is (the point, its direction, the street it is on).
   */
  const pathThrough = (seq: number[]) => {
    const pts: P[] = [];
    const at: number[] = [];
    let s = 0;
    const pieces: { a: number; b: number; s0: number; s1: number }[] = [];
    for (let k = 0; k + 1 < seq.length; k++) {
      const st = accepted.find((o) => (o.a === seq[k] && o.b === seq[k + 1]) || (o.b === seq[k] && o.a === seq[k + 1]));
      if (!st) return null;
      const line = st.a === seq[k] ? polyline(st) : [...polyline(st)].reverse();
      const s0 = s;
      if (k === 0) {
        pts.push(line[0]!);
        at.push(0);
      }
      for (let i = 1; i < line.length; i++) {
        s += Math.hypot(line[i]![0] - line[i - 1]![0], line[i]![1] - line[i - 1]![1]);
        pts.push(line[i]!);
      }
      at.push(s);
      pieces.push({ a: seq[k]!, b: seq[k + 1]!, s0, s1: s });
    }
    if (pieces.length === 0) return null;
    const point = (d: number): { p: P; t: P; piece: (typeof pieces)[number] } => {
      let acc = 0;
      for (let i = 1; i < pts.length; i++) {
        const len = Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
        if (acc + len >= d || i === pts.length - 1) {
          const f = len > 0 ? Math.max(0, Math.min(1, (d - acc) / len)) : 0;
          const p: P = [pts[i - 1]![0] + (pts[i]![0] - pts[i - 1]![0]) * f, pts[i - 1]![1] + (pts[i]![1] - pts[i - 1]![1]) * f];
          const t: P = [(pts[i]![0] - pts[i - 1]![0]) / (len || 1), (pts[i]![1] - pts[i - 1]![1]) / (len || 1)];
          return { p, t, piece: pieces.find((one) => d >= one.s0 - 1e-6 && d <= one.s1 + 1e-6) ?? pieces[pieces.length - 1]! };
        }
        acc += len;
      }
      return { p: pts[0]!, t: [1, 0], piece: pieces[0]! };
    };
    return { length: s, at, point };
  };
  /**
   * Residential streets off one side of a run of streets (the grid's outer back street, or the
   * main street past the grid): every so often along it, room allowing, a crescent, a court or a
   * cul-de-sac out to that side. Junctions on it are kept `gap` metres apart.
   */
  const frontier = (seq: number[], side: P, gap: number): void => {
    let path = pathThrough(seq);
    /** Metres kept from the run's ends where nothing else meets it (a road out of town comes in there). */
    const endGap = Math.min(gap, 30);
    if (!path || path.length < endGap * 2 + 10) return;
    /** How far along a node of the run is. */
    const along = (n: number): number => path!.at[seq.indexOf(n)]!;
    /** Whether a node of the run is a junction: its ends, or a street off it. */
    const junction = (n: number, k: number): boolean => k === 0 || k === seq.length - 1 || degree(n) > 2;
    /** Whether a distance along is clear of the run's junctions. */
    const clearAt = (d: number): boolean => seq.every((n, k) => !junction(n, k) || Math.abs(path!.at[k]! - d) >= ((k === 0 || k === seq.length - 1) && degree(n) <= 1 ? endGap : gap));
    /** A junction of the run with one street off it to the other side: one this side makes it a crossroads. */
    const crossable = (n: number): P | null => {
      const k = seq.indexOf(n);
      if (k <= 0 || k >= seq.length - 1 || degree(n) !== 3) return null;
      const off = accepted.find((st) => (st.a === n || st.b === n) && st.a !== seq[k - 1] && st.b !== seq[k - 1] && st.a !== seq[k + 1] && st.b !== seq[k + 1]);
      if (!off) return null;
      const dir = direction(polyline(off), off.a === n);
      // It leaves to the other side: carry it on through, out this side.
      return dir[0] * side[0] + dir[1] * side[1] < -0.5 ? [-dir[0], -dir[1]] : null;
    };
    /** A way in at a distance along: a crossable junction there, or the run split there. */
    const entrance = (d: number, reuse?: number): { node: number; out: P; undo: () => void } | null => {
      if (reuse !== undefined) {
        const out = crossable(reuse);
        return out ? { node: reuse, out, undo: () => {} } : null;
      }
      if (!clearAt(d)) return null;
      const { p, t, piece } = path!.point(d);
      let out: P = [-t[1], t[0]];
      if (out[0] * side[0] + out[1] * side[1] < 0) out = [-out[0], -out[1]];
      const made = splitAt(piece.a, piece.b, p);
      if (!made) return null;
      seq.splice(seq.indexOf(piece.b), 0, made.node);
      return {
        node: made.node,
        out,
        undo: () => {
          made.undo();
          seq.splice(seq.indexOf(made.node), 1);
        },
      };
    };
    /** A crossable junction within `within` metres of a distance along. */
    const crossableNear = (d: number, within: number): number | undefined => seq.find((n) => crossable(n) !== null && Math.abs(along(n) - d) < within);
    const chance = 0.35 + 0.65 * density;
    let d = endGap;
    while (path && d < path.length - endGap) {
      const reuse = crossableNear(d + 6, 6);
      const at = reuse !== undefined ? along(reuse) : d;
      if ((reuse === undefined && !clearAt(at)) || rng() > chance) {
        d += reuse !== undefined ? 14 : 6;
        continue;
      }
      const roll = rng();
      let done = 0;
      // A crescent: two ways in along the run, out and round between them.
      if (!hill && roll < (1 - culdesacs) * 0.75) {
        const span = 62 + rng() * 80;
        const reuse2 = crossableNear(at + span, 20);
        const at2 = reuse2 !== undefined ? along(reuse2) : at + span;
        settings.debug?.(at2 >= path.length - endGap ? "crescent: past end" : reuse2 === undefined && !clearAt(at2) ? "crescent: far end at a junction" : "crescent: try");
        if (at2 < path.length - endGap && (reuse2 !== undefined || clearAt(at2))) {
          const p0 = path.point(at);
          const p1 = path.point(at2);
          const room = Math.min(reach(p0.p[0], p0.p[1], side[0], side[1]), reach(p1.p[0], p1.p[1], side[0], side[1]));
          const depth = Math.min(105, room - 30) * (0.72 + rng() * 0.28);
          if (depth < 40) settings.debug?.("crescent: no room");
          if (depth >= 40) {
            // The far way in first, so the near distance still points where it did.
            const b = entrance(at2, reuse2);
            path = pathThrough(seq);
            const a = b && path ? entrance(at, reuse) : null;
            const far = a && b ? loop(a.node, b.node, side, depth) : null;
            if (far) {
              for (const one of far) {
                const room2 = reach(nodes[one.node]![0], nodes[one.node]![1], one.out[0], one.out[1]);
                if (room2 > 70 && rng() < 0.4 + culdesacs * 0.5) culdesac(one.node, turned(one.out, (rng() - 0.5) * 0.4 * curvy), Math.min(90, room2 - 22));
              }
              done = at2 - d + 30;
            } else {
              a?.undo();
              b?.undo();
            }
            path = pathThrough(seq);
          }
        }
      }
      if (!done && path) {
        // A court or a cul-de-sac.
        const p0 = path.point(at);
        const room = reach(p0.p[0], p0.p[1], side[0], side[1]);
        if (room > 62) {
          const a = entrance(at, reuse);
          if (a) {
            const heading = turned(a.out, (rng() - 0.5) * 0.5 * curvy);
            const long = hill ? 100 + rng() * 110 : roll > 0.45 + culdesacs * 0.2 ? 105 + rng() * 60 : 50 + rng() * 50;
            const ok = long > 100 ? court(a.node, heading, Math.min(long, room - 18)) : culdesac(a.node, heading, Math.min(long, room - 18)) !== null;
            if (ok) done = at - d + 50 + rng() * 25;
            else a.undo();
          }
          path = pathThrough(seq);
        }
      }
      d += done || 8;
    }
  };

  // Other exits: from a node near their way, straight out to the edge; the first such street that
  // fits, else the road comes in at the nearest node.
  for (const angle of extra) {
    if (crossSpine && angle === crossing) continue;
    const dx = Math.cos(angle);
    const dz = Math.sin(angle);
    const choices: { node: number; score: number }[] = [];
    for (let n = 0; n < nodes.length; n++) {
      if (!used(n)) continue;
      const [x, z] = nodes[n]!;
      const out = (x - centre.x) * dx + (z - centre.z) * dz;
      const side = Math.abs(-(x - centre.x) * dz + (z - centre.z) * dx);
      choices.push({ node: n, score: -out + side * 0.6 });
    }
    choices.sort((p, q) => p.score - q.score);
    let done = false;
    for (const { node } of choices.slice(0, 6)) {
      const [x, z] = nodes[node]!;
      const length = reach(x, z, dx, dz);
      if (length < 15) {
        exitNodes.push({ node, angle });
        done = true;
        break;
      }
      const end = add(x + dx * length, z + dz * length);
      if (lay([{ a: node, b: end, class: "main" }], 18)) {
        exitNodes.push({ node: end, angle });
        done = true;
        break;
      }
      nodes.pop();
    }
    if (!done && choices.length) exitNodes.push({ node: choices[0]!.node, angle });
  }

  // The crossroads' street out toward the crossing road, first, so the rest grow round it.
  if (crossSpine) {
    const [sx, sz] = nodes[crossSpine.node]!;
    const dir = toWorld(0, crossSpine.side);
    const length = reach(sx, sz, dir[0], dir[1]);
    let laidOut = false;
    if (length > 18) {
      const pts: P[] = [];
      for (let s = 12; s < length; s += 12) pts.push([sx + dir[0] * s, sz + dir[1] * s]);
      const end = add(sx + dir[0] * length, sz + dir[1] * length);
      if (lay([{ a: crossSpine.node, b: end, class: "main", ...(pts.length ? { via: thin(pts, 24) } : {}) }], 18)) {
        exitNodes.push({ node: end, angle: crossing! });
        laidOut = true;
      } else nodes.pop();
    }
    // No room for it: the road comes in where the cross street meets the grid's edge.
    if (!laidOut) exitNodes.push({ node: crossSpine.node, angle: crossing! });
  }

  /** The main street's nodes in order along it. */
  const mainSeq = (): number[] => {
    const set = new Set<number>();
    for (const st of accepted) {
      if (st.class !== "main") continue;
      for (const n of [st.a, st.b]) {
        const f = frame(nodes[n]!);
        if (Math.abs(f[1] - rowV(mainRow, f[0])) < 3) set.add(n);
      }
    }
    return [...set].sort((p, q) => frame(nodes[p]!)[0] - frame(nodes[q]!)[0]);
  };

  // Past the ends of the grid's back rows: each row swept round into the main street, or carried
  // on as a curving street out to a cul-de-sac.
  for (let k = 0; k < rows.length; k++) {
    if (k === mainRow) continue;
    const side = Math.sign(rows[k]!) as 1 | -1;
    const list = onRow[k]!.filter((one) => used(one.node));
    if (list.length === 0) continue;
    for (const end of [list[0]!, list[list.length - 1]!]) {
      const e = Math.sign(end.u) || 1;
      if (rng() > density) continue;
      const [x, z] = nodes[end.node]!;
      const dir = toWorld(e, 0);
      const room = reach(x, z, dir[0], dir[1]);
      if (room < 55) continue;
      if (rng() < 0.6 * (1 - culdesacs * 0.5)) {
        // Swept round into the main street: a node on it past the grid, a curve from the row's end
        // square into it.
        const seq = mainSeq();
        const path = pathThrough(seq);
        const fa = frame(nodes[end.node]!);
        const target = e * (Math.abs(fa[0]) + 45 + rng() * 60);
        const us = seq.map((n) => frame(nodes[n]!)[0]);
        const clear = us.every((u, i) => Math.abs(u - target) >= MAIN_GAP || (degree(seq[i]!) <= 2 && i > 0 && i < seq.length - 1));
        if (path && clear && Math.abs(target) < mainEnd[e > 0 ? 1 : 0] - 40) {
          // Its distance along the main street, which runs along u.
          const pt = path.point(target - us[0]!);
          const made = splitAt(pt.piece.a, pt.piece.b, pt.p);
          if (made) {
            const fm = frame(nodes[made.node]!);
            const du = Math.abs(fm[0] - fa[0]);
            const c1: P = [fa[0] + e * du * 0.62, fa[1]];
            const c2: P = [fm[0], fm[1] + (fa[1] - fm[1]) * 0.62];
            const pts: P[] = [];
            for (let i = 1; i < 24; i++) {
              const t = i / 24;
              const s = 1 - t;
              const fu = s * s * s * fa[0] + 3 * s * s * t * c1[0] + 3 * s * t * t * c2[0] + t * t * t * fm[0];
              const fv = s * s * s * fa[1] + 3 * s * s * t * c1[1] + 3 * s * t * t * c2[1] + t * t * t * fm[1];
              pts.push(world(fu, fv));
            }
            const via = thin(pts, 12);
            if (lay([{ a: end.node, b: made.node, class: "local", ...(via.length ? { via } : {}) }])) continue;
            made.undo();
          }
        }
      }
      const t0 = side * e * (0.2 + rng() * 0.3) * curvy;
      if (hill) court(end.node, turned(dir, t0), Math.min(170, room - 20));
      else culdesac(end.node, turned(dir, t0), Math.min(120, room - 20));
    }
  }

  // Off each side: the grid's outermost back street (else the main street through the grid), and
  // the main street past the grid both ways.
  for (const side of [1, -1] as const) {
    if (settings.openSide === side) continue;
    let outer = mainRow;
    for (let k = 0; k < rows.length; k++) if (Math.sign(rows[k]!) === side && Math.abs(rows[k]!) > Math.abs(rows[outer]!)) outer = k;
    const out = toWorld(0, side);
    if (outer !== mainRow) {
      const seq = onRow[outer]!.filter((one) => used(one.node))
        .sort((p, q) => p.u - q.u)
        .map((one) => one.node);
      frontier(seq, out, 28);
    }
    // The main street: past the grid each way, or all of it when there is no back street this side.
    const seq = mainSeq();
    const us = seq.map((n) => frame(nodes[n]!)[0]);
    if (outer === mainRow) frontier(seq, out, MAIN_GAP);
    else {
      const right = seq.filter((_, i) => us[i]! >= cu - 5);
      const left = seq.filter((_, i) => us[i]! <= -cu + 5);
      if (right.length >= 2) frontier(right, out, MAIN_GAP);
      if (left.length >= 2) frontier(left, out, MAIN_GAP);
    }
  }

  // Dead ends left by streets that could not be laid: trimmed back, unless they are where a road
  // comes in or a cul-de-sac.
  const keep = new Set([...exitNodes.map((e) => e.node), ...bulbs.keys()]);
  for (let pass = 0; pass < 6; pass++) {
    const degree = new Map<number, number>();
    for (const st of accepted) for (const n of [st.a, st.b]) degree.set(n, (degree.get(n) ?? 0) + 1);
    const before = accepted.length;
    for (let i = accepted.length - 1; i >= 0; i--) {
      const st = accepted[i]!;
      if (st.class === "main") continue;
      const lone = [st.a, st.b].find((n) => degree.get(n) === 1 && !keep.has(n));
      if (lone !== undefined) accepted.splice(i, 1);
    }
    if (accepted.length === before) break;
  }
  // A node only two streets of one class pass through, nothing else at it: one street through it.
  for (let pass = 0; pass < 200; pass++) {
    const at = new Map<number, number[]>();
    accepted.forEach((st, i) => {
      for (const n of [st.a, st.b]) at.set(n, [...(at.get(n) ?? []), i]);
    });
    let merged = false;
    for (const [n, list] of at) {
      if (list.length !== 2 || keep.has(n)) continue;
      const [i, j] = list as [number, number];
      const p = accepted[i]!;
      const q = accepted[j]!;
      if (i === j || p.class !== q.class) continue;
      const lp = polyline(p);
      const lq = polyline(q);
      // Each as a line into n, then out of it.
      const into = p.b === n ? lp : [...lp].reverse();
      const outOf = q.a === n ? lq : [...lq].reverse();
      const din = direction(into, false);
      const dout = direction(outOf, true);
      // Only where it runs on more or less straight (a corner stays a junction).
      if (-(din[0] * dout[0] + din[1] * dout[1]) < Math.cos(0.6)) continue;
      const a = p.b === n ? p.a : p.b;
      const b = q.a === n ? q.b : q.a;
      if (a === b) continue;
      const via = [...into.slice(1, -1), nodes[n]!, ...outOf.slice(1, -1)];
      accepted.splice(Math.max(i, j), 1);
      accepted.splice(Math.min(i, j), 1);
      accepted.push({ a, b, class: p.class, via });
      merged = true;
      break;
    }
    if (!merged) break;
  }

  // Renumber the nodes the accepted streets use.
  const usedNodes = [...new Set(accepted.flatMap((st) => [st.a, st.b]))].sort((a, b) => a - b);
  const index = new Map(usedNodes.map((n, i) => [n, i]));
  return {
    nodes: usedNodes.map((n) => nodes[n]!),
    streets: accepted.map((st) => ({ ...st, a: index.get(st.a)!, b: index.get(st.b)! })),
    exits: exitNodes.filter((e) => index.has(e.node)).map((e) => ({ node: index.get(e.node)!, angle: e.angle })),
    bulbs: [...bulbs].filter(([n]) => index.has(n)).map(([n, radius]) => ({ node: index.get(n)!, radius })),
  };
}

/** Every `step` metres or so along a run of points: the control points of a curved street. */
function thin(points: readonly P[], step: number): P[] {
  const out: P[] = [];
  let last: P | null = null;
  for (const p of points) {
    if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) < step) continue;
    out.push(p);
    last = p;
  }
  return out;
}

/** The index of the point of a run nearest a point. */
function pointIndex(pts: readonly P[], q: P): number {
  let best = 0;
  let bd = Infinity;
  pts.forEach((p, i) => {
    const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
    if (d < bd) {
      bd = d;
      best = i;
    }
  });
  return best;
}

/** Unit direction of a polyline out of one of its ends. */
function direction(line: P[], fromStart: boolean): P {
  const a = fromStart ? line[0]! : line[line.length - 1]!;
  const b = fromStart ? line[1]! : line[line.length - 2]!;
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  return [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
}

function distanceToLine(p: P, line: P[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i]!;
    const b = line[i + 1]!;
    const ex = b[0] - a[0];
    const ez = b[1] - a[1];
    const len2 = ex * ex + ez * ez || 1;
    const t = Math.min(1, Math.max(0, ((p[0] - a[0]) * ex + (p[1] - a[1]) * ez) / len2));
    best = Math.min(best, Math.hypot(p[0] - (a[0] + ex * t), p[1] - (a[1] + ez * t)));
  }
  return best;
}

/** A polyline sampled every few metres, each point with the line's unit direction there. */
function dense(line: P[]): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i]!;
    const b = line[i + 1]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const n = Math.max(1, Math.ceil(len / 4));
    for (let k = 0; k < n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n, (b[0] - a[0]) / len, (b[1] - a[1]) / len]);
  }
  const l = out[out.length - 1];
  out.push([line[line.length - 1]![0], line[line.length - 1]![1], l?.[2] ?? 1, l?.[3] ?? 0]);
  return out;
}

/** The clearance asked of two streets running at these directions: `near` side by side, 18 m square across. */
function clearance(near: number, ax: number, az: number, bx: number, bz: number): number {
  return near <= 18 ? near : 18 + (near - 18) * Math.abs(ax * bx + az * bz);
}

/**
 * Whether two polylines cross, or run within `near` metres of each other where they run side by
 * side (less where they meet square: a street's lots face it, not the one beside them), anywhere
 * but at the points they share.
 */
function crosses(p: P[], q: P[], shared: P[], near = 18): boolean {
  const atShared = (x: number, z: number): boolean => shared.some((s) => Math.hypot(s[0] - x, s[1] - z) < 16);
  // Densely sampled: a curved street's chord can miss what its curve hits.
  const dp = dense(p);
  const dq = dense(q);
  for (const [x, z, tx, tz] of dp) {
    if (atShared(x, z)) continue;
    for (const [u, v, sx, sz] of dq) {
      if (Math.abs(x - u) >= near || Math.abs(z - v) >= near) continue;
      if (atShared(u, v)) continue;
      if (Math.hypot(x - u, z - v) < clearance(near, tx, tz, sx, sz)) return true;
    }
  }
  return false;
}

/** Whether a point heading one way is within the clearance of a polyline (see {@link crosses}). */
function closeTo(x: number, z: number, hx: number, hz: number, line: P[], near: number): boolean {
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i]!;
    const b = line[i + 1]!;
    const ex = b[0] - a[0];
    const ez = b[1] - a[1];
    const len2 = ex * ex + ez * ez || 1;
    const t = Math.min(1, Math.max(0, ((x - a[0]) * ex + (z - a[1]) * ez) / len2));
    const d = Math.hypot(x - (a[0] + ex * t), z - (a[1] + ez * t));
    if (d >= near) continue;
    const len = Math.sqrt(len2);
    if (d < clearance(near, hx, hz, ex / len, ez / len)) return true;
  }
  return false;
}

/**
 * Puts a plan's streets on a terrain: a node for each of its nodes (or the one already there), a
 * street with its class between each pair, a cul-de-sac's node given its bulb. Returns the roads
 * made and every node they touch. The caller grades them (`gradeNetwork`).
 */
export function layTownStreets(terrain: TerrainData, plan: TownStreetPlan): { roads: TerrainRoad[]; nodes: Set<number>; ids: number[] } {
  const ids = plan.nodes.map(([x, z]) => nodeAt(terrain, x, z, 1).id);
  for (const { node, radius } of plan.bulbs ?? []) {
    const one = terrain.nodes!.find((n) => n.id === ids[node]);
    if (one) one.bulb = radius;
  }
  const made: TerrainRoad[] = [];
  for (const st of plan.streets) {
    const a = terrain.nodes!.find((n) => n.id === ids[st.a])!;
    const b = terrain.nodes!.find((n) => n.id === ids[st.b])!;
    const road: TerrainRoad = { kind: "street", class: st.class, points: [[a.x, a.z], ...(st.via ?? []), [b.x, b.z]], from: a.id, to: b.id };
    made.push(road);
  }
  terrain.roads = [...(terrain.roads ?? []), ...made];
  return { roads: made, nodes: new Set(ids), ids };
}
