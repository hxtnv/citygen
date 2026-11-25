import { heightAt, type TerrainData, type TerrainScatter } from "./data";
import { layoutNetwork, lotMouth, nodeById, roadWalkSides, roadsAt, sampleAt, trimmedSamples, type NetworkLayout } from "./network";
import { acrossRoad } from "./roads";
import { layoutLot, type LotLayout, type LotSettings } from "./parking-lot";
import { centreLine, roadLine, roadWidth } from "./roads";
import type { KitBuilding, TerrainStamp, TownKit } from "./kit";
import { signedArea, insidePolygon, distanceToOutline } from "./polygon";
import { mulberry32 } from "./noise";
export { insidePolygon, signedArea } from "./polygon";

/**
 * City blocks: the ground the streets enclose, and what is built on it.
 *
 * A block is a face of the road network - walk along a road with the ground on your left, turn as
 * far left as you can at every junction, and you come back round one block. Its outline is that
 * walk pushed in by each road's half width and sidewalk, so it is exactly the ground behind the
 * kerbs. Nothing about a block is stored but what the user chose for it (a district and a seed,
 * `TerrainData.blocks`) and the buildings placed on it (stamps with `lot` set to the block's key):
 * move a street and the blocks follow.
 *
 * A district fills a block from the town kit: downtown is towers shoulder to shoulder, shops a
 * row of low ones, a suburb houses set back on lawns with trees behind, industry big sheds, a park
 * trees. Each building faces the street it stands on, at whatever angle that street runs.
 */

export const DISTRICTS = ["downtown", "shops", "suburb", "industrial", "park", "empty"] as const;
export type District = (typeof DISTRICTS)[number];

/**
 * What a block's ground is, whatever stands on it: `pavement` (a walk kind's fill piece,
 * a sidewalk paving tile, tiled from the sidewalk's back edge inwards: a
 * city block buildings stand on), `park` (a lawn with trees), `lot` (a parking lot: asphalt, rows
 * of painted bays with aisles, planted islands and lamps, ways in from its streets: `parking-lot.ts`), or `none` (the
 * ground as it is: for buildings, or nothing yet).
 */
export const BLOCK_GROUNDS = ["none", "pavement", "park", "lot"] as const;
export type BlockGround = (typeof BLOCK_GROUNDS)[number];

/** What the user chose for a block. */
export interface TerrainBlock {
  key: string;
  district: District;
  seed: number;
  /** Its ground (see {@link BlockGround}); unset, as its district has it (a paved district's procedural paving, else none). */
  ground?: BlockGround;
  /**
   * A point inside it and its area, as last found: what hands its ground on when the streets round
   * it change (a street taken out between two blocks, one drawn across it).
   */
  at?: [number, number];
  area?: number;
  /** A lot's way in: a point by the street it opens onto (the street's edge nearest it, wherever the street moves). */
  entrance?: [number, number];
  /** A lot's layout (bays, aisles, angle, islands, lamps) and its other ways in (`parking-lot.ts`). */
  lot?: LotSettings;
}

/** A block's ground as drawn: its own, else its district's paving (`paving`), else none. */
export function blockGround(record: Pick<TerrainBlock, "ground" | "district"> | undefined): BlockGround | "paving" {
  if (!record) return "none";
  if (record.ground) return record.ground;
  return pavedDistrict(record.district) ? "paving" : "none";
}

/** Whether a block's record has anything drawn on its ground. */
export function drawnBlock(record: Pick<TerrainBlock, "ground" | "district"> | undefined): boolean {
  return blockGround(record) !== "none";
}
/** A lot's way in: its width along the street, metres. */
export const LOT_ENTRANCE = 7;
/** How far a lot's planted island stands over the ground: its asphalt and its curb's height (the `curb` style's) less a little. */
export const LOT_ISLAND_TOP = 0.2;

/**
 * An outline with its points along a straight left out (within `tolerance` metres of the line on):
 * a block's sides as sides, not the sidewalk's every sample, for what is laid along them.
 */
export function simplifyOutline(outline: readonly [number, number][], tolerance = 0.25): [number, number][] {
  const n = outline.length;
  if (n <= 3) return outline.map((p) => [p[0], p[1]] as [number, number]);
  // Drop a point where the outline from the kept point before it to the kept one after stays on the line between them.
  const keep = outline.map(() => true);
  let kept = n;
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < n && kept > 3; i++) {
      if (!keep[i]) continue;
      let p = (i - 1 + n) % n;
      while (!keep[p]) p = (p - 1 + n) % n;
      let q = (i + 1) % n;
      while (!keep[q]) q = (q + 1) % n;
      if (p === q) continue;
      const a = outline[p]!;
      const b = outline[q]!;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 1e-6) continue;
      let ok = true;
      for (let k = (p + 1) % n; ok && k !== q; k = (k + 1) % n) {
        const c = outline[k]!;
        const along = ((c[0] - a[0]) * (b[0] - a[0]) + (c[1] - a[1]) * (b[1] - a[1])) / (len * len);
        const d = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / len;
        if (d > tolerance || along < -0.01 || along > 1.01) ok = false;
      }
      if (ok) {
        keep[i] = false;
        kept--;
        changed = true;
      }
    }
  }
  return outline.filter((_, i) => keep[i]).map((p) => [p[0], p[1]] as [number, number]);
}

/** A lot's ways in: its `entrance` and its other `lot.ways`. */
export function lotWays(record: Pick<TerrainBlock, "entrance" | "lot">): [number, number][] {
  return [...(record.entrance ? [record.entrance] : []), ...(record.lot?.ways ?? [])];
}

/**
 * Where each of a lot's ways in crosses its sidewalk's back edge (the lot's outline), on the
 * streets as laid (`lotMouth`); none for a way with no walked street near.
 */
export function lotGates(layout: NetworkLayout, record: Pick<TerrainBlock, "entrance" | "lot">): [number, number][] {
  const out: [number, number][] = [];
  for (const way of lotWays(record)) {
    const mouth = lotMouth(layout.roads, way);
    if (!mouth) continue;
    const { laid, side, s } = mouth;
    const walk = laid.sides?.[side === 1 ? 0 : 1]?.walk ?? laid.walk;
    out.push(acrossRoad(sampleAt(trimmedSamples(laid), s), side * (laid.half + walk)));
  }
  return out;
}

/** A block lot's layout (`layoutLot`): its bays, lines, islands and lamps, from its outline and ways in. */
export function blockLotLayout(block: Pick<BlockShape, "outline">, record: Pick<TerrainBlock, "entrance" | "lot">, layout: NetworkLayout): LotLayout {
  return layoutLot(block.outline, record.lot ?? {}, lotGates(layout, record), simplifyOutline(block.outline));
}

/** Per kit building, the districts it may go in. Overrides the defaults; see {@link districtsOf}. */
export type DistrictTags = Record<string, District[]>;

export interface BlockShape {
  /**
   * Its key: the ids of the junctions round it, sorted (the joints between a road's segments left
   * out, so a segment made or taken away along a street keeps its blocks).
   */
  key: string;
  /** Every node round it, joints too. */
  nodes: number[];
  /** The roads round it, and which of their sidewalks faces it (0 the one left of travel). */
  sides: { road: number; side: 0 | 1 }[];
  /** Behind the kerbs, counter-clockwise in X-Z. */
  outline: [number, number][];
  area: number;
  centre: [number, number];
  /** Ground height round it: the mean of its corners' nodes. */
  height: number;
}

/** Biggest block, square metres: past this a face is countryside between roads, not a block. */
const MAX_AREA = 90000;
const MIN_AREA = 120;

/** Every block of the network. */
export function findBlocks(terrain: TerrainData, layout: NetworkLayout = layoutNetwork(terrain)): BlockShape[] {
  const roads = terrain.roads ?? [];
  const lines = roads.map((road) => roadLine(road));
  // Half-edges: road r walked forwards (2r) or backwards (2r + 1).
  const halfOf = (r: number, back: boolean): number => r * 2 + (back ? 1 : 0);
  const origin = (h: number): number | undefined => (h % 2 === 0 ? roads[h >> 1]!.from : roads[h >> 1]!.to);
  const dest = (h: number): number | undefined => (h % 2 === 0 ? roads[h >> 1]!.to : roads[h >> 1]!.from);
  /** Outgoing half-edges at each node, counter-clockwise by angle. */
  const out = new Map<number, { h: number; angle: number }[]>();
  for (const junction of layout.junctions) {
    out.set(
      junction.node.id,
      junction.arms.map((arm) => ({ h: halfOf(arm.road, arm.end === 1), angle: arm.angle })),
    );
  }
  const next = (h: number): number | null => {
    const v = dest(h);
    if (v === undefined) return null;
    const list = out.get(v);
    if (!list || list.length === 0) return null;
    const twin = h ^ 1;
    const i = list.findIndex((o) => o.h === twin);
    if (i < 0) return null;
    // The sharpest left turn: the one just clockwise of the way back.
    return list[(i - 1 + list.length) % list.length]!.h;
  };
  const usable = (r: number): boolean => roads[r] !== undefined && roads[r]!.town === undefined && roads[r]!.from !== undefined && roads[r]!.to !== undefined && lines[r]!.length >= 2;
  const seen = new Set<number>();
  const blocks: BlockShape[] = [];
  for (let r = 0; r < roads.length; r++) {
    if (!usable(r)) continue;
    for (const back of [false, true]) {
      const start = halfOf(r, back);
      if (seen.has(start)) continue;
      const cycle: number[] = [];
      let h: number | null = start;
      let ok = true;
      for (let guard = 0; h !== null && guard < 400; guard++) {
        if (seen.has(h)) {
          ok = h === start;
          break;
        }
        seen.add(h);
        cycle.push(h);
        h = next(h);
        if (h !== null && !usable(h >> 1)) {
          ok = false;
          break;
        }
      }
      if (!ok || h === null || cycle.length < 2) continue;
      // Spurs (a dead end poking into the block) are walked out and back: drop both ways.
      const set = new Set(cycle);
      const sides = cycle.filter((e) => !set.has(e ^ 1));
      if (sides.length < 3) continue;
      const outline = insetFace(terrain, sides, lines, origin);
      if (outline.length < 3) continue;
      const area = signedArea(outline);
      // Clockwise: the outside of the whole network, or a face folded inside out by the inset.
      if (area < MIN_AREA || area > MAX_AREA) continue;
      const nodes = [...new Set(sides.map((e) => origin(e)!))];
      const key = nodes
        .filter((id) => !nodeById(terrain, id)?.joint)
        .sort((a, b) => a - b)
        .join("-");
      const heights = nodes.map((id) => nodeById(terrain, id)?.y ?? 0);
      const centre = centroid(outline);
      blocks.push({ key, nodes, sides: sides.map((h) => ({ road: h >> 1, side: (h % 2) as 0 | 1 })), outline, area, centre, height: heights.reduce((a, b) => a + b, 0) / heights.length });
    }
  }
  return blocks;
}

/** A face's outline pushed in by each road's half width and sidewalk. */
function insetFace(terrain: TerrainData, sides: number[], lines: ReturnType<typeof centreLine>[], origin: (h: number) => number | undefined): [number, number][] {
  void origin;
  const roads = terrain.roads!;
  const runs = sides.map((h) => {
    const road = roads[h >> 1]!;
    const line = h % 2 === 0 ? lines[h >> 1]! : [...lines[h >> 1]!].reverse();
    // Just under the sidewalk's outer edge, so paving or lawn meets it with no gap: the block is on
    // the left of a road walked forwards, its right walked backwards.
    const d = roadWidth(road) / 2 + roadWalkSides(road).walk[h % 2 === 0 ? 0 : 1] - 0.05;
    const pts: [number, number][] = [];
    for (let i = 0; i < line.length; i++) {
      const a = line[Math.max(0, i - 1)]!;
      const b = line[Math.min(line.length - 1, i + 1)]!;
      const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      // Left of travel.
      const nx = -(b.z - a.z) / len;
      const nz = (b.x - a.x) / len;
      pts.push([line[i]!.x + nx * d, line[i]!.z + nz * d]);
    }
    return pts;
  });
  // Where each run meets the next: cut both at their crossing near the corner.
  for (let k = 0; k < runs.length; k++) {
    const a = runs[k]!;
    const b = runs[(k + 1) % runs.length]!;
    let cut: { i: number; j: number; p: [number, number] } | null = null;
    for (let i = a.length - 2; i >= Math.max(0, a.length - 40) && !cut; i--)
      for (let j = 0; j < Math.min(b.length - 1, 40); j++) {
        const p = cross(a[i]!, a[i + 1]!, b[j]!, b[j + 1]!);
        if (p) {
          cut = { i, j, p };
          break;
        }
      }
    if (cut) {
      a.splice(cut.i + 1, a.length, cut.p);
      b.splice(0, cut.j + 1, cut.p);
    }
  }
  const outline: [number, number][] = [];
  for (const run of runs)
    for (const p of run) {
      const last = outline[outline.length - 1];
      if (!last || Math.hypot(last[0] - p[0], last[1] - p[1]) > 0.5) outline.push(p);
    }
  return outline;
}

function cross(a: [number, number], b: [number, number], c: [number, number], d: [number, number]): [number, number] | null {
  const rx = b[0] - a[0];
  const rz = b[1] - a[1];
  const sx = d[0] - c[0];
  const sz = d[1] - c[1];
  const det = rx * sz - rz * sx;
  if (Math.abs(det) < 1e-9) return null;
  const t = ((c[0] - a[0]) * sz - (c[1] - a[1]) * sx) / det;
  const u = ((c[0] - a[0]) * rz - (c[1] - a[1]) * rx) / det;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [a[0] + rx * t, a[1] + rz * t] : null;
}

function centroid(poly: readonly [number, number][]): [number, number] {
  let x = 0;
  let z = 0;
  for (const p of poly) {
    x += p[0];
    z += p[1];
  }
  return [x / poly.length, z / poly.length];
}

/** The districts a kit building goes in: the tags if it has some, else by its kind, height and size. */
export function districtsOf(building: KitBuilding, tags?: DistrictTags): District[] {
  const own = tags?.[building.id] ?? building.districts;
  if (own) return own;
  const [w, d] = building.size;
  const footprint = w * d;
  if (building.kind === "house") return ["suburb"];
  if (building.kind === "tower" && building.height >= 15) return ["downtown"];
  if (building.height <= 10 && footprint >= 250) return ["industrial", "shops"];
  return ["shops", "downtown"];
}

/** How a district lays its buildings out. */
const LAYOUT: Record<District, { setback: [number, number]; gap: [number, number]; interior: boolean; paved: boolean; trees: number }> = {
  downtown: { setback: [0.2, 0.6], gap: [0, 0.6], interior: true, paved: true, trees: 0 },
  shops: { setback: [0.3, 1.5], gap: [0.3, 2], interior: false, paved: true, trees: 0.002 },
  suburb: { setback: [4, 7], gap: [3, 6], interior: false, paved: false, trees: 0.006 },
  industrial: { setback: [3, 6], gap: [4, 8], interior: true, paved: true, trees: 0 },
  park: { setback: [0, 0], gap: [0, 0], interior: false, paved: false, trees: 0.012 },
  empty: { setback: [0, 0], gap: [0, 0], interior: false, paved: false, trees: 0 },
};

/** Whether a district's ground is paved (drawn as paving up to its buildings) or lawn. */
export function pavedDistrict(district: District): boolean {
  return LAYOUT[district].paved;
}

/** A building's footprint, as four corners. */
export function footprint(x: number, z: number, fx: number, fz: number, w: number, d: number): [number, number][] {
  // fx, fz: the way its front faces. Right of that: (-fz, fx) turned... across the front.
  const rx = fz;
  const rz = -fx;
  const hw = w / 2;
  const hd = d / 2;
  return [
    [x + fx * hd + rx * hw, z + fz * hd + rz * hw],
    [x + fx * hd - rx * hw, z + fz * hd - rz * hw],
    [x - fx * hd - rx * hw, z - fz * hd - rz * hw],
    [x - fx * hd + rx * hw, z - fz * hd + rz * hw],
  ];
}

/** Separating-axis overlap of two convex quads. */
export function overlaps(a: [number, number][], b: [number, number][]): boolean {
  for (const poly of [a, b])
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i]!;
      const q = poly[(i + 1) % poly.length]!;
      const ax = -(q[1] - p[1]);
      const az = q[0] - p[0];
      let minA = Infinity;
      let maxA = -Infinity;
      let minB = Infinity;
      let maxB = -Infinity;
      for (const v of a) {
        const t = v[0] * ax + v[1] * az;
        minA = Math.min(minA, t);
        maxA = Math.max(maxA, t);
      }
      for (const v of b) {
        const t = v[0] * ax + v[1] * az;
        minB = Math.min(minB, t);
        maxB = Math.max(maxB, t);
      }
      if (maxA <= minB || maxB <= minA) return false;
    }
  return true;
}

/** Grows a quad by `by` metres all round (for the gap kept between buildings). */
export function grow(quad: [number, number][], by: number): [number, number][] {
  const cx = (quad[0]![0] + quad[2]![0]) / 2;
  const cz = (quad[0]![1] + quad[2]![1]) / 2;
  return quad.map(([x, z]) => {
    const dx = x - cx;
    const dz = z - cz;
    const len = Math.hypot(dx, dz) || 1;
    return [x + (dx / len) * by * 1.414, z + (dz / len) * by * 1.414] as [number, number];
  });
}

/** What filling a block makes. */
export interface BlockFill {
  stamps: TerrainStamp[];
  trees: TerrainScatter[];
}

/**
 * Builds a block up as a district: buildings along every side facing the street, then (downtown,
 * industry) more inside facing the nearest side; trees in what is left (suburbs' back gardens,
 * parks). Deterministic for a seed.
 */
export function fillBlock(
  terrain: TerrainData,
  kit: TownKit,
  block: BlockShape,
  district: District,
  seed: number,
  options: { tags?: DistrictTags; trees?: readonly string[]; reserved?: readonly [number, number][][]; layout?: NetworkLayout } = {},
): BlockFill {
  const rng = mulberry32(seed * 7919 + block.key.length * 31 + Math.round(block.centre[0] * 13 + block.centre[1] * 7));
  const layout = LAYOUT[district];
  const pool = kit.buildings.filter((b) => districtsOf(b, options.tags).includes(district));
  // Ground already spoken for (a site's lot): nothing is built on it.
  const placed: { quad: [number, number][]; gapped: [number, number][] }[] = (options.reserved ?? []).map((quad) => ({ quad: [...quad], gapped: grow([...quad], 1.5) }));
  const stamps: TerrainStamp[] = [];
  const outline = block.outline;
  const range = ([a, b]: [number, number]): number => a + (b - a) * rng();
  // A street into the block (a spur, a cul-de-sac) is not part of its outline: kept off too.
  const roads = new RoadClearance(options.layout ?? layoutNetwork(terrain));
  const fits = (quad: [number, number][], gap: number): boolean => {
    for (const [x, z] of quad) if (!insidePolygon(outline, x, z)) return false;
    if (!roads.clearOfRoads(quad, 0.4)) return false;
    // And the outline's corners not inside it (a building across a sharp corner).
    for (const [x, z] of outline) if (insidePolygon(quad, x, z)) return false;
    const gapped = grow(quad, gap);
    return !placed.some((p) => overlaps(p.gapped, quad) || overlaps(gapped, p.quad));
  };
  const put = (building: KitBuilding, x: number, z: number, fx: number, fz: number, gap: number): void => {
    const quad = footprint(x, z, fx, fz, building.size[0], building.size[1]);
    placed.push({ quad, gapped: grow(quad, gap) });
    // Its origin is its footprint's centre; +Z faces the street.
    const yaw = Math.atan2(fx, fz);
    const ground = Math.min(...quad.map(([qx, qz]) => heightAt(terrain, qx, qz)), heightAt(terrain, x, z));
    stamps.push({
      block: building.id,
      lot: block.key,
      at: [x, ground, z],
      turn: 0,
      yaw,
      district,
    });
  };
  const pick = (maxWidth: number): KitBuilding | null => {
    const fitting = pool.filter((b) => b.size[0] <= maxWidth);
    if (fitting.length === 0) return null;
    return fitting[Math.floor(rng() * fitting.length)]!;
  };

  if (pool.length > 0 && district !== "park" && district !== "empty") {
    // Along each side of the outline (its straight runs: a curved street is a few), facing out.
    const sides = simplify(outline, 0.6);
    for (let i = 0; i < sides.length; i++) {
      const a = sides[i]!;
      const b = sides[(i + 1) % sides.length]!;
      const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (length < 5) continue;
      const tx = (b[0] - a[0]) / length;
      const tz = (b[1] - a[1]) / length;
      // Counter-clockwise outline: inside is to the left, the street to the right.
      const fx = tz;
      const fz = -tx;
      let s = range(layout.gap) * 0.5;
      for (let tries = 0; s < length - 4 && tries < 60; tries++) {
        const building = pick(length - s);
        if (!building) break;
        const [w, d] = building.size;
        const setback = range(layout.setback);
        const along = s + w / 2;
        const x = a[0] + tx * along - fx * (setback + d / 2);
        const z = a[1] + tz * along - fz * (setback + d / 2);
        const gap = range(layout.gap);
        const quad = footprint(x, z, fx, fz, w, d);
        if (fits(quad, gap)) {
          put(building, x, z, fx, fz, gap);
          s += w + gap;
        } else s += 2;
      }
    }
    if (layout.interior) {
      // The middle: a grid of tries, each facing the nearest side.
      const xs = outline.map((p) => p[0]);
      const zs = outline.map((p) => p[1]);
      for (let x = Math.min(...xs) + 6; x < Math.max(...xs) - 6; x += 9)
        for (let z = Math.min(...zs) + 6; z < Math.max(...zs) - 6; z += 9) {
          if (!insidePolygon(outline, x, z)) continue;
          const building = pick(40);
          if (!building) continue;
          const [fx, fz] = facingNearest(outline, x, z);
          const gap = range(layout.gap);
          const quad = footprint(x, z, fx, fz, building.size[0], building.size[1]);
          if (fits(quad, gap)) put(building, x, z, fx, fz, gap);
        }
    }
  }

  // Trees in the open ground.
  const trees: TerrainScatter[] = [];
  const kinds = options.trees ?? [];
  if (kinds.length > 0 && layout.trees > 0) {
    const count = Math.round(block.area * layout.trees);
    const xs = outline.map((p) => p[0]);
    const zs = outline.map((p) => p[1]);
    for (let n = 0; n < count * 4 && trees.length < count; n++) {
      const x = Math.min(...xs) + rng() * (Math.max(...xs) - Math.min(...xs));
      const z = Math.min(...zs) + rng() * (Math.max(...zs) - Math.min(...zs));
      if (!insidePolygon(outline, x, z)) continue;
      // Clear of the kerb and of buildings.
      if (distanceToOutline(outline, x, z) < 3) continue;
      const spot = footprint(x, z, 0, 1, 3, 3);
      if (placed.some((p) => overlaps(p.gapped, spot))) continue;
      const yaw = rng() * Math.PI * 2;
      trees.push({
        model: kinds[Math.floor(rng() * kinds.length)]!,
        at: [x, heightAt(terrain, x, z) - 0.1, z],
        rotation: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)],
        scale: 0.8 + rng() * 0.5,
      });
    }
  }
  return { stamps, trees };
}

/** A closed outline with its nearly straight runs merged (Douglas-Peucker, `tolerance` metres). */
function simplify(poly: readonly [number, number][], tolerance: number): [number, number][] {
  if (poly.length < 4) return [...poly];
  // Open it at the point farthest from the first, and simplify each half.
  let far = 0;
  let best = -1;
  for (let i = 1; i < poly.length; i++) {
    const d = Math.hypot(poly[i]![0] - poly[0]![0], poly[i]![1] - poly[0]![1]);
    if (d > best) {
      best = d;
      far = i;
    }
  }
  const run = (pts: [number, number][]): [number, number][] => {
    if (pts.length < 3) return pts;
    const a = pts[0]!;
    const b = pts[pts.length - 1]!;
    const ex = b[0] - a[0];
    const ez = b[1] - a[1];
    const len = Math.hypot(ex, ez) || 1;
    let worst = 0;
    let at = 0;
    for (let i = 1; i < pts.length - 1; i++) {
      const d = Math.abs((pts[i]![0] - a[0]) * ez - (pts[i]![1] - a[1]) * ex) / len;
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (worst <= tolerance) return [a, b];
    return [...run(pts.slice(0, at + 1)).slice(0, -1), ...run(pts.slice(at))];
  };
  const first = run([...poly.slice(0, far + 1)]);
  const second = run([...poly.slice(far), poly[0]!]);
  return [...first.slice(0, -1), ...second.slice(0, -1)];
}

function facingNearest(outline: readonly [number, number][], x: number, z: number): [number, number] {
  let best = Infinity;
  let face: [number, number] = [0, 1];
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i]!;
    const b = outline[(i + 1) % outline.length]!;
    const ex = b[0] - a[0];
    const ez = b[1] - a[1];
    const len2 = ex * ex + ez * ez || 1;
    const t = Math.min(1, Math.max(0, ((x - a[0]) * ex + (z - a[1]) * ez) / len2));
    const d = Math.hypot(x - (a[0] + ex * t), z - (a[1] + ez * t));
    if (d < best) {
      best = d;
      const len = Math.sqrt(len2);
      face = [ez / len, -ex / len];
    }
  }
  return face;
}

export { roadsAt };

/** What a building keeps clear of: every road ribbon with its sidewalks, and every junction, hashed. */
export class RoadClearance {
  private readonly cell = 12;
  private readonly discs = new Map<string, { x: number; z: number; r: number }[]>();
  private readonly polys = new Map<string, { poly: [number, number][]; pad: number }[]>();

  constructor(layout: NetworkLayout) {
    for (const laid of layout.roads) {
      const r = laid.half + (laid.walk > 0 ? laid.walk : Math.max(1, laid.shoulder * 0.5));
      for (const p of laid.samples) this.put(this.discs, p.x, p.z, r, { x: p.x, z: p.z, r });
    }
    for (const j of layout.junctions) {
      if (j.outline.length < 3) continue;
      const pad = Math.max(0, ...j.arms.map((a) => a.walk));
      let r = 0;
      for (const [x, z] of j.outline) r = Math.max(r, Math.hypot(x - j.node.x, z - j.node.z));
      this.put(this.polys, j.node.x, j.node.z, r + pad, { poly: j.outline, pad });
    }
  }

  private put<T>(map: Map<string, T[]>, x: number, z: number, r: number, item: T): void {
    for (let gx = Math.floor((x - r) / this.cell); gx <= Math.floor((x + r) / this.cell); gx++)
      for (let gz = Math.floor((z - r) / this.cell); gz <= Math.floor((z + r) / this.cell); gz++) {
        const k = `${gx},${gz}`;
        const list = map.get(k);
        if (list) list.push(item);
        else map.set(k, [item]);
      }
  }

  /** Whether a point is within `margin` of a road, its sidewalk or a junction. */
  onRoad(x: number, z: number, margin: number): boolean {
    const k = `${Math.floor(x / this.cell)},${Math.floor(z / this.cell)}`;
    for (const p of this.discs.get(k) ?? []) if (Math.hypot(p.x - x, p.z - z) < p.r + margin) return true;
    for (const { poly, pad } of this.polys.get(k) ?? []) if (insidePolygon(poly, x, z) || distanceToOutline(poly, x, z) < pad + margin) return true;
    return false;
  }

  /** Whether an outline (its edges sampled, and its middle) is clear of roads by `margin`. */
  clearOfRoads(quad: readonly [number, number][], margin: number): boolean {
    let cx = 0;
    let cz = 0;
    for (let i = 0; i < quad.length; i++) {
      const a = quad[i]!;
      const b = quad[(i + 1) % quad.length]!;
      cx += a[0] / quad.length;
      cz += a[1] / quad.length;
      const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 2.5));
      for (let k = 0; k < n; k++) if (this.onRoad(a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n, margin)) return false;
    }
    return !this.onRoad(cx, cz, margin);
  }
}

/** A parking lot's way in unless told: the middle of the block's longest side. */
export function lotEntranceFor(block: Pick<BlockShape, "outline">): [number, number] {
  const o = simplifyOutline(block.outline);
  let best = 0;
  let at: [number, number] = o[0] ?? [0, 0];
  for (let i = 0; i < o.length; i++) {
    const a = o[i]!;
    const b = o[(i + 1) % o.length]!;
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length > best) {
      best = length;
      at = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    }
  }
  return at;
}
