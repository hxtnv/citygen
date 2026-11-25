import { BufferAttribute, BufferGeometry, ShapeUtils, Vector2 } from "three";
import { LOT_ENTRANCE, LOT_ISLAND_TOP, blockGround, blockLotLayout, drawnBlock, findBlocks, insidePolygon, lotWays, type BlockShape, type TerrainBlock } from "../core/blocks";
import { insetRing, type LotLayout } from "../core/parking-lot";
import { heightAt, meshHeightAt, type TerrainData } from "../core/data";
import {
  KERB,
  RAILING,
  bridgeRuns,
  layoutNetwork,
  junctionShoulder,
  junctionEdges,
  junctionMouths,
  junctionVerge,
  junctionVerges,
  linkRoads,
  RAIL_TOP,
  roadsideOf,
  walkTops,
  kerbTops,
  withDriveBreaks,
  kerbStep,
  type WalkSide,
  type Roadside,
  sampleAt,
  trimmedSamples,
  medianCuts,
  lotMouth,
  type LaidRoad,
  type NetworkLayout,
  type Junction,
  type Arm,
} from "../core/network";
import { acrossRoad, ROAD_SINK, SHOULDER_DROP, vergeSection, type RoadSample, type Verge } from "../core/roads";
import { BAY_LENGTH, BAY_WIDTH, type ResolvedSection } from "../core/road-sections";
import { ISLAND_HEIGHT, MEDIAN_LINE_IN, islandStations, medianRuns, pointAlong, type MedianRun } from "../core/road-medians";
import { arrowShape, roadMarks, type RoadMarks } from "../core/lane-marks";
import { outsideConvex } from "./clip";

/**
 * A terrain's road network as geometry: every road's asphalt, every junction's, the painted lines
 * and zebra crossings, the sidewalks, lots, bridges and roadside furniture, merged into one set of
 * arrays per material. No materials and no scene: `buildRoadMeshes` (`city-meshes.ts`) draws these.
 */

/** How far over the graded ground the asphalt floats: enough to win the depth test, too little to see. */
export const ROAD_LIFT = 0.02;

/** A road edge's verge lip: how far out and down it reaches. */
const VERGE_OUT = 0.35;
const VERGE_DROP = 0.4;
/** Roadside furniture's colours (linear). */
const RAIL_GREY = [0.46, 0.48, 0.49] as const;
const RAIL_SHADE = [0.27, 0.28, 0.29] as const;
const WOOD = [0.16, 0.11, 0.07] as const;
const WOOD_DARK = [0.11, 0.075, 0.05] as const;
const POST_GREY = [0.36, 0.37, 0.38] as const;
const POST_WHITE = [0.78, 0.78, 0.76] as const;
const POST_BAND = [0.05, 0.05, 0.05] as const;
/** Glows a little (see `roadsideMaterial`): headlight-bright, not paint-bright. */
const REFLECTOR = [1, 0.98, 0.92] as const;
const SIGN_YELLOW = [0.88, 0.6, 0.02] as const;
const SIGN_BLACK = [0.015, 0.015, 0.015] as const;
/** How far a road's shoulder runs on into the junction at each end, under the junction's own. */
const SHOULDER_INTO_JUNCTION = 0;
/** Past a shoulder: the lip's reach out, a gentle bank rather than an edge. */
const SOFT_LIP_OUT = 1.6;
/**
 * A gravel fringe's inner edge over the ground graded under it (the asphalt's lift over the road
 * and the ground's sink under it): how far over the ground under it the fringe may be, at most,
 * falling `SHOULDER_DROP` across it (`RoadGeometry.fringeY`).
 */
const FRINGE_OVER_GROUND = ROAD_LIFT + ROAD_SINK;
/** Rows across a fringe (0 its inner edge, 1 its outer): enough to follow the ground under it. */
const FRINGE_ACROSS = [0, 0.5, 1];
/**
 * A raised verge's across in the shoulder material's UV: its fringe runs 0 to
 * this, gravel all the way; its bank from {@link BANK_UV} on, which the material draws as the
 * ground lit as it leans.
 */
export const RAISED_FRINGE_UV = 0.12;
export const BANK_UV = 2;

/** The UV across at point `k` of a raised verge's section, in the quad starting at point `from`. */
function vergeUv(k: number, from = k): number {
  if (from >= 2) return BANK_UV + (k - 2) * 0.5;
  return (k / 2) * RAISED_FRINGE_UV;
}

/** How far over the asphalt the paint floats. */
const PAINT_LIFT = 0.008;
/** Vertices across a ribbon. More than two so it follows any camber left in the ground. */
const ACROSS = [-1, -0.5, 0, 0.5, 1];
/** Metres of road per repeat of the asphalt texture. */
const TILE_LENGTH = 5;
/**
 * Where on the sidewalk tile's atlas its paving and its kerb are (read off the tile's triangles).
 */
const PAVING_UV: [number, number] = [0.1, 0.67];
export const KERB_UV: [number, number] = [0.1, 0.7];

/**
 * A road's lines, the American way: where across (metres from the centre, + to the left of
 * travel), width, dashed, yellow (between the two directions) or white. A `centre` line is a yellow
 * dash where overtaking is fine and a double solid yellow where it is not (a bend, the approach to
 * a junction), which is how a country road reads at a glance.
 */
interface LineSpec {
  across: number;
  width: number;
  dashed: boolean;
  yellow?: boolean;
  centre?: boolean;
}

/** Where a road's edge lines are, across from its centre: past its lanes onto a hard shoulder, else in from the asphalt's edge. */
function edgeOffset(section: ResolvedSection): number {
  return section.shoulder > 0 ? section.band + 0.1 : section.half - section.edgeInset;
}

/**
 * The lines on a road, from its profile (`road-sections.ts`): the centre line between the two
 * directions, the lines between its lanes each way, its edge lines, in that order. (A main
 * street's lane lines where it splits for turns are lane marks: `lane-marks.ts`.)
 */
function linesOf(section: ResolvedSection): LineSpec[] {
  const out: LineSpec[] = [];
  const width = section.centreWidth;
  const yellow = (across: number, dashed: boolean, centre = false): LineSpec => ({ across, width, dashed, yellow: true, ...(centre ? { centre } : {}) });
  // A median: a solid yellow line along each side of it, just inside the lanes' edge, in place of
  // the centre line. A planted one's kerb pieces come right to the lanes' edge, their own gutter
  // the line.
  if (section.median.kind === "planted") {
    // Nothing between the directions but the median.
  } else if (section.inner > 0) {
    const at = Math.max(0.1, section.inner - MEDIAN_LINE_IN);
    out.push(yellow(-at, false), yellow(at, false));
  } else
    switch (section.centre) {
      case "auto":
        out.push(yellow(0, true, true));
        break;
      case "double":
        out.push(yellow(0, false, true));
        break;
      case "dashed":
        out.push(yellow(0, true));
        break;
      case "solid":
        out.push(yellow(0, false));
        break;
      case "solid-dashed":
        out.push(yellow(-DOUBLE_GAP, false), yellow(DOUBLE_GAP, true));
        break;
      case "dashed-solid":
        out.push(yellow(-DOUBLE_GAP, true), yellow(DOUBLE_GAP, false));
        break;
      case "none":
        break;
    }
  if (section.laneLines !== "none")
    for (let i = 1; i < section.lanes.count; i++)
      for (const side of [-1, 1]) out.push({ across: side * (section.inner + i * section.lanes.width), width: 0.12, dashed: section.laneLines === "dashed" });
  if (section.edgeLine) {
    const edge = edgeOffset(section);
    out.push({ across: -edge, width: 0.12, dashed: false }, { across: edge, width: 0.12, dashed: false });
  }
  return out;
}
/** Road paint, linear: worn white and traffic yellow. */
const PAINT_WHITE = [0.62, 0.62, 0.6] as const;
const PAINT_YELLOW = [0.72, 0.42, 0.04] as const;
/** A broken lane line's dashes and the gaps between, metres. */
const LANE_DASH = 2;
const LANE_GAP = 3;
/** Half the gap between the two lines of a double yellow, metres. */
const DOUBLE_GAP = 0.1;
/** Where overtaking is not allowed: a bend tighter than this (radius, metres), or this near a junction. */
const NO_PASSING_RADIUS = 220;
const NO_PASSING_NEAR_END = 45;
/** A passing zone shorter than this (metres) is drawn as no passing. */
const MIN_PASSING = 70;
/** On a town street: double yellow this near a junction, and a dashed stretch at least this long. */
const STREET_NO_PASSING_NEAR_END = 12;
const STREET_MIN_PASSING = 16;

/** A dropped kerb's foot over the road (`RAMP_FOOT` in network.ts). */
const DRIVE_FOOT = 0.015;
/** Metres a dropped kerb takes to come back up either side of a driveway (`DRIVE_TAPER` in network.ts). */
const DRIVE_TAPER = 1.5;

/**
 * The merged meshes a road network is drawn into, one per material: a `kit<n>` for each pack
 * material.
 */
export interface RoadBuilders {
  asphalt: Builder;
  dirt: Builder;
  paint: Builder;
  walk: Builder;
  concrete: Builder;
  shoulder: Builder;
  /** Guard rails, posts and signs: plain colours, one per vertex. */
  roadside: Builder;
  /** Grass medians' turf, in the shoulders' material (its bank's turf): never taken out from under paving as the fringe is. */
  median?: Builder;
  /**
   * Sites' lots and their driveways, in asphalt: one surface per site with every vertex shared
   * along its seams, lit as level ground (`Builder`'s `level`), so a lot and its way in read as one
   * piece of paving. Into `asphalt` when not given.
   */
  lots?: Builder;
}

/** One merged mesh's vertex arrays, as {@link Builder.arrays} makes them. */
export interface RoadMeshArrays {
  position: Float32Array;
  uv: Float32Array;
  normal: Float32Array;
  color?: Float32Array;
}

/** Which merged mesh: one per material. */
export type RoadSlot = "asphalt" | "lots" | "dirt" | "paint" | "walk" | "concrete" | "shoulder" | "roadside" | "median";

/** A whole network's meshes, by slot; a slot nothing was drawn into is left out. */
export type RoadArrays = Partial<Record<RoadSlot, RoadMeshArrays>>;

/** Collects triangles with UVs (and optionally colours) for one merged mesh. */
export class Builder {
  position: number[] = [];
  uv: number[] = [];
  color: number[] = [];
  /**
   * `level`: every face lit as level ground (its normals straight up) rather than as it leans, so a
   * surface of gently sloping pieces shows no facets where they meet.
   */

  constructor(
    readonly coloured = false,
    readonly level = false,
  ) {}

  /** A triangle, turned to face `facing` (a direction it should face, roughly). */
  tri(
    a: [number, number, number],
    b: [number, number, number],
    c: [number, number, number],
    uvs: [number, number][],
    facing: [number, number, number] = [0, 1, 0],
    shade: number | readonly [number, number, number] = 1,
  ): void {
    this.put(a, b, c, uvs, facing, shade);
  }

  /** A triangle as it is, turned to face `facing`. */
  private put(
    a: [number, number, number],
    b: [number, number, number],
    c: [number, number, number],
    uvs: [number, number][],
    facing: [number, number, number],
    shade: number | readonly [number, number, number],
  ): void {
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const flip = nx * facing[0] + ny * facing[1] + nz * facing[2] < 0;
    const second = flip ? c : b;
    const third = flip ? b : c;
    const uv0 = uvs[0]!;
    const uv1 = uvs[flip ? 2 : 1]!;
    const uv2 = uvs[flip ? 1 : 2]!;
    this.position.push(a[0], a[1], a[2], second[0], second[1], second[2], third[0], third[1], third[2]);
    this.uv.push(uv0[0], uv0[1], uv1[0], uv1[1], uv2[0], uv2[1]);
    if (this.coloured) {
      if (typeof shade === "number") this.color.push(shade, shade, shade, shade, shade, shade, shade, shade, shade);
      else this.color.push(shade[0], shade[1], shade[2], shade[0], shade[1], shade[2], shade[0], shade[1], shade[2]);
    }
  }

  quad(
    a: [number, number, number],
    b: [number, number, number],
    c: [number, number, number],
    d: [number, number, number],
    uvs: [number, number][],
    facing?: [number, number, number],
    shade: number | readonly [number, number, number] = 1,
  ): void {
    this.tri(a, b, c, [uvs[0]!, uvs[1]!, uvs[2]!], facing, shade);
    this.tri(a, c, d, [uvs[0]!, uvs[2]!, uvs[3]!], facing, shade);
  }

  /**
   * Takes out of what is drawn here every part that the paving lying in `covers` is over or under,
   * exactly (as {@link cuts} are taken out): a road's gravel fringe where a lot, a driveway's apron,
   * a junction or another road lies across it. Paving more than `above` metres over a triangle (an
   * overpass) or `below` under it is not counted. Each triangle keeps its winding and its values.
   */
  uncover(covers: readonly PavingSource[], above = 4, below = 1): void {
    const count = this.position.length / 9;
    if (count === 0) return;
    const out = new Builder(this.coloured, this.level);
    this.uncoverInto(out, new PavingCovers(covers, PavingCovers.reached(this.position)), 0, count, above, below);
    this.position = out.position;
    this.uv = out.uv;
    this.color = out.color;
  }

  /**
   * Its triangles `from` up to `to` (not including) added to `out`, every part the paving in
   * `index` is over or under taken out (see {@link uncover}). The editor's live view does a piece
   * at a time this way (`road-edit-view.ts`), with the same result as the whole at once.
   */
  uncoverInto(out: Builder, index: PavingCovers, from: number, to: number, above = 4, below = 1): void {
    const own = this.position;
    const ownUv = this.uv;
    const ownColor = this.color;
    const stride = this.coloured ? 8 : 5;
    const keep = (v: readonly number[]): void => {
      out.position.push(v[0]!, v[1]!, v[2]!);
      out.uv.push(v[3]!, v[4]!);
      if (stride === 8) out.color.push(v[5]!, v[6]!, v[7]!);
    };
    const vertex = (i: number): number[] => {
      const v = [own[i * 3]!, own[i * 3 + 1]!, own[i * 3 + 2]!, ownUv[i * 2]!, ownUv[i * 2 + 1]!];
      if (stride === 8) v.push(ownColor[i * 3]!, ownColor[i * 3 + 1]!, ownColor[i * 3 + 2]!);
      return v;
    };
    for (let t = from; t < to; t++) {
      const o = t * 9;
      const near = index.over(own, o, above, below);
      if (near.length === 0) {
        for (let k = 0; k < 9; k++) out.position.push(own[o + k]!);
        for (let k = 0; k < 6; k++) out.uv.push(ownUv[t * 6 + k]!);
        if (stride === 8) for (let k = 0; k < 9; k++) out.color.push(ownColor[o + k]!);
        continue;
      }
      for (const piece of outsideConvex([vertex(t * 3), vertex(t * 3 + 1), vertex(t * 3 + 2)], near))
        for (let k = 1; k + 1 < piece.length; k++) {
          keep(piece[0]!);
          keep(piece[k]!);
          keep(piece[k + 1]!);
        }
    }
  }

  /** Its vertex arrays, normals worked out as {@link build} does; null when nothing was drawn. */
  arrays(): RoadMeshArrays | null {
    const geometry = this.build();
    if (!geometry) return null;
    const array = (name: string) => geometry.getAttribute(name).array as Float32Array;
    return {
      position: array("position"),
      uv: array("uv"),
      normal: array("normal"),
      ...(this.coloured ? { color: array("color") } : {}),
    };
  }

  build(): BufferGeometry | null {
    if (this.position.length === 0) return null;
    const geometry = new BufferGeometry();
    const position = new Float32Array(this.position);
    geometry.setAttribute("position", new BufferAttribute(position, 3));
    geometry.setAttribute("uv", new BufferAttribute(new Float32Array(this.uv), 2));
    if (this.coloured) geometry.setAttribute("color", new BufferAttribute(new Float32Array(this.color), 3));
    const normals = new Float32Array(position.length);
    if (this.level) for (let i = 1; i < normals.length; i += 3) normals[i] = 1;
    else {
      // Each face's own normal, as `computeVertexNormals` gives a mesh with no index (to the bit:
      // worked out in single precision, then normalised), without a vector object per vertex.
      const n = new Float32Array(3);
      for (let o = 0; o + 8 < position.length; o += 9) {
        const bx = position[o + 3]!,
          by = position[o + 4]!,
          bz = position[o + 5]!;
        const cbx = position[o + 6]! - bx,
          cby = position[o + 7]! - by,
          cbz = position[o + 8]! - bz;
        const abx = position[o]! - bx,
          aby = position[o + 1]! - by,
          abz = position[o + 2]! - bz;
        n[0] = cby * abz - cbz * aby;
        n[1] = cbz * abx - cbx * abz;
        n[2] = cbx * aby - cby * abx;
        const inv = 1 / (Math.sqrt(n[0]! * n[0]! + n[1]! * n[1]! + n[2]! * n[2]!) || 1);
        const x = n[0]! * inv,
          y = n[1]! * inv,
          z = n[2]! * inv;
        for (let k = 0; k < 9; k += 3) {
          normals[o + k] = x;
          normals[o + k + 1] = y;
          normals[o + k + 2] = z;
        }
      }
    }
    geometry.setAttribute("normal", new BufferAttribute(normals, 3));
    geometry.computeBoundingSphere();
    return geometry;
  }
}

/** Paving's triangles, nine numbers each (a {@link Builder}, or a mesh's positions). */
export interface PavingSource {
  readonly position: ArrayLike<number>;
  /** Lit as level ground (`lots`): any triangle of it covers, a steep sliver included. */
  readonly level?: boolean;
}

/** One lying triangle of paving, in X-Z, counter-clockwise. */
interface Cover {
  corners: [number, number][];
  box: [number, number, number, number, number, number];
  /** The last triangle it was looked at for. */
  seen: number;
}

/** Metres across a cell of {@link PavingCovers}. */
const COVER_CELL = 4;
const coverKey = (i: number, j: number): number => i * 100003 + j;

/** Each cell of {@link PavingCovers} the triangle at `o` reaches (its bounds do). */
function eachCell(position: ArrayLike<number>, o: number, visit: (key: number) => void): void {
  const minX = Math.min(position[o]!, position[o + 3]!, position[o + 6]!);
  const maxX = Math.max(position[o]!, position[o + 3]!, position[o + 6]!);
  const minZ = Math.min(position[o + 2]!, position[o + 5]!, position[o + 8]!);
  const maxZ = Math.max(position[o + 2]!, position[o + 5]!, position[o + 8]!);
  for (let i = Math.floor(minX / COVER_CELL); i <= Math.floor(maxX / COVER_CELL); i++) for (let j = Math.floor(minZ / COVER_CELL); j <= Math.floor(maxZ / COVER_CELL); j++) visit(coverKey(i, j));
}

/**
 * The paving a gravel fringe is taken out from under (`Builder.uncover`), its lying triangles
 * bucketed by where they are: those in the cells `reached` (what the fringe reaches), the rest
 * left out. Not a skirt, a kerb's face or a verge's lip (steeper than 45 degrees); in a source lit
 * as level ground (`lots`, all paving) any triangle that covers anything at all, a steep sliver of
 * a ramp's fan or of a lot's outline included.
 */
export class PavingCovers {
  private readonly cells = new Map<number, Cover[]>();
  private stamp = 0;
  private readonly near: [number, number][][] = [];
  private readonly mine = new Float64Array(6);

  constructor(
    covers: readonly PavingSource[],
    private readonly reached: ReadonlySet<number>,
  ) {
    for (const source of covers) this.add(source);
  }

  /** More paving: its triangles `from` up to `to` (all by default), so a big set can be added a slice at a time. */
  add(source: PavingSource, from = 0, to = Math.floor(source.position.length / 9)): void {
    const reached = this.reached;
    const p = source.position;
    for (let o = from * 9; o < to * 9; o += 9) {
      const ax = p[o]!,
        ay = p[o + 1]!,
        az = p[o + 2]!;
      const bx = p[o + 3]!,
        by = p[o + 4]!,
        bz = p[o + 5]!;
      const cx = p[o + 6]!,
        cy = p[o + 7]!,
        cz = p[o + 8]!;
      const minX = Math.min(ax, bx, cx);
      const maxX = Math.max(ax, bx, cx);
      const minZ = Math.min(az, bz, cz);
      const maxZ = Math.max(az, bz, cz);
      let any = false;
      for (let i = Math.floor(minX / COVER_CELL); i <= Math.floor(maxX / COVER_CELL) && !any; i++)
        for (let j = Math.floor(minZ / COVER_CELL); j <= Math.floor(maxZ / COVER_CELL) && !any; j++) any = reached.has(coverKey(i, j));
      if (!any) continue;
      const ux = bx - ax,
        uy = by - ay,
        uz = bz - az;
      const vx = cx - ax,
        vy = cy - ay,
        vz = cz - az;
      const ny = uz * vx - ux * vz;
      const len = Math.hypot(uy * vz - uz * vy, ny, ux * vy - uy * vx);
      if (Math.abs(ny) < 1e-9 || (!source.level && Math.abs(ny) / len < 0.7)) continue;
      let cover: Cover | null = null;
      for (let i = Math.floor(minX / COVER_CELL); i <= Math.floor(maxX / COVER_CELL); i++)
        for (let j = Math.floor(minZ / COVER_CELL); j <= Math.floor(maxZ / COVER_CELL); j++) {
          const key = coverKey(i, j);
          if (!reached.has(key)) continue;
          // Inside to the left of each side, in X-Z: (x, z) turning anticlockwise is ny < 0.
          cover ??= {
            corners:
              ny < 0
                ? [
                    [ax, az],
                    [bx, bz],
                    [cx, cz],
                  ]
                : [
                    [ax, az],
                    [cx, cz],
                    [bx, bz],
                  ],
            box: [minX, minZ, maxX, maxZ, Math.min(ay, by, cy), Math.max(ay, by, cy)],
            seen: -1,
          };
          let list = this.cells.get(key);
          if (!list) this.cells.set(key, (list = []));
          list.push(cover);
        }
    }
  }

  /** The cells some triangles (nine numbers each, `from` up to `to`) reach: what to index paving in. */
  static reached(position: ArrayLike<number>, from = 0, to = Math.floor(position.length / 9), into = new Set<number>()): Set<number> {
    for (let t = from; t < to; t++) eachCell(position, t * 9, (key) => into.add(key));
    return into;
  }

  /**
   * The outlines of the paving over or under the triangle at `o` in `own` (within `above` metres
   * over it, `below` under), not any that only touches it or lies apart: most paving near a fringe
   * is the road it runs beside, sharing its inner edge. The list is reused by the next call.
   */
  over(own: ArrayLike<number>, o: number, above: number, below: number): [number, number][][] {
    const near = this.near;
    near.length = 0;
    if (this.cells.size === 0) return near;
    const t = ++this.stamp;
    const minX = Math.min(own[o]!, own[o + 3]!, own[o + 6]!);
    const maxX = Math.max(own[o]!, own[o + 3]!, own[o + 6]!);
    const minZ = Math.min(own[o + 2]!, own[o + 5]!, own[o + 8]!);
    const maxZ = Math.max(own[o + 2]!, own[o + 5]!, own[o + 8]!);
    const minY = Math.min(own[o + 1]!, own[o + 4]!, own[o + 7]!);
    const maxY = Math.max(own[o + 1]!, own[o + 4]!, own[o + 7]!);
    const mine = this.mine;
    for (let k = 0; k < 3; k++) {
      mine[k * 2] = own[o + k * 3]!;
      mine[k * 2 + 1] = own[o + k * 3 + 2]!;
    }
    for (let i = Math.floor(minX / COVER_CELL); i <= Math.floor(maxX / COVER_CELL); i++)
      for (let j = Math.floor(minZ / COVER_CELL); j <= Math.floor(maxZ / COVER_CELL); j++)
        for (const cover of this.cells.get(coverKey(i, j)) ?? []) {
          if (cover.seen === t) continue;
          cover.seen = t;
          const [x0, z0, x1, z1, y0, y1] = cover.box;
          if (x1 > minX && x0 < maxX && z1 > minZ && z0 < maxZ && y0 < maxY + above && y1 > minY - below && !apart(mine, cover.corners)) near.push(cover.corners);
        }
    return near;
  }
}

/**
 * Whether a triangle and a cover (X, Z) only touch or lie apart: a line along a side of either has
 * the other wholly on its far side, give or take a hair.
 */
function apart(a: Float64Array, b: readonly (readonly [number, number])[]): boolean {
  for (let side = 0; side < 6; side++) {
    let px: number, pz: number, qx: number, qz: number;
    if (side < 3) {
      px = a[side * 2]!;
      pz = a[side * 2 + 1]!;
      qx = a[((side + 1) % 3) * 2]!;
      qz = a[((side + 1) % 3) * 2 + 1]!;
    } else {
      const p = b[side - 3]!;
      const q = b[(side - 2) % 3]!;
      [px, pz, qx, qz] = [p[0], p[1], q[0], q[1]];
    }
    const len = Math.hypot(qx - px, qz - pz);
    if (len < 1e-12) continue;
    const nx = (qz - pz) / len;
    const nz = (px - qx) / len;
    let aLo = Infinity,
      aHi = -Infinity,
      bLo = Infinity,
      bHi = -Infinity;
    for (let k = 0; k < 3; k++) {
      const d = a[k * 2]! * nx + a[k * 2 + 1]! * nz;
      if (d < aLo) aLo = d;
      if (d > aHi) aHi = d;
      const e = b[k]![0] * nx + b[k]![1] * nz;
      if (e < bLo) bLo = e;
      if (e > bHi) bHi = e;
    }
    if (bLo >= aHi - 1e-5 || aLo >= bHi - 1e-5) return true;
  }
  return false;
}

/**
 * Lays a terrain's road network out and draws it into {@link RoadBuilders}. Nothing of three but
 * its maths, so it runs in a worker; `RoadsView` adds the materials and the meshes.
 */
/**
 * A fresh set of the meshes a network is drawn into, with the terrain's ground cuts (a sunk loading
 * dock's truck well) taken out of the paving, its paint and its fringe: the game's
 * ({@link RoadGeometry.buildArrays}) and the editor's live view's (`road-edit-view.ts`) alike.
 */
export function roadBuilders(): Required<RoadBuilders> {
  const builders = {
    asphalt: new Builder(),
    dirt: new Builder(),
    paint: new Builder(true),
    walk: new Builder(),
    concrete: new Builder(),
    shoulder: new Builder(),
    roadside: new Builder(true),
    lots: new Builder(false, true),
    median: new Builder(),
  };
  return builders;
}

/** A park's lawn over the ground, and a block lot's asphalt (the ground is graded `ROAD_SINK` under a road beside it). */
const LAWN_LIFT = 0.06;
const LOT_LIFT = ROAD_SINK + ROAD_LIFT;
/** A lot's painted lines' width, metres. */
const LOT_LINE = 0.12;

/** A point of a paving piece being cut to a block: X, Z, its height over the ground, U, V. */
type TileVert = [number, number, number, number, number];

/** A convex polygon of {@link TileVert}s clipped to a convex outline (either way round). */
function clipConvex(poly: TileVert[], clip: readonly [number, number][]): TileVert[] {
  // Counter-clockwise (inside to the left of each edge), whichever way it was given.
  let area = 0;
  for (let i = 0; i < clip.length; i++) {
    const p = clip[i]!;
    const q = clip[(i + 1) % clip.length]!;
    area += p[0] * q[1] - q[0] * p[1];
  }
  const ring = area >= 0 ? clip : [...clip].reverse();
  let out = poly;
  for (let i = 0; i < ring.length && out.length >= 3; i++) {
    const p = ring[i]!;
    const q = ring[(i + 1) % ring.length]!;
    const side = (v: TileVert): number => (q[0] - p[0]) * (v[1] - p[1]) - (q[1] - p[1]) * (v[0] - p[0]);
    const next: TileVert[] = [];
    for (let k = 0; k < out.length; k++) {
      const a = out[k]!;
      const b = out[(k + 1) % out.length]!;
      const da = side(a);
      const db = side(b);
      if (da >= 0) next.push(a);
      if (da >= 0 !== db >= 0) {
        const t = da / (da - db);
        next.push(a.map((v, n) => v + (b[n]! - v) * t) as TileVert);
      }
    }
    out = next;
  }
  return out;
}

/** The paving the gravel fringe (`shoulder`) is taken out from under: asphalt, lots, dirt and sidewalks. */
export const FRINGE_COVERS = ["asphalt", "lots", "dirt", "walk"] as const satisfies readonly RoadSlot[];

/** The builders of a set whose paving the fringe is taken out from under. */
export function fringeCovers(builders: RoadBuilders): Builder[] {
  return FRINGE_COVERS.map((slot) => builders[slot]).filter((one): one is Builder => !!one);
}

export class RoadGeometry {
  protected layout: NetworkLayout | null = null;
  private byNode: { layout: NetworkLayout; junctions: Map<number, Junction> } | null = null;

  constructor(protected readonly terrain: TerrainData) {}

  /** The network as last laid out: for the editor's previews and the street furniture. */
  network(): NetworkLayout {
    return (this.layout ??= layoutNetwork(this.terrain));
  }

  /** Every mesh's arrays from `terrain.roads` and `terrain.nodes`, laid out afresh. */
  buildArrays(): RoadArrays {
    linkRoads(this.terrain);
    const layout = (this.layout = layoutNetwork(this.terrain));
    const builders = roadBuilders();
    const byNode = new Map(layout.junctions.map((j) => [j.node.id, j]));
    for (const laid of layout.roads) this.drawRoad(builders, laid, (id) => byNode.get(id));
    for (const junction of layout.junctions) this.drawJunction(builders, junction);
    // Blocks' ground: paved districts (downtown, shops, industry) paving from the sidewalk to the
    // buildings round any site's lot on them; pavement, parks and lots chosen for a block.
    const records = new Map((this.terrain.blocks ?? []).map((b) => [b.key, b]));
    if ([...records.values()].some((r) => drawnBlock(r))) for (const block of findBlocks(this.terrain, layout)) if (drawnBlock(records.get(block.key))) this.drawBlock(builders, block, layout);
    // The gravel fringe (a road's shoulder, a lot's) taken out wherever paving lies across it - a
    // lot, a driveway's apron, a pad, a junction, a farm track, a sidewalk - so it never shows
    // through, nor fights, the asphalt over it.
    builders.shoulder.uncover(fringeCovers(builders));

    const out: RoadArrays = {};
    for (const [slot, builder] of Object.entries(builders) as [RoadSlot, Builder][]) {
      const arrays = builder.arrays();
      if (arrays) out[slot] = arrays;
    }
    return out;
  }

  /**
   * A block's ground (`TerrainBlock.ground`, see `blocks.ts`), from its sidewalks' back edge in,
   * round any site's lot on it: a paved district's procedural paving, a walk kind's paving tiles, a
   * park's lawn (its trees are street furniture), or a lot's asphalt with its bays and its way in.
   * `layout`: the network it is drawn with (a lot's way in is found on it).
   */
  drawBlock(builders: RoadBuilders, block: Pick<BlockShape, "key" | "outline"> & Partial<Pick<BlockShape, "sides">>, layout?: NetworkLayout): void {
    const holes: [number, number][][] = [];
    const record = (this.terrain.blocks ?? []).find((b) => b.key === block.key);
    const ground = blockGround(record);
    if (ground === "park") this.groundSurface(builders.median ?? builders.shoulder, block.outline, LAWN_LIFT, holes, () => [BANK_UV + 0.5, 0.5]);
    else if (ground === "lot" && record) this.blockLot(builders, block, record, holes, layout ?? this.network());
    else this.paving(builders.walk, block.outline, KERB, holes);
  }

  /**
   * The ground inside an outline as the terrain's mesh draws it (each grid cell's two triangles,
   * cut to the outline where it crosses them), `lift` over it: a lot's asphalt, a park's lawn. Laid
   * on the ground's own triangles, it never has the ground through it, however the ground bends.
   * Not over `holes` (a site's lot).
   */
  private groundSurface(to: Builder, outline: [number, number][], lift: number, holes: [number, number][][], uv: (x: number, z: number) => [number, number]): void {
    if (outline.length < 3) return;
    const t = this.terrain;
    const s = t.spacing;
    const tris = ShapeUtils.triangulateShape(
      outline.map(([x, z]) => new Vector2(x, z)),
      [],
    ).map((k) => [outline[k[0]!]!, outline[k[1]!]!, outline[k[2]!]!] as [number, number][]);
    const xs = outline.map((p) => p[0]);
    const zs = outline.map((p) => p[1]);
    const i0 = Math.max(0, Math.floor((Math.min(...xs) - t.origin[0]) / s));
    const i1 = Math.min(t.width - 2, Math.ceil((Math.max(...xs) - t.origin[0]) / s));
    const j0 = Math.max(0, Math.floor((Math.min(...zs) - t.origin[1]) / s));
    const j1 = Math.min(t.depth - 2, Math.ceil((Math.max(...zs) - t.origin[1]) / s));
    const at = (i: number, j: number): [number, number] => [t.origin[0] + i * s, t.origin[1] + j * s];
    const emit = (poly: TileVert[]): void => {
      const pts = poly.map((v) => [v[0], meshHeightAt(t, v[0], v[1]) + lift, v[1]] as [number, number, number]);
      for (let n = 1; n + 1 < pts.length; n++) to.tri(pts[0]!, pts[n]!, pts[n + 1]!, [uv(pts[0]![0], pts[0]![2]), uv(pts[n]![0], pts[n]![2]), uv(pts[n + 1]![0], pts[n + 1]![2])]);
    };
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        // The cell's two triangles, split from its (i, j + 1) corner to its (i + 1, j) one as the mesh is.
        for (const corners of [
          [at(i, j), at(i + 1, j), at(i, j + 1)],
          [at(i + 1, j + 1), at(i, j + 1), at(i + 1, j)],
        ]) {
          const mx = (corners[0]![0] + corners[1]![0] + corners[2]![0]) / 3;
          const mz = (corners[0]![1] + corners[1]![1] + corners[2]![1]) / 3;
          if (holes.some((h) => insidePolygon(h, mx, mz))) continue;
          const tri = corners.map(([x, z]) => [x, z, 0, 0, 0] as TileVert);
          if (corners.every(([x, z]) => insidePolygon(outline, x, z)) && !outline.some(([x, z]) => insidePolygon(corners, x, z))) {
            emit(tri);
            continue;
          }
          for (const piece of tris) {
            const cut = clipConvex(tri, piece);
            if (cut.length >= 3) emit(cut);
          }
        }
      }
  }

  /**
   * A block filled as a parking lot: asphalt from its sidewalks' back edge in, a way in from the
   * street nearest each of its ways (`lotWays`: the kerb dropped there and the sidewalk's paving
   * left out, see `siteDrives`, asphalt laid across), and its layout (`parking-lot.ts`): the bays'
   * lines painted, its islands planted (their curbs are `curbs.ts`'s).
   */
  private blockLot(builders: RoadBuilders, block: Pick<BlockShape, "key" | "outline">, record: TerrainBlock, holes: [number, number][][], layout: NetworkLayout): void {
    const lots = builders.lots ?? builders.asphalt;
    this.groundSurface(lots, block.outline, LOT_LIFT, holes, (x, z) => [x / TILE_LENGTH, z / TILE_LENGTH]);
    for (const way of lotWays(record)) {
      const mouth = lotMouth(layout.roads, way);
      if (!mouth) continue;
      const { laid, side, s } = mouth;
      const one = this.side(laid, side);
      const samples = trimmedSamples(laid);
      const lo = s - LOT_ENTRANCE / 2;
      const hi = s + LOT_ENTRANCE / 2;
      const at = [lo, ...samples.filter((p) => p.s > lo + 0.05 && p.s < hi - 0.05).map((p) => p.s), hi];
      const uv = (p: [number, number, number]): [number, number] => [p[0] / TILE_LENGTH, p[2] / TILE_LENGTH];
      for (let k = 0; k + 1 < at.length; k++) {
        const pa = sampleAt(samples, at[k]!);
        const pb = sampleAt(samples, at[k + 1]!);
        const pt = (p: RoadSample, o2: number, up: number): [number, number, number] => {
          const [x, z] = acrossRoad(p, side * o2);
          return [x, this.surfaceY(x, z, p.y) + up, z];
        };
        // From the kerb's foot over the walk to past its back edge, onto the lot.
        const q = [
          pt(pa, laid.half, 0.004),
          pt(pb, laid.half, 0.004),
          pt(pb, laid.half + one.walk + 0.3, Math.max(0.004, one.top - 0.01)),
          pt(pa, laid.half + one.walk + 0.3, Math.max(0.004, one.top - 0.01)),
        ];
        if (side > 0) lots.quad(q[0]!, q[1]!, q[2]!, q[3]!, q.map(uv));
        else lots.quad(q[3]!, q[2]!, q[1]!, q[0]!, [q[3]!, q[2]!, q[1]!, q[0]!].map(uv));
      }
    }
    this.lotPlan(builders, blockLotLayout(block, record, layout));
  }

  /** A lot's layout (`parking-lot.ts`) on its asphalt: its lines painted, its islands' lawn at their curbs' top (tucked under their inner edge). */
  private lotPlan(builders: RoadBuilders, plan: LotLayout): void {
    for (const [a, b] of plan.lines) this.lotLine(builders.paint, a, b);
    for (const ring of plan.islands) this.groundSurface(builders.median ?? builders.shoulder, insetRing(ring, 0.05), LOT_ISLAND_TOP, [], () => [BANK_UV + 0.5, 0.5]);
  }

  /**
   * A painted line on a lot, `LOT_LINE` wide, from `a` to `b`: on its asphalt, cut where it crosses
   * the ground's triangles' edges (grid lines and cells' diagonals) so it follows them as the
   * asphalt under it does, and every half metre or so besides.
   */
  private lotLine(paint: Builder, a: [number, number], b: [number, number]): void {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len < 0.05) return;
    const dx = (b[0] - a[0]) / len;
    const dz = (b[1] - a[1]) / len;
    // Across: half its width either side.
    const w = LOT_LINE / 2;
    const wx = -dz * w;
    const wz = dx * w;
    const lift = LOT_LIFT + 0.02;
    const shade = [PAINT_WHITE[0] * 0.9, PAINT_WHITE[1] * 0.9, PAINT_WHITE[2] * 0.9] as const;
    // On the asphalt, and over the ground's smooth height where that is higher (a twisted cell's middle).
    const p = (x: number, z: number): [number, number, number] => [x, Math.max(meshHeightAt(this.terrain, x, z) + lift, heightAt(this.terrain, x, z) + 0.016), z];
    const sp = this.terrain.spacing;
    const gx = (x: number): number => (x - this.terrain.origin[0]) / sp;
    const gz = (z: number): number => (z - this.terrain.origin[1]) / sp;
    const cuts = new Set<number>([0, 1]);
    const n = Math.max(1, Math.ceil(len / 0.5));
    for (let k = 1; k < n; k++) cuts.add(k / n);
    const cross = (v0: number, v1: number): void => {
      if (Math.abs(v1 - v0) < 1e-9) return;
      for (let g = Math.ceil(Math.min(v0, v1)); g <= Math.floor(Math.max(v0, v1)); g++) {
        const f = (g - v0) / (v1 - v0);
        if (f > 1e-4 && f < 1 - 1e-4) cuts.add(f);
      }
    };
    cross(gx(a[0]), gx(b[0]));
    cross(gz(a[1]), gz(b[1]));
    cross(gx(a[0]) + gz(a[1]), gx(b[0]) + gz(b[1]));
    const at = [...cuts].sort((x, y) => x - y);
    for (let k = 0; k + 1 < at.length; k++) {
      const x0 = a[0] + (b[0] - a[0]) * at[k]!;
      const z0 = a[1] + (b[1] - a[1]) * at[k]!;
      const x1 = a[0] + (b[0] - a[0]) * at[k + 1]!;
      const z1 = a[1] + (b[1] - a[1]) * at[k + 1]!;
      paint.quad(
        p(x0 - wx, z0 - wz),
        p(x0 + wx, z0 + wz),
        p(x1 + wx, z1 + wz),
        p(x1 - wx, z1 - wz),
        [
          [0, 0],
          [0, 0],
          [0, 0],
          [0, 0],
        ],
        [0, 1, 0],
        shade,
      );
    }
  }

  /**
   * One road's every piece: asphalt or dirt, verges, paint, sidewalks, bridges. Its lane marks
   * come from the junctions at its ends (`junctionAt`, by node id; by default the view's own
   * layout's).
   */
  drawRoad(to: RoadBuilders, laid: LaidRoad, junctionAt?: (id: number) => Junction | undefined): void {
    const samples = trimmedSamples(laid);
    if (samples.length < 2) return;
    const isDirt = laid.road.kind === "dirt";
    this.ribbon(isDirt ? to.dirt : to.asphalt, samples, laid.half, isDirt);
    const medians = isDirt ? [] : medianRuns(laid.section, samples, !!laid.closed, medianCuts(laid, junctionAt ?? this.junctionLookup()), laid.runsOn);
    for (const median of medians) this.median(to, samples, median, laid.index);
    // A country road's soft shoulder: gravel from the asphalt's edge, falling a few centimetres and
    // fading into the ground's own colour, so road meets field with no step and no seam. Then,
    // without a sidewalk (which has its own), a lip down off the outer edge: wherever the ground
    // falls away a little, an edge in the ground's colour, not a sliver of sky.
    if (laid.shoulder > 0) {
      // Raised: a crisp gravel fringe on top, then a grass bank down to the field.
      if (laid.verge) this.raisedVerge(to.shoulder, samples, laid.verge);
      else this.shoulderStrip(to.shoulder, samples, laid.half, laid.shoulder, laid.index, !!laid.closed);
      this.roadside(to.roadside, roadsideOf(this.terrain, laid));
    } else if (laid.walk === 0) this.verge(isDirt ? to.dirt : to.asphalt, samples, laid.half);
    // A sidewalk on one side only: the other side's edge has the lip a road without any has.
    else for (const side of [1, -1] as const) if (this.side(laid, side).walk <= 0) this.verge(isDirt ? to.dirt : to.asphalt, samples, laid.half, 0, false, [side]);
    if (!isDirt) {
      this.lines(to.paint, laid, samples);
      this.zebras(to.paint, laid, samples);
      this.junctionZebras(to.paint, laid, junctionAt ?? this.junctionLookup());
      this.laneMarks(to.paint, laid, samples, roadMarks(laid, junctionAt ?? this.junctionLookup()));
    }
    for (const side of [1, -1] as const) {
      const one = this.side(laid, side);
      if (one.walk <= 0) continue;
      if (one.bay) this.bays(to, laid, samples, side, one);
      this.sidewalks(to.walk, laid, samples, side);
    }
    for (const run of bridgeRuns(samples)) this.bridge(to.concrete, run, laid.half, laid.half + (laid.walk > 0 ? laid.walk : 0.6));
  }

  /** One side of a road's sidewalks (1 the left of travel); a road laid out before sides had them reads its one walk. */
  private side(laid: LaidRoad, side: 1 | -1): WalkSide {
    return laid.sides?.[side === 1 ? 0 : 1] ?? { walk: laid.walk, top: laid.walkTop, bay: null };
  }

  /**
   * A side's parking bays: the asphalt out to where the kerb has stepped back to (stepping out and
   * in again at their ends), a white line along the lane's edge and one across between each two
   * bays ({@link BAY_LENGTH} long).
   */
  private bays(to: RoadBuilders, laid: LaidRoad, all: RoadSample[], side: 1 | -1, one: WalkSide): void {
    const bay = one.bay;
    if (!bay) return;
    const samples = withDriveBreaks(laid, all, side).filter((p) => p.s >= bay.lo - 0.06 && p.s <= bay.hi + 0.06);
    for (let i = 0; i + 1 < samples.length; i++) {
      const a = samples[i]!;
      const b = samples[i + 1]!;
      const ka = kerbStep(one, a.s);
      const kb = kerbStep(one, b.s);
      if (ka < 1e-3 && kb < 1e-3) continue;
      const pt = (p: RoadSample, o: number): [number, number, number] => {
        const [x, z] = acrossRoad(p, side * o);
        return [x, this.surfaceY(x, z, p.y), z];
      };
      const q = [pt(a, laid.half), pt(b, laid.half), pt(b, laid.half + kb), pt(a, laid.half + ka)];
      const uvs = q.map((v) => [v[0] / TILE_LENGTH, v[2] / TILE_LENGTH] as [number, number]);
      if (side > 0) to.asphalt.quad(q[0]!, q[1]!, q[2]!, q[3]!, uvs);
      else to.asphalt.quad(q[3]!, q[2]!, q[1]!, q[0]!, [uvs[3]!, uvs[2]!, uvs[1]!, uvs[0]!]);
    }
    const seed = laid.index * 5.1 + side;
    const shade = (k: number): readonly [number, number, number] => {
      const wear = 0.84 + hash(seed, k) * 0.12;
      return [PAINT_WHITE[0] * wear, PAINT_WHITE[1] * wear, PAINT_WHITE[2] * wear];
    };
    // Along the lane's edge, the bays' length of it.
    this.strip(
      to.paint,
      all,
      bay.s0,
      bay.s1,
      () => side * (laid.half + 0.08),
      () => 0.1,
      shade(0),
    );
    // Across, at each bay's end: whole bays from the stretch's start, the last one what is left.
    const count = Math.max(1, Math.round((bay.s1 - bay.s0) / BAY_LENGTH));
    const step = (bay.s1 - bay.s0) / count;
    for (let k = 0; k <= count; k++) {
      const s = bay.s0 + k * step;
      const across = (o: number): number => side * o;
      this.patch(
        to.paint,
        all,
        [
          [s - 0.06, across(laid.half)],
          [s + 0.06, across(laid.half)],
          [s + 0.06, across(laid.half + BAY_WIDTH - 0.2)],
          [s - 0.06, across(laid.half + BAY_WIDTH - 0.2)],
        ],
        shade(k + 1),
      );
    }
  }

  /**
   * A road's median between its two directions (its yellow lines are `lines`'): a painted one's
   * hatching; a raised or grass one's island - a kerb all round, a nose at each end, paved on top or
   * turfed inside a kerb's width. A concrete barrier's pieces are street furniture (`network.ts`).
   */
  private median(to: RoadBuilders, samples: RoadSample[], run: MedianRun, seed: number): void {
    if (run.kind === "painted") {
      // Yellow hatching across it, a stripe every few metres, leaning the way traffic runs.
      const w = run.half - MEDIAN_LINE_IN - 0.25;
      if (w < 0.25) return;
      const lean = w * 1.4;
      for (let s = run.s0 + 0.5, k = 0; s + lean + 0.45 < run.s1 - 0.5; s += 4, k++) {
        const wear = 0.82 + hash(seed * 1.7, k) * 0.15;
        const shade = [PAINT_YELLOW[0] * wear, PAINT_YELLOW[1] * wear, PAINT_YELLOW[2] * wear] as const;
        this.patch(
          to.paint,
          samples,
          [
            [s, -w],
            [s + 0.45, -w],
            [s + 0.45 + lean, w],
            [s + lean, w],
          ],
          shade,
        );
      }
      return;
    }
    if (run.kind === "planted" && this.plantedMedian(to, samples, run)) return;
    if (run.kind !== "raised" && run.kind !== "grass" && run.kind !== "planted") return;
    const grass = run.kind === "grass";
    // A grass island's kerb: this wide on top, turf inside it.
    const band = 0.2;
    const rows = islandStations(run, samples).map((st) => {
      const p = pointAlong(samples, st.s);
      const y = this.surfaceY(p.x, p.z, p.y) - ROAD_LIFT;
      const pt = (o: number, up: number): [number, number, number] => {
        const [x, z] = acrossRoad(p, o);
        return [x, y + ROAD_LIFT + up, z];
      };
      const inner = Math.max(0, st.w - band);
      return { s: st.s, c: pt(0, 0), l: pt(st.w, 0), r: pt(-st.w, 0), lt: pt(st.w, ISLAND_HEIGHT), rt: pt(-st.w, ISLAND_HEIGHT), li: pt(inner, ISLAND_HEIGHT), ri: pt(-inner, ISLAND_HEIGHT) };
    });
    const paving: [number, number][] = [PAVING_UV, PAVING_UV, PAVING_UV, PAVING_UV];
    const kerb: [number, number][] = [KERB_UV, KERB_UV, KERB_UV, KERB_UV];
    const turf = to.median ?? to.shoulder;
    for (let k = 0; k + 1 < rows.length; k++) {
      const a = rows[k]!;
      const b = rows[k + 1]!;
      if (b.s - a.s < 1e-4 && Math.hypot(b.l[0] - a.l[0], b.l[2] - a.l[2]) < 1e-4) continue;
      if (grass) {
        to.walk.quad(a.li, b.li, b.lt, a.lt, paving);
        to.walk.quad(a.rt, b.rt, b.ri, a.ri, paving);
        const u = BANK_UV + 0.5;
        turf.quad(a.ri, b.ri, b.li, a.li, [
          [u, a.s],
          [u, b.s],
          [u, b.s],
          [u, a.s],
        ]);
      } else to.walk.quad(a.rt, b.rt, b.lt, a.lt, paving);
      // The kerb's face each side, from the road up, facing out from the island's line.
      for (const [p, q, pt, qt] of [
        [a.l, b.l, a.lt, b.lt],
        [a.r, b.r, a.rt, b.rt],
      ] as const) {
        const mx = (p[0] + q[0]) / 2 - (a.c[0] + b.c[0]) / 2;
        const mz = (p[2] + q[2]) / 2 - (a.c[2] + b.c[2]) / 2;
        to.walk.quad(p, q, qt, pt, kerb, [mx, 0, mz]);
      }
    }
  }

  /**
   * A planted median's paving: its edge walk kind's pieces along each side, back to back, facing
   * out to the lanes (bent along the road as a sidewalk's are, the walk kind's fill between where
   * it is wider than two of them), and round each nose the walk's section swept round a half
   * circle in to the median's middle. What stands on it is street furniture (`network.ts`).
   * False (drawn as a raised island instead) when its planting or edge is not known.
   */
  private plantedMedian(to: RoadBuilders, samples: RoadSample[], run: MedianRun): boolean {
    return false;
  }

  /** One junction: its asphalt, the sidewalks round its corners, its verge. */
  drawJunction(builders: RoadBuilders, junction: Junction): void {
    if (junction.outline.length < 3) return;
    const { node } = junction;
    const to = junction.dirt ? builders.dirt : builders.asphalt;
    const y = (x: number, z: number): number => this.surfaceY(x, z, node.y);
    const centre: [number, number, number] = [node.x, y(node.x, node.z), node.z];
    // Across each mouth, the same vertices as the end of the road's ribbon (`ACROSS`): a straight
    // edge against a ribbon end with points along it is a T-junction, and the rasteriser leaves a
    // hairline crack along it, the ground showing through as a thin dark line.
    const mouth = mouths(junction);
    const outline: [number, number][] = [];
    junction.outline.forEach((a, i) => {
      outline.push(a);
      if (!mouth[i]) return;
      const b = junction.outline[(i + 1) % junction.outline.length]!;
      for (let k = 1; k < ACROSS.length - 1; k++) {
        const t = (ACROSS[k]! - ACROSS[0]!) / (ACROSS[ACROSS.length - 1]! - ACROSS[0]!);
        outline.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    });
    for (let i = 0; i < outline.length; i++) {
      const [ax, az] = outline[i]!;
      const [bx, bz] = outline[(i + 1) % outline.length]!;
      to.tri(
        centre,
        [ax, y(ax, az), az],
        [bx, y(bx, bz), bz],
        [
          [node.x / TILE_LENGTH, node.z / TILE_LENGTH],
          [ax / TILE_LENGTH, az / TILE_LENGTH],
          [bx / TILE_LENGTH, bz / TILE_LENGTH],
        ],
      );
    }
    if (!junction.dirt) this.throughLines(builders.paint, junction);
    // Round a cul-de-sac's bulb, its houses' driveways cross the sidewalk on dropped kerbs.
    const drops = node.bulb && junction.arms.length === 1 ? this.bulbDrops(junction) : [];
    for (const corner of junction.corners) {
      // Its own driveways' (a cul-de-sac's), and its kerb dropped where a zebra meets it.
      const own: [number, number, number?, number?][] = [...(corner === junction.corners[0] ? drops : []), ...(corner.ramps ?? []).map(([a, b]) => [a, b, a, a] as [number, number, number, number])];
      this.cornerWalk(builders.walk, corner.points, corner.walk, corner.walkEnd, node.y, own);
    }
    // The same shoulder (or lip) round the junction's edge, except across the mouths where its
    // roads run in (under a corner's sidewalk it is never seen).
    const shoulder = junctionShoulder(junction);
    const raised = junctionVerge(junction, this.terrain.spacing);
    if (raised) this.raisedJunction(builders.shoulder, junction, raised);
    else if (shoulder > 0) this.junctionShoulder(builders.shoulder, junction, y(node.x, node.z), shoulder);
    else this.junctionVerge(to, junction.outline, node.x, node.z, y(node.x, node.z));
  }

  /**
   * A raised road's verge either side (`vergeSection`): its gravel fringe from the asphalt's edge,
   * level but for a few centimetres' fall, then the bank down to the grass and a toe on under it.
   * The fringe's across runs 0 to {@link RAISED_FRINGE_UV} (gravel all the way: the shoulder
   * material's fade starts further across); the bank's is {@link BANK_UV} on (the material draws
   * it as the ground, lit as it leans).
   */
  private raisedVerge(to: Builder, samples: RoadSample[], verge: Verge): void {
    const section = vergeSection(verge);
    for (const side of [1, -1]) {
      for (let i = 0; i < samples.length - 1; i++) {
        const a = samples[i]!;
        const b = samples[i + 1]!;
        if (a.bridge || b.bridge) continue;
        const at = (p: RoadSample, k: number): [number, number, number] => {
          const [o, h] = section[k]!;
          const [x, z] = acrossRoad(p, side * o);
          return [x, p.y + h, z];
        };
        const facing: [number, number, number] = [-a.dz * side, 1, a.dx * side];
        for (let k = 0; k + 1 < section.length; k++) {
          const u0 = vergeUv(k);
          const u1 = vergeUv(k + 1, k);
          to.quad(
            at(a, k),
            at(b, k),
            at(b, k + 1),
            at(a, k + 1),
            [
              [u0, a.s],
              [u0, b.s],
              [u1, b.s],
              [u1, a.s],
            ],
            facing,
          );
        }
      }
    }
  }

  /**
   * A raised junction's fringe and bank round the edges of its outline that are not its roads'
   * mouths (`junctionEdges`), the same section as its raised roads' at their ends.
   */
  private raisedJunction(to: Builder, junction: Junction, verge: Verge): void {
    // Each point's own section: at a road's mouth that road's lift and bank, eased round the corners.
    const sections = (junctionVerges(junction, this.terrain.spacing) ?? junction.outline.map(() => verge)).map((v) => vergeSection(v));
    const y = junction.node.y;
    for (const edge of junctionEdges(junction)) {
      const at = (o: [number, number], c: [number, number], section: [number, number][], k: number): [number, number, number] => {
        const [out, h] = section[k]!;
        return [o[0] + c[0] * out, y + h, o[1] + c[1] * out];
      };
      const sa = sections[edge.i]!;
      const sb = sections[edge.j]!;
      const facing: [number, number, number] = [(edge.ca[0] + edge.cb[0]) / 2, 1, (edge.ca[1] + edge.cb[1]) / 2];
      for (let k = 0; k + 1 < sa.length; k++) {
        const u0 = vergeUv(k);
        const u1 = vergeUv(k + 1, k);
        to.quad(
          at(edge.a, edge.ca, sa, k),
          at(edge.b, edge.cb, sb, k),
          at(edge.b, edge.cb, sb, k + 1),
          at(edge.a, edge.ca, sa, k + 1),
          [
            [u0, 0],
            [u0, 1],
            [u1, 1],
            [u1, 0],
          ],
          facing,
        );
      }
    }
  }

  /**
   * A road's lines carried on through a junction where it meets just one other road, more or less
   * straight on (a country road widening into a main street, a bend): the centre line and the
   * outermost white line each side, curving from the one road's to the other's over the
   * junction's flat asphalt, so a road that widens or narrows there is marked all the way.
   */
  private throughLines(to: Builder, junction: Junction): void {
    if (junction.arms.length !== 2) return;
    const [a, b] = junction.arms as [Arm, Arm];
    // Within 60 degrees of straight on.
    if (a.dx * b.dx + a.dz * b.dz > -0.5) return;
    const ma = mouthOf(junction, a);
    const mb = mouthOf(junction, b);
    if (!ma || !mb) return;
    const la = edgeLines(a);
    const lb = edgeLines(b);
    const { node } = junction;
    // Travelling from a's road into b's: right of travel on each, where each road's lines end
    // (half a metre short of the junction's edge, see `lines`).
    const from = (rho: number): [number, number] => [ma.x + ma.ox * 0.5 + ma.oz * rho, ma.z + ma.oz * 0.5 - ma.ox * rho];
    const until = (rho: number): [number, number] => [mb.x + mb.ox * 0.5 - mb.oz * rho, mb.z + mb.oz * 0.5 + mb.ox * rho];
    const pairs: [number, number, number, readonly [number, number, number]][] = [];
    if (la.centre && lb.centre) for (const side of [-1, 1]) pairs.push([side * DOUBLE_GAP, side * DOUBLE_GAP, 0.11, PAINT_YELLOW]);
    if (la.white > 0 && lb.white > 0) for (const side of [-1, 1]) pairs.push([side * la.white, side * lb.white, 0.12, PAINT_WHITE]);
    for (const [ra, rb, width, colour] of pairs) {
      const p = from(ra);
      const q = until(rb);
      const m = Math.hypot(q[0] - p[0], q[1] - p[1]);
      // A cubic leaving a's road along it and joining b's along it.
      const at = (t: number): [number, number] => {
        const h0 = 2 * t ** 3 - 3 * t ** 2 + 1;
        const h1 = t ** 3 - 2 * t ** 2 + t;
        const h2 = -2 * t ** 3 + 3 * t ** 2;
        const h3 = t ** 3 - t ** 2;
        return [h0 * p[0] - h1 * m * ma.ox + h2 * q[0] + h3 * m * mb.ox, h0 * p[1] - h1 * m * ma.oz + h2 * q[1] + h3 * m * mb.oz];
      };
      const steps = Math.max(6, Math.ceil(m));
      const line = Array.from({ length: steps + 1 }, (_, k) => at(k / steps));
      const shade = [colour[0] * 0.9, colour[1] * 0.9, colour[2] * 0.9] as const;
      let prev: [number, number, number][] | null = null;
      line.forEach((pt, k) => {
        const ahead = line[Math.min(k + 1, steps)]!;
        const behind = line[Math.max(k - 1, 0)]!;
        const dx = ahead[0] - behind[0];
        const dz = ahead[1] - behind[1];
        const d = Math.hypot(dx, dz) || 1;
        const nx = (-dz / d) * (width / 2);
        const nz = (dx / d) * (width / 2);
        const edge = [
          [pt[0] - nx, 0, pt[1] - nz],
          [pt[0] + nx, 0, pt[1] + nz],
        ] as [number, number, number][];
        for (const e of edge) e[1] = this.surfaceY(e[0], e[2], node.y) + PAINT_LIFT;
        if (prev)
          to.quad(
            prev[0]!,
            prev[1]!,
            edge[1]!,
            edge[0]!,
            [
              [0, 0],
              [0, 0],
              [0, 0],
              [0, 0],
            ],
            [0, 1, 0],
            shade,
          );
        prev = edge;
      });
    }
  }

  /**
   * The asphalt's height at a point of a road whose surface is `roadY` there: the road's own
   * height, never the ground's. Every piece that meets another - a ribbon's end and a junction's
   * edge, a kerb and the asphalt - is then at exactly one height, with no crack between.
   */
  private surfaceY(x: number, z: number, roadY: number): number {
    return roadY + ROAD_LIFT;
  }

  /**
   * A gravel fringe's height (a road's shoulder, a lot's) `k` of the way across it - 0 its inner
   * edge, on the paving's edge, where it is `y` as the paving is; 1 its outer edge - where its own
   * section puts it at `y`: never over the same section laid on the ground under it (as a road's
   * shoulder is over the ground graded under the road, `ROAD_SINK`). On ground graded as usual
   * the two are the same; where the ground is lower (dug out, or falling away down a bank) the
   * fringe follows it down instead of standing over it on its own flat plane.
   */
  private fringeY(x: number, z: number, y: number, k: number): number {
    if (k <= 0) return y;
    return Math.min(y, meshHeightAt(this.terrain, x, z) + FRINGE_OVER_GROUND - SHOULDER_DROP * k);
  }

  private ribbon(to: Builder, samples: RoadSample[], half: number, isDirt: boolean): void {
    const cols = ACROSS.length;
    const row = samples.map((p) =>
      ACROSS.map((a) => {
        // Held at a bend's centre on its inside where the bend is tighter than the road is wide.
        const [x, z] = acrossRoad(p, a * half);
        return { at: [x, this.surfaceY(x, z, p.y), z] as [number, number, number], a, s: p.s };
      }),
    );
    for (let i = 0; i < samples.length - 1; i++)
      for (let j = 0; j < cols - 1; j++) {
        const q = [row[i]![j]!, row[i]![j + 1]!, row[i + 1]![j + 1]!, row[i + 1]![j]!];
        // Dirt: across 0..1 for its ruts. Asphalt: the texture laid in world space, so it runs on
        // unbroken into a junction.
        const uvs = q.map((v) => (isDirt ? ([(v.a + 1) / 2, v.s / (half * 2)] as [number, number]) : ([v.at[0] / TILE_LENGTH, v.at[2] / TILE_LENGTH] as [number, number])));
        to.quad(q[0]!.at, q[1]!.at, q[2]!.at, q[3]!.at, uvs);
      }
  }

  /**
   * A ribbon's shoulders: gravel either side, about `width` wide. Not a strip with an edge: it starts
   * a little over the asphalt's edge (raggedly, the way gravel spills onto a road) and slopes down
   * through the ground beside it, so the field closes over its outer part wherever the ground
   * happens to be and there is no line where it ends; never over the ground under it by more than
   * its section is on graded ground (`fringeY`), across it in {@link FRINGE_ACROSS} steps. Its
   * width wanders along the road, and it runs a little way into each junction so it meets the
   * junction's own shoulder with no gap.
   */
  private shoulderStrip(to: Builder, samples: RoadSample[], half: number, width: number, seed: number, closed = false): void {
    if (samples.length < 2) return;
    // Carried on a little way past each end, into the junction (level there, as the junction is);
    // a closed loop's ends meet each other instead.
    const first = samples[0]!;
    const last = samples[samples.length - 1]!;
    const back = (p: RoadSample, k: number): RoadSample => ({ ...p, x: p.x - p.dx * k, z: p.z - p.dz * k, s: p.s - k });
    const run = closed ? samples : [back(first, SHOULDER_INTO_JUNCTION), ...samples, back(last, -SHOULDER_INTO_JUNCTION)];
    const ends = (p: RoadSample): boolean => !closed && (p === run[0] || p === run[run.length - 1] || p === first || p === last);
    const loop = last.s - first.s;
    for (const side of [1, -1]) {
      const salt = seed * 13.7 + side * 5.3;
      for (let i = 0; i < run.length - 1; i++) {
        const a = run[i]!;
        const b = run[i + 1]!;
        if (a.bridge || b.bridge) continue;
        const at = (p: RoadSample, k: number): [number, number, number] => {
          // At the ends exactly the nominal shape, to meet the junction's; between, wandering.
          const wobble = (s: number): number => width * (1 + 0.28 * Math.sin(s * 0.09 + salt) + 0.14 * Math.sin(s * 0.31 + salt * 1.7));
          // Round a closed loop the wobble runs on through the seam (its first metres blend from its last).
          const k6 = closed ? (p.s - first.s) / 6 : 1;
          const wide = ends(p) ? width : k6 < 1 ? wobble(p.s + loop) * (1 - k6) + wobble(p.s) * k6 : wobble(p.s);
          // From exactly the asphalt's edge, at its height: the two share an edge, so there is no
          // step, no overlap and no sliver between them.
          const out = half + wide * k;
          const [x, z] = acrossRoad(p, side * out);
          return [x, this.fringeY(x, z, this.surfaceY(p.x, p.z, p.y) - SHOULDER_DROP * k, k), z];
        };
        // Across: 0 at its inner edge, 1 at its outer, for the shader's fade.
        for (let r = 0; r + 1 < FRINGE_ACROSS.length; r++) {
          const k0 = FRINGE_ACROSS[r]!;
          const k1 = FRINGE_ACROSS[r + 1]!;
          to.quad(at(a, k0), at(b, k0), at(b, k1), at(a, k1), [
            [k0, a.s],
            [k0, b.s],
            [k1, b.s],
            [k1, a.s],
          ]);
        }
      }
    }
  }

  /** A junction's shoulder: outward from each edge of its outline that is not a road's mouth. */
  private junctionShoulder(to: Builder, junction: Junction, y: number, width: number): void {
    const { node, outline } = junction;
    const n = outline.length;
    // Not across the mouths, where the roads' own shoulders carry on.
    const mouth = mouths(junction);
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
      // Beside a mouth: straight out along the mouth's line, square across the road, which is
      // exactly where the road's own shoulder ends; meeting at an angle left a sliver between.
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
    // The same section as a road's shoulder at its ends: over the edge, down through the ground.
    const point = (k: number, c: [number, number], o: [number, number]): [number, number, number] => {
      const out = width * k;
      const x = o[0] + c[0] * out;
      const z = o[1] + c[1] * out;
      return [x, this.fringeY(x, z, y - SHOULDER_DROP * k, k), z];
    };
    for (let i = 0; i < n; i++) {
      if (mouth[i]) continue;
      const j = (i + 1) % n;
      const a = outline[i]!;
      const b = outline[j]!;
      for (let r = 0; r + 1 < FRINGE_ACROSS.length; r++) {
        const k0 = FRINGE_ACROSS[r]!;
        const k1 = FRINGE_ACROSS[r + 1]!;
        to.quad(
          point(k0, corner[i]!, a),
          point(k0, corner[j]!, b),
          point(k1, corner[j]!, b),
          point(k1, corner[i]!, a),
          [
            [k0, 0],
            [k0, 1],
            [k1, 1],
            [k1, 0],
          ],
          [0, 1, 0],
        );
      }
    }
  }

  /**
   * A lip down and out from each edge of a ribbon (`half` out, starting `drop0` under the road),
   * skipping bridge spans (they have parapets). `faded`: drawn in the shoulder's material at the
   * ground's colour.
   */
  private verge(to: Builder, samples: RoadSample[], half: number, drop0 = 0, faded = false, sides: readonly (1 | -1)[] = [1, -1]): void {
    for (const side of sides) {
      for (let i = 0; i < samples.length - 1; i++) {
        const a = samples[i]!;
        const b = samples[i + 1]!;
        if (a.bridge || b.bridge) continue;
        const top = (p: RoadSample, out: number, drop: number): [number, number, number] => {
          const [x, z] = acrossRoad(p, side * (half + out));
          return [x, this.surfaceY(p.x, p.z, p.y) - drop, z];
        };
        const n: [number, number, number] = [-a.dz * side, 0.6, a.dx * side];
        // Past a shoulder, a gentle bank in the ground's colour, not a lit edge that reads as a kerb.
        const out = faded ? SOFT_LIP_OUT : VERGE_OUT;
        const q = [top(a, 0, drop0), top(b, 0, drop0), top(b, out, drop0 + VERGE_DROP), top(a, out, drop0 + VERGE_DROP)];
        const uvs = faded ? q.map(() => [1, 0] as [number, number]) : q.map((v) => [v[0] / TILE_LENGTH, v[2] / TILE_LENGTH] as [number, number]);
        to.quad(q[0]!, q[1]!, q[2]!, q[3]!, uvs, n);
      }
    }
  }

  /** The verge lip round a junction's outline, outward from its centre. */
  private junctionVerge(to: Builder, outline: [number, number][], cx: number, cz: number, y: number): void {
    for (let i = 0; i < outline.length; i++) {
      const [ax, az] = outline[i]!;
      const [bx, bz] = outline[(i + 1) % outline.length]!;
      const out = (x: number, z: number): [number, number] => {
        const d = Math.hypot(x - cx, z - cz) || 1;
        return [x + ((x - cx) / d) * VERGE_OUT, z + ((z - cz) / d) * VERGE_OUT];
      };
      const [aox, aoz] = out(ax, az);
      const [box, boz] = out(bx, bz);
      const uv = (x: number, z: number): [number, number] => [x / TILE_LENGTH, z / TILE_LENGTH];
      to.quad([ax, y, az], [bx, y, bz], [box, y - VERGE_DROP, boz], [aox, y - VERGE_DROP, aoz], [uv(ax, az), uv(bx, bz), uv(box, boz), uv(aox, aoz)], [(ax + bx) / 2 - cx, 1, (az + bz) / 2 - cz]);
    }
  }

  /**
   * Painted lines: thin strips a few millimetres over the asphalt. Not ruler-straight: each wanders
   * a centimetre or two and varies a little in width, dashes are not all one length, and some are
   * more worn than others - the way a road painted by a machine on a lorry looks.
   */
  private lines(to: Builder, laid: LaidRoad, samples: RoadSample[]): void {
    const set = linesOf(laid.section);
    if (!set.length) return;
    const s0 = samples[0]!.s;
    const s1 = samples[samples.length - 1]!.s;
    const crossings = laid.road.crossings ?? [];
    const seed = laid.index * 7.31;
    // Where overtaking is not allowed along it: on bends and near its ends.
    const street = laid.section.passing === "street";
    const nearEnd = street ? STREET_NO_PASSING_NEAR_END : NO_PASSING_NEAR_END;
    // A closed loop has no ends: its lines run on round through its seam, solid ones unbroken; so
    // do they through a seamless joint into the next segment.
    const closed = !!laid.closed && s1 - s0 > 30;
    const openStart = closed || !!laid.runsOn?.[0];
    const openEnd = closed || !!laid.runsOn?.[1];
    const endStart = openStart ? 0 : 0.5;
    const endEnd = openEnd ? 0 : 0.5;
    const wrap = (s: number): number => (closed ? s0 + ((((s - s0) % (s1 - s0)) + (s1 - s0)) % (s1 - s0)) : s);
    const noPassing = (s: number): boolean => {
      if ((!openStart && s - s0 < nearEnd) || (!openEnd && s1 - s < nearEnd)) return true;
      const a = sampleAt(samples, closed ? wrap(s - 12) : Math.max(s0, s - 12));
      const b = sampleAt(samples, closed ? wrap(s + 12) : Math.min(s1, s + 12));
      const angle = Math.abs(Math.atan2(a.dx * b.dz - a.dz * b.dx, a.dx * b.dx + a.dz * b.dz));
      return angle > 1e-4 && (closed ? 24 : b.s - a.s) / angle < NO_PASSING_RADIUS;
    };
    // True to its nominal offset and width at its ends, so a line carried on through a junction
    // (`throughLines`) meets it exactly.
    const steady = (s: number): number => (closed ? 1 : Math.min(1, Math.max(0, (Math.min(openStart ? Infinity : s - s0, openEnd ? Infinity : s1 - s) - 0.5) / 3)));
    // Round a closed loop, a line's wobble runs on through the seam: its first metres blend from
    // where its last left off.
    const onward =
      (f: (s: number) => number) =>
      (s: number): number => {
        if (!closed || s - s0 >= 6) return f(s);
        const t = (s - s0) / 6;
        return f(s + (s1 - s0)) * (1 - t) + f(s) * t;
      };
    set.forEach((line, l) => {
      const across = line.across;
      const colour = line.yellow ? PAINT_YELLOW : PAINT_WHITE;
      // Pieces of line: [from, to, wear, offset]: a dash each, or whole runs for solid ones; a
      // centre line's double solid where overtaking is not allowed, its dashes where it is.
      const pieces: [number, number, number, number][] = [];
      const dashes = (from: number, until: number, at: number): void => {
        for (let k = 0, s = from + 1.5; s < until - 1; k++) {
          const on = 3 + (hash(seed + l, k) - 0.5) * 0.5;
          const off = 9 + (hash(seed + l + 50, k) - 0.5) * 0.8;
          pieces.push([s, Math.min(until - 1, s + on), 0.82 + hash(seed + l + 9, k) * 0.18, at]);
          s += on + off;
        }
      };
      if (line.centre) {
        // Runs of one kind or the other, a metre at a time.
        const runs: { from: number; until: number; blocked: boolean }[] = [];
        for (let s = s0 + endStart; s < s1 - endEnd; s += 1) {
          const blocked = !line.dashed || noPassing(s);
          const last = runs[runs.length - 1];
          if (last && last.blocked === blocked) last.until = Math.min(s1 - endEnd, s + 1);
          else runs.push({ from: s, until: Math.min(s1 - endEnd, s + 1), blocked });
        }
        // A stretch where overtaking would be allowed but too short for more than a dash or two is
        // no passing zone at all: a lone dash between two double lines looks like a mistake.
        for (const run of runs) if (!run.blocked && run.until - run.from < (street ? STREET_MIN_PASSING : MIN_PASSING)) run.blocked = true;
        const merged: typeof runs = [];
        for (const run of runs) {
          const last = merged[merged.length - 1];
          if (last && last.blocked === run.blocked) last.until = run.until;
          else merged.push({ ...run });
        }
        for (const run of merged)
          if (run.blocked) for (const side of [-1, 1]) pieces.push([run.from, run.until, 0.9, across + side * DOUBLE_GAP]);
          else dashes(run.from, run.until, across);
      } else if (line.dashed) dashes(s0, s1, across);
      else pieces.push([s0 + endStart, s1 - endEnd, 0.9, across]);
      for (const [a, b, wear, at] of pieces) {
        const shade = [colour[0] * wear, colour[1] * wear, colour[2] * wear] as const;
        // Cut round each crossing's stripes.
        const cuts = [a];
        for (const c of crossings)
          if (c + 2.5 > a && c - 2.5 < b) {
            cuts.push(c - 2.5, c + 2.5);
          }
        cuts.push(b);
        for (let k = 0; k + 1 < cuts.length; k += 2) {
          const from = Math.max(a, cuts[k]!);
          const until = Math.min(b, cuts[k + 1]!);
          if (until - from < 0.3) continue;
          this.strip(
            to,
            samples,
            from,
            until,
            onward((s) => at + wander(s, seed + l) * steady(s)),
            onward((s) => line.width * (1 + 0.08 * Math.sin(s * 0.53 + seed) * steady(s))),
            shade,
          );
        }
      }
    });
  }

  /** One strip of paint along a road between two distances, at an offset and width that may vary. */
  private strip(to: Builder, samples: RoadSample[], from: number, until: number, offset: (s: number) => number, width: (s: number) => number, shade: number | readonly [number, number, number]): void {
    // A vertex at every one of the road's own samples as well as every metre and a half: the
    // asphalt bends at its samples, and a stripe cut straight across a bend (over a crest, off a
    // level junction) dips under it, the line vanishing for a metre with a stub left before it.
    const steps = Math.max(1, Math.ceil((until - from) / 1.5));
    const at = new Set<number>();
    for (let k = 0; k <= steps; k++) at.add(from + ((until - from) * k) / steps);
    for (const p of samples) if (p.s > from && p.s < until) at.add(p.s);
    let prev: [number, number, number][] | null = null;
    let i = 0;
    for (const s of [...at].sort((x, y) => x - y)) {
      const o = offset(s);
      const w = width(s) / 2;
      // Where the asphalt's mesh is, not where the curve is: the asphalt is flat quads from one
      // sample's row to the next, so a point is blended between the two rows' points at its
      // offset, height and all. A point put on the true curve instead lands, on the inside of a
      // tight bend (where the rows crowd together), in the next quad along - on a climb, a few
      // centimetres higher than the paint - and the line is under the road there.
      while (i < samples.length - 2 && samples[i + 1]!.s < s) i++;
      const a = samples[i]!;
      const b = samples[Math.min(i + 1, samples.length - 1)]!;
      const f = b.s > a.s ? Math.min(1, Math.max(0, (s - a.s) / (b.s - a.s))) : 0;
      const edge = [this.paintPoint(a, b, f, o - w), this.paintPoint(a, b, f, o + w)];
      if (prev)
        to.quad(
          prev[0]!,
          prev[1]!,
          edge[1]!,
          edge[0]!,
          [
            [0, 0],
            [0, 0],
            [0, 0],
            [0, 0],
          ],
          [0, 1, 0],
          shade,
        );
      prev = edge;
    }
  }

  /**
   * A point of paint on the asphalt's mesh between two of a road's samples (`f` of the way from
   * `a` to `b`), `d` across: blended between the two rows' points at that offset, as the asphalt's
   * quads are, and lifted to paint height.
   */
  private paintPoint(a: RoadSample, b: RoadSample, f: number, d: number): [number, number, number] {
    const [ax, az] = acrossRoad(a, d);
    const [bx, bz] = acrossRoad(b, d);
    const ya = this.surfaceY(ax, az, a.y);
    const yb = this.surfaceY(bx, bz, b.y);
    return [ax + (bx - ax) * f, ya + (yb - ya) * f + PAINT_LIFT, az + (bz - az) * f];
  }

  /**
   * A convex patch of paint on a road, its points [along, across]: cut at each of the road's
   * sample rows, so every piece lies on one row of the asphalt's quads and bends with the road
   * over a crest or a dip, and each piece's points put on the mesh as `strip`'s are.
   */
  private patch(to: Builder, samples: RoadSample[], poly: [number, number][], shade: readonly [number, number, number]): void {
    const along = poly.map((p) => p[0]);
    const lo = Math.max(Math.min(...along), samples[0]!.s);
    const hi = Math.min(Math.max(...along), samples[samples.length - 1]!.s);
    if (hi - lo < 1e-3) return;
    const cuts = [lo, ...samples.filter((p) => p.s > lo + 1e-4 && p.s < hi - 1e-4).map((p) => p.s), hi];
    let i = 0;
    for (let k = 0; k + 1 < cuts.length; k++) {
      const s0 = cuts[k]!;
      const s1 = cuts[k + 1]!;
      const piece = clipHalf(
        clipHalf(poly, (v) => v[0] - s0),
        (v) => s1 - v[0],
      );
      if (piece.length < 3) continue;
      // The row these lie on: the samples either side of the slab's middle.
      const mid = (s0 + s1) / 2;
      while (i < samples.length - 2 && samples[i + 1]!.s < mid) i++;
      const a = samples[i]!;
      const b = samples[i + 1]!;
      const pts = piece.map(([s, o]) => this.paintPoint(a, b, b.s > a.s ? Math.min(1, Math.max(0, (s - a.s) / (b.s - a.s))) : 0, o));
      for (let j = 1; j + 1 < pts.length; j++)
        to.tri(
          pts[0]!,
          pts[j]!,
          pts[j + 1]!,
          [
            [0, 0],
            [0, 0],
            [0, 0],
          ],
          [0, 1, 0],
          shade,
        );
    }
  }

  /**
   * A road's lane marks (`lane-marks.ts`): a stop bar on each approach that has one, and where a
   * main street splits for turns, the white line between its lanes and an arrow in each.
   */
  private laneMarks(to: Builder, laid: LaidRoad, samples: RoadSample[], marks: RoadMarks): void {
    if (samples.length < 2) return;
    const seed = laid.index * 3.7;
    const worn = (k: number, base = 0.84): readonly [number, number, number] => {
      const wear = base + hash(seed, k) * (0.96 - base);
      return [PAINT_WHITE[0] * wear, PAINT_WHITE[1] * wear, PAINT_WHITE[2] * wear];
    };
    const lo = samples[0]!.s;
    const hi = samples[samples.length - 1]!.s;
    marks.lines.forEach((line, k) => {
      const from = Math.max(lo, line.s0);
      const until = Math.min(hi, line.s1);
      if (until - from < 0.3) return;
      const shade = worn(300 + k, 0.86);
      if (!line.dashed) {
        this.strip(
          to,
          samples,
          from,
          until,
          () => line.offset,
          () => 0.12,
          shade,
        );
        return;
      }
      // Short dashes, as a lane line toward a junction is: counted back from its solid end (ahead of
      // the traffic on its side: right of the centre runs toward the road's end), a whole gap short of it.
      const forward = line.offset > 0;
      for (let s = forward ? until - LANE_GAP : from + LANE_GAP; forward ? s - LANE_DASH > from : s + LANE_DASH < until; s += forward ? -(LANE_DASH + LANE_GAP) : LANE_DASH + LANE_GAP) {
        const a = forward ? s - LANE_DASH : s;
        this.strip(
          to,
          samples,
          a,
          a + LANE_DASH,
          () => line.offset,
          () => 0.12,
          shade,
        );
      }
    });
    marks.approaches.forEach((approach, k) => {
      const { stop } = approach;
      if (stop?.dashed) {
        // A give-way line: dashes across the lanes, wider than a stop bar is deep.
        const lo = Math.min(stop.o0, stop.o1);
        const hi = Math.max(stop.o0, stop.o1);
        const n = Math.max(1, Math.round((hi - lo) / 1.2));
        const w = (hi - lo) / n;
        for (let d = 0; d < n; d++)
          this.strip(
            to,
            samples,
            stop.s0 - 0.1,
            stop.s1 + 0.1,
            () => lo + (d + 0.5) * w,
            () => w * 0.55,
            worn(100 + k * 9 + d, 0.88),
          );
      } else if (stop)
        this.strip(
          to,
          samples,
          stop.s0,
          stop.s1,
          () => (stop.o0 + stop.o1) / 2,
          () => Math.abs(stop.o1 - stop.o0),
          worn(100 + k, 0.88),
        );
      approach.arrows.forEach((arrow, n) => {
        const shade = worn(200 + k * 7 + n, 0.86);
        for (const piece of arrowShape(arrow.turns)) {
          // Forward along the way it is driven, right of it across.
          const poly = piece.map(([f, r]) => [arrow.s + arrow.sign * f, arrow.offset + arrow.sign * r] as [number, number]);
          this.patch(to, samples, poly, shade);
        }
      });
    });
  }

  /** The view's own layout's junctions, by node id. */
  private junctionLookup(): (id: number) => Junction | undefined {
    const layout = this.network();
    if (this.byNode?.layout !== layout) this.byNode = { layout, junctions: new Map(layout.junctions.map((j) => [j.node.id, j])) };
    const junctions = this.byNode.junctions;
    return (id) => junctions.get(id);
  }

  /** A zebra at each of a road's crossings: bars along the road, a metre apart, across its width. */
  private zebras(to: Builder, laid: LaidRoad, samples: RoadSample[]): void {
    const s0 = samples[0]!.s;
    const s1 = samples[samples.length - 1]!.s;
    for (const c of laid.road.crossings ?? []) {
      if (c - 1.5 < s0 || c + 1.5 > s1) continue;
      const seed = c * 3.1 + laid.index;
      for (let across = -laid.half + 0.8; across <= laid.half - 0.7; across += 1) {
        const wear = 0.85 + hash(seed, across) * 0.15;
        const shade = [PAINT_WHITE[0] * wear, PAINT_WHITE[1] * wear, PAINT_WHITE[2] * wear] as const;
        this.strip(
          to,
          samples,
          c - 1.5,
          c + 1.5,
          (s) => across + wander(s, seed) * 0.5,
          () => 0.5,
          shade,
        );
      }
    }
  }

  /**
   * The zebras across a road's ends at its junctions (`JunctionCrossing`): bars along the road a
   * metre apart across its lanes, from `c0` to `c1` out from the node, on the junction's flat
   * asphalt (the road's own centre line, held level there).
   */
  private junctionZebras(to: Builder, laid: LaidRoad, junctionAt: (id: number) => Junction | undefined): void {
    const samples = laid.samples;
    if (samples.length < 2) return;
    const length = samples[samples.length - 1]!.s;
    for (const end of [0, 1] as const) {
      const id = end === 0 ? laid.road.from : laid.road.to;
      const junction = id === undefined ? undefined : junctionAt(id);
      for (const z of junction?.crossings ?? []) {
        if (z.road !== laid.index || z.end !== end) continue;
        const s0 = end === 0 ? z.c0 : length - z.c1;
        const s1 = end === 0 ? z.c1 : length - z.c0;
        if (s0 < 0 || s1 > length || s1 - s0 < 0.5) continue;
        const seed = s0 * 3.1 + laid.index;
        const band = laid.section.band;
        for (let across = -band + 0.8; across <= band - 0.7; across += 1) {
          const wear = 0.85 + hash(seed, across) * 0.15;
          const shade = [PAINT_WHITE[0] * wear, PAINT_WHITE[1] * wear, PAINT_WHITE[2] * wear] as const;
          this.strip(
            to,
            samples,
            s0,
            s1,
            (s) => across + wander(s, seed) * 0.5,
            () => 0.5,
            shade,
          );
        }
      }
    }
  }

  /** A road's sidewalk on one side: a kerb face, the paving on top, and a skirt down to the ground outside. */
  private sidewalks(to: Builder, laid: LaidRoad, all: RoadSample[], side: 1 | -1): void {
    const one = this.side(laid, side);
    {
      // Points where a driveway's dropped kerb starts and ends, so it is drawn square.
      const samples = withDriveBreaks(laid, all, side);
      const top = walkTops(laid, samples, side, all[0]!.s, all[all.length - 1]!.s);
      const inner = kerbTops(laid, samples, side, top);
      const edge = samples.map((p, k) => {
        const nx = -p.dz * side;
        const nz = p.dx * side;
        // The kerb stepped back where it has parking bays.
        const [ix, iz] = acrossRoad(p, side * (laid.half + kerbStep(one, p.s)));
        const [ox, oz] = acrossRoad(p, side * (laid.half + one.walk));
        const y = this.surfaceY(ix, iz, p.y);
        return { ix, iz, ox, oz, y, nx, nz, top: top[k]!, inner: inner[k]!, s: p.s };
      });
      // Across a driveway the paving is left out: the site's driveway is laid there in asphalt, from
      // the dropped kerb back to its lot (`site`), and the sidewalk slopes down to it either side.
      const drives = (laid.drives ?? []).filter((d) => d.side === side);
      // A curved mouth's corners lie on the sloped paving either side of its own width.
      this.walkStrip(to, edge, (a, b) => drives.some((d) => a.s! >= (d.core?.[0] ?? d.s0) - 1e-3 && b.s! <= (d.core?.[1] ?? d.s1) + 1e-3));
    }
  }

  /** Where round a cul-de-sac's kerb (its first corner's curve, by distance along it) houses' driveways cross its sidewalk. */
  private bulbDrops(junction: Junction): [number, number, number, number][] {
    return [];
  }

  /**
   * A sidewalk round a junction's corner curve: outward from the curve by `width`. Across `drops`
   * (stretches by distance along the curve) its kerb is dropped and its paving left out, sloping
   * down to it either side, as along a road (`kerbTops`).
   */
  private cornerWalk(to: Builder, given: [number, number][], from: number, until: number, y0: number, drops: [number, number, number?, number?][] = []): void {
    // Points where a dropped kerb starts and ends, so it is drawn square.
    const curve: [number, number][] = [given[0]!];
    const along: number[] = [0];
    const breaks = drops.flatMap(([c0, c1, k0, k1]) => [c0 - DRIVE_TAPER, c0, c1, c1 + DRIVE_TAPER, ...(k0 !== undefined && k1 !== undefined ? [k0, k1] : [])]).sort((a, b) => a - b);
    let run = 0;
    for (let k = 0; k + 1 < given.length; k++) {
      const [ax, az] = given[k]!;
      const [bx, bz] = given[k + 1]!;
      const len = Math.hypot(bx - ax, bz - az);
      for (const c of breaks)
        if (c > run + 0.05 && c < run + len - 0.05) {
          const t = (c - run) / len;
          curve.push([ax + (bx - ax) * t, az + (bz - az) * t]);
          along.push(c);
        }
      run += len;
      curve.push(given[k + 1]!);
      along.push(run);
    }
    const n = curve.length;
    // Counter-clockwise round the junction: outward is to the right of travel.
    const normal = (k: number): [number, number] => {
      const [px, pz] = curve[k]!;
      const [qx, qz] = curve[k + 1]!;
      const len = Math.hypot(qx - px, qz - pz) || 1;
      return [(qz - pz) / len, -(qx - px) / len];
    };
    const edge = curve.map(([x, z], k) => {
      // Mitred: the two legs' normals averaged, stretched so the width holds round a sharp corner.
      const n1 = normal(Math.max(0, k - 1));
      const n2 = normal(Math.min(n - 2, k));
      let nx = n1[0] + n2[0];
      let nz = n1[1] + n2[1];
      const len = Math.hypot(nx, nz) || 1;
      nx /= len;
      nz /= len;
      const stretch = 1 / Math.max(0.5, nx * n1[0] + nz * n1[1]);
      // Tapering from one road's sidewalk width to the other's (a smoothstep, so it eases out).
      const f = n > 1 ? k / (n - 1) : 0;
      const width = from + (until - from) * f * f * (3 - 2 * f);
      // The kerb dropped across a driveway, coming back up over `DRIVE_TAPER` either side.
      let t = 1;
      for (const [c0, c1] of drops) t = Math.min(t, Math.max(c0 - along[k]!, along[k]! - c1, 0) / DRIVE_TAPER);
      return {
        ix: x,
        iz: z,
        ox: x + nx * width * stretch,
        oz: z + nz * width * stretch,
        y: this.surfaceY(x, z, y0),
        nx,
        nz,
        top: KERB,
        inner: Math.min(KERB, DRIVE_FOOT + (KERB - DRIVE_FOOT) * Math.min(1, Math.max(0, t))),
        s: along[k]!,
      };
    });
    this.walkStrip(to, edge, (a, b) => drops.some(([c0, c1, k0, k1]) => a.s! >= (k0 ?? c0) - 1e-3 && b.s! <= (k1 ?? c1) + 1e-3));
  }

  private walkStrip(
    to: Builder,
    edge: { ix: number; iz: number; ox: number; oz: number; y: number; nx: number; nz: number; top?: number; inner?: number; s?: number }[],
    /** Stretches whose paving is left out (a driveway's), by the edge points either end. */
    bare: (a: (typeof edge)[number], b: (typeof edge)[number]) => boolean = () => false,
  ): void {
    for (let k = 0; k + 1 < edge.length; k++) {
      const a = edge[k]!;
      const b = edge[k + 1]!;
      const ta = a.top ?? KERB;
      const tb = b.top ?? KERB;
      // The kerb's own height: lower across a driveway, the paving sloping up from it.
      const ia = a.inner ?? ta;
      const ib = b.inner ?? tb;
      const out: [number, number, number] = [a.nx, 0, a.nz];
      const inward: [number, number, number] = [-a.nx, 0, -a.nz];
      const kerb = [KERB_UV, KERB_UV, KERB_UV, KERB_UV];
      // Kerb face, from the road up.
      to.quad([a.ix, a.y, a.iz], [b.ix, b.y, b.iz], [b.ix, b.y + ib, b.iz], [a.ix, a.y + ia, a.iz], kerb, inward);
      // Paving.
      if (!bare(a, b)) to.quad([a.ix, a.y + ia, a.iz], [b.ix, b.y + ib, b.iz], [b.ox, b.y + tb, b.oz], [a.ox, a.y + ta, a.oz], [PAVING_UV, PAVING_UV, PAVING_UV, PAVING_UV]);
      // Skirt, down past the ground, so a slope beside it never shows a gap under its edge.
      to.quad([a.ox, a.y + ta, a.oz], [b.ox, b.y + tb, b.oz], [b.ox, b.y - 0.6, b.oz], [a.ox, a.y - 0.6, a.oz], kerb, out);
    }
  }

  /**
   * A block's paving: its outline filled, cut small enough to follow the ground, at kerb height. Not
   * over `cuts` (convex outlines: a site's lot), which are cut out of each triangle exactly - a hole
   * handed to the triangulator next to the outline's own edge came out wrong.
   */
  private paving(to: Builder, outline: [number, number][], lift = KERB, cuts: [number, number][][] = [], uv: [number, number] = PAVING_UV, world = false, fine = 6): void {
    const tris = ShapeUtils.triangulateShape(
      outline.map(([x, z]) => new Vector2(x, z)),
      [],
    );
    // Cut finer than the old paving (a lot, a lawn): over the ground as drawn where it is higher, never under it.
    const y = (x: number, z: number): number => (fine < 6 ? Math.max(heightAt(this.terrain, x, z), meshHeightAt(this.terrain, x, z)) : heightAt(this.terrain, x, z)) + lift;
    const emit = (a: [number, number], b: [number, number], c: [number, number]): void => {
      // Each cut takes its part out: what is outside each of its edges in turn is kept, the rest
      // goes on to the next edge, and what is left at the end is inside it.
      let pieces: [number, number][][] = [[a, b, c]];
      for (const cut of cuts) {
        const next: [number, number][][] = [];
        for (const piece of pieces) {
          let rest = piece;
          for (let k = 0; k < cut.length && rest.length >= 3; k++) {
            const p = cut[k]!;
            const q = cut[(k + 1) % cut.length]!;
            // Counter-clockwise: inside is to the left of each edge.
            const side = (v: [number, number]): number => (q[0] - p[0]) * (v[1] - p[1]) - (q[1] - p[1]) * (v[0] - p[0]);
            const outside = clipHalf(rest, (v) => -side(v));
            if (outside.length >= 3) next.push(outside);
            rest = clipHalf(rest, side);
          }
        }
        pieces = next;
      }
      for (const piece of pieces) for (let k = 1; k + 1 < piece.length; k++) split(piece[0]!, piece[k]!, piece[k + 1]!, 0);
    };
    const uvs: [number, number][] = [uv, uv, uv];
    // In world space (a lot's asphalt, laid like the roads'), or one patch of the atlas.
    const uvOf = (p: [number, number]): [number, number] => (world ? [p[0] / TILE_LENGTH, p[1] / TILE_LENGTH] : uv);
    const split = (a: [number, number], b: [number, number], c: [number, number], depth: number): void => {
      const ab = Math.hypot(a[0] - b[0], a[1] - b[1]);
      const bc = Math.hypot(b[0] - c[0], b[1] - c[1]);
      const ca = Math.hypot(c[0] - a[0], c[1] - a[1]);
      const longest = Math.max(ab, bc, ca);
      if (longest < fine || depth > 14) {
        to.tri([a[0], y(...a), a[1]], [b[0], y(...b), b[1]], [c[0], y(...c), c[1]], world ? [uvOf(a), uvOf(b), uvOf(c)] : uvs);
        return;
      }
      // Halve the longest side.
      if (longest === ab) {
        const m: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        split(a, m, c, depth + 1);
        split(m, b, c, depth + 1);
      } else if (longest === bc) {
        const m: [number, number] = [(b[0] + c[0]) / 2, (b[1] + c[1]) / 2];
        split(a, b, m, depth + 1);
        split(a, m, c, depth + 1);
      } else {
        const m: [number, number] = [(c[0] + a[0]) / 2, (c[1] + a[1]) / 2];
        split(a, b, m, depth + 1);
        split(m, b, c, depth + 1);
      }
    };
    for (const t of tris) {
      const a = outline[t[0]!]!;
      const b = outline[t[1]!]!;
      const c = outline[t[2]!]!;
      if (cuts.length) emit(a, b, c);
      else split(a, b, c, 0);
    }
  }

  /**
   * A bridge under a run of a road: a deck slab under the asphalt, a parapet either side, and a
   * pier down to the ground every 16 m.
   */
  private bridge(to: Builder, run: RoadSample[], road: number, half: number): void {
    const uv: [number, number][] = [
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
    ];
    const DECK = 1.1;
    const WALL = 0.35;
    const at = (p: RoadSample, k: number, up: number): [number, number, number] => {
      const [x, z] = acrossRoad(p, k);
      return [x, p.y + up, z];
    };
    for (let i = 0; i + 1 < run.length; i++) {
      const a = run[i]!;
      const b = run[i + 1]!;
      for (const side of [-1, 1]) {
        const o = side * (half + WALL);
        const n: [number, number, number] = [-a.dz * side, 0, a.dx * side];
        const inward: [number, number, number] = [a.dz * side, 0, -a.dx * side];
        // Outer face, from under the deck to the parapet's top.
        to.quad(at(a, o, -DECK), at(b, o, -DECK), at(b, o, RAILING), at(a, o, RAILING), uv, n);
        // Inner face of the parapet, and its top.
        to.quad(at(a, side * half, 0), at(b, side * half, 0), at(b, side * half, RAILING), at(a, side * half, RAILING), uv, inward);
        to.quad(at(a, side * half, RAILING), at(b, side * half, RAILING), at(b, o, RAILING), at(a, o, RAILING), uv);
      }
      // Underside.
      to.quad(at(a, -half - WALL, -DECK), at(b, -half - WALL, -DECK), at(b, half + WALL, -DECK), at(a, half + WALL, -DECK), uv, [0, -1, 0]);
      // The deck's top between the asphalt's edge and the parapet: no gap to see the water through.
      for (const side of [-1, 1]) to.quad(at(a, side * road, ROAD_LIFT), at(b, side * road, ROAD_LIFT), at(b, side * half, ROAD_LIFT), at(a, side * half, ROAD_LIFT), uv);
    }
    // Its two ends: the deck's edge under the road, and each parapet's end.
    for (const [p, out] of [
      [run[0]!, -1],
      [run[run.length - 1]!, 1],
    ] as const) {
      const n: [number, number, number] = [p.dx * out, 0, p.dz * out];
      to.quad(at(p, -half - WALL, -DECK), at(p, half + WALL, -DECK), at(p, half + WALL, 0), at(p, -half - WALL, 0), uv, n);
      for (const side of [-1, 1]) to.quad(at(p, side * half, 0), at(p, side * (half + WALL), 0), at(p, side * (half + WALL), RAILING), at(p, side * half, RAILING), uv, n);
    }
    // Piers, standing on the bed.
    const s0 = run[0]!.s;
    const s1 = run[run.length - 1]!.s;
    for (let s = s0 + 8; s < s1 - 6; s += 16) {
      const p = sampleAt(run, s);
      const ground = heightAt(this.terrain, p.x, p.z) - 1;
      const top = p.y - 1.1;
      if (top - ground < 1) continue;
      const w = half * 0.7;
      const d = 0.8;
      const corner = (k: number, j: number, y: number): [number, number, number] => [p.x - p.dz * k * w + p.dx * j * d, y, p.z + p.dx * k * w + p.dz * j * d];
      const faces: [number, number, number, number][] = [
        [-1, -1, 1, -1],
        [1, -1, 1, 1],
        [1, 1, -1, 1],
        [-1, 1, -1, -1],
      ];
      for (const [k0, j0, k1, j1] of faces) {
        const out: [number, number, number] = [(-p.dz * (k0 + k1) + p.dx * (j0 + j1)) / 2, 0, (p.dx * (k0 + k1) + p.dz * (j0 + j1)) / 2];
        to.quad(corner(k0, j0, ground), corner(k1, j1, ground), corner(k1, j1, top), corner(k0, j0, top), uv, out);
      }
    }
  }

  /**
   * A road's guard rails (posts every two metres and a beam along them, ends turned down into the
   * ground), its reflector posts (white, a black band and an amber reflector) and its curve
   * chevrons (a yellow board with black arrows on a post, both faces pointing into the bend).
   */
  private roadside(to: Builder, side: Roadside): void {
    const box = (cx: number, y0: number, cz: number, hx: number, hy: number, hz: number, dx: number, dz: number, colour: readonly [number, number, number]): void => {
      // A box turned to the road: hx along it, hz across it.
      const ax = dx * hx;
      const az = dz * hx;
      const bx = -dz * hz;
      const bz = dx * hz;
      const c = (sx: number, sy: number, sz: number): [number, number, number] => [cx + ax * sx + bx * sz, y0 + hy * (sy + 1), cz + az * sx + bz * sz];
      const uv: [number, number][] = [
        [0, 0],
        [0, 0],
        [0, 0],
        [0, 0],
      ];
      const faces: [number, number, number][][] = [
        [c(-1, -1, 1), c(1, -1, 1), c(1, 1, 1), c(-1, 1, 1)],
        [c(1, -1, -1), c(-1, -1, -1), c(-1, 1, -1), c(1, 1, -1)],
        [c(1, -1, 1), c(1, -1, -1), c(1, 1, -1), c(1, 1, 1)],
        [c(-1, -1, -1), c(-1, -1, 1), c(-1, 1, 1), c(-1, 1, -1)],
        [c(-1, 1, 1), c(1, 1, 1), c(1, 1, -1), c(-1, 1, -1)],
      ];
      const centre: [number, number, number] = [cx, y0 + hy, cz];
      for (const f of faces) {
        const mx = (f[0]![0] + f[2]![0]) / 2 - centre[0];
        const my = (f[0]![1] + f[2]![1]) / 2 - centre[1];
        const mz = (f[0]![2] + f[2]![2]) / 2 - centre[2];
        to.quad(f[0]!, f[1]!, f[2]!, f[3]!, uv, [mx, my, mz], colour);
      }
    };
    const uv: [number, number][] = [
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
    ];
    for (const rail of side.rails) {
      // Pieces of a pack's barrier are placed as street furniture (`network.ts`), not drawn here.
      if (rail.kind !== "guard-rail") continue;
      const pts = rail.points;
      const last = pts.length - 1;
      // Out from the posts toward the road: the W-beam stands proud of its posts on blocks.
      const nx = (k: number): number => rail.dz[k]! * rail.side;
      const nz = (k: number): number => -rail.dx[k]! * rail.side;
      // The beam eases down into the ground over its first and last few metres (a buried end).
      const lift = (k: number): number => Math.min(1, k / 2.5, (last - k) / 2.5);
      for (let k = 0; k <= last; k++) {
        const p = pts[k]!;
        // A post every 6 ft 3 in (here every sample, 2 m): a wooden post and its blockout.
        if (lift(k) > 0.5) {
          box(p[0] - nx(k) * 0.06, p[1] - 0.35, p[2] - nz(k) * 0.06, 0.08, (0.35 + RAIL_TOP * 0.95) / 2, 0.1, rail.dx[k]!, rail.dz[k]!, WOOD);
          box(p[0] + nx(k) * 0.1, p[1] + RAIL_TOP - 0.36, p[2] + nz(k) * 0.1, 0.075, 0.17, 0.08, rail.dx[k]!, rail.dz[k]!, WOOD_DARK);
        }
        if (k === last) break;
        const q = pts[k + 1]!;
        // The W: three bands across its face (upper fold, the groove, lower fold), each a quad.
        const bands: [number, number, number, readonly [number, number, number]][] = [
          [0.0, 0.1, 0.2, RAIL_GREY],
          [0.1, 0.21, 0.13, RAIL_SHADE],
          [0.21, 0.31, 0.2, RAIL_GREY],
        ];
        const at = (i: number, pt: [number, number, number], down: number, out: number): [number, number, number] => {
          const t = lift(i);
          const y = pt[1] + (RAIL_TOP - down) * t + (t - 1) * 0.35;
          return [pt[0] + nx(i) * out, y, pt[2] + nz(i) * out];
        };
        for (const [top, bottom, out, colour] of bands) {
          const a0 = at(k, p, bottom, out);
          const a1 = at(k, p, top, out);
          const b0 = at(k + 1, q, bottom, out);
          const b1 = at(k + 1, q, top, out);
          to.quad(a0, b0, b1, a1, uv, [nx(k), 0, nz(k)], colour);
        }
        // Its back and top, so it is solid from behind and above.
        const c0 = at(k, p, 0.31, 0.12);
        const c1 = at(k, p, 0, 0.12);
        const d0 = at(k + 1, q, 0.31, 0.12);
        const d1 = at(k + 1, q, 0, 0.12);
        to.quad(c1, d1, d0, c0, uv, [-nx(k), 0, -nz(k)], RAIL_SHADE);
        to.quad(at(k, p, 0, 0.2), at(k + 1, q, 0, 0.2), d1, c1, uv, [0, 1, 0], RAIL_GREY);
      }
    }
    for (const post of side.posts) {
      // A flexible delineator: a flat white post as tall as a car's bonnet, a dark band round its
      // head and a big reflector on it facing each way, so it reads as a marker, not a stick.
      const [x, y, z] = post.at;
      box(x, y - 0.15, z, 0.014, 0.72, 0.06, post.dx, post.dz, POST_WHITE);
      box(x, y + 0.9, z, 0.017, 0.2, 0.063, post.dx, post.dz, POST_BAND);
      box(x, y + 0.98, z, 0.02, 0.11, 0.045, post.dx, post.dz, REFLECTOR);
    }
    for (const sign of side.chevrons) {
      // MUTCD W1-8: an 18 x 24 in yellow board with a black border and one black chevron pointing
      // into the bend, its bottom 5 ft over the road, on a square galvanised post. Back to back,
      // so traffic each way reads it.
      const [x, y, z] = sign.at;
      box(x, y - 0.4, z, 0.025, 1.2, 0.025, sign.dx, sign.dz, POST_GREY);
      const bx = -sign.dz;
      const bz = sign.dx;
      const bottom = y + 1.55;
      const w = 0.23;
      const h = 0.3;
      const cy = bottom + h;
      for (const face of [1, -1]) {
        const p = (u: number, v: number, lift: number): [number, number, number] => [x + bx * u + sign.dx * face * lift, cy + v, z + bz * u + sign.dz * face * lift];
        const facing: [number, number, number] = [sign.dx * face, 0, sign.dz * face];
        to.quad(p(-w, -h, 0.03), p(w, -h, 0.03), p(w, h, 0.03), p(-w, h, 0.03), uv, facing, SIGN_BLACK);
        to.quad(p(-w + 0.02, -h + 0.02, 0.035), p(w - 0.02, -h + 0.02, 0.035), p(w - 0.02, h - 0.02, 0.035), p(-w + 0.02, h - 0.02, 0.035), uv, facing, SIGN_YELLOW);
        // One chevron, its point toward the inside of the bend.
        const d = sign.turn;
        const c = (u: number, v: number): [number, number, number] => p(d * u, v, 0.04);
        to.quad(c(-0.11, 0.2), c(-0.01, 0.2), c(0.12, 0), c(0.02, 0), uv, facing, SIGN_BLACK);
        to.quad(c(0.02, 0), c(0.12, 0), c(-0.01, -0.2), c(-0.11, -0.2), uv, facing, SIGN_BLACK);
      }
    }
  }
}

/** For each edge of a junction's outline (from point i to i + 1), whether it runs straight across one of its roads' ends. */
const mouths = junctionMouths;

/**
 * Where a junction's arm meets its asphalt: the middle of its mouth, and the unit direction out
 * along the road from there (square to the mouth).
 */
function mouthOf(junction: Junction, arm: Arm): { x: number; z: number; ox: number; oz: number } | null {
  const { node, outline } = junction;
  const mouth = mouths(junction);
  for (let i = 0; i < outline.length; i++) {
    if (!mouth[i]) continue;
    const a = outline[i]!;
    const b = outline[(i + 1) % outline.length]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const x = (a[0] + b[0]) / 2;
    const z = (a[1] + b[1]) / 2;
    const md = Math.hypot(x - node.x, z - node.z) || 1;
    if (Math.abs(len - arm.half * 2) > 0.6 || ((x - node.x) * arm.dx + (z - node.z) * arm.dz) / md < 0.9) continue;
    let ox = (b[1] - a[1]) / len;
    let oz = -(b[0] - a[0]) / len;
    if (ox * arm.dx + oz * arm.dz < 0) {
      ox = -ox;
      oz = -oz;
    }
    return { x, z, ox, oz };
  }
  return null;
}

/** An arm's road's centre line (if it has one) and its outermost solid white line's offset (0: none). */
function edgeLines(arm: Arm): { centre: boolean; white: number } {
  const set = linesOf(arm.section);
  let white = 0;
  for (const line of set) if (!line.yellow && !line.dashed) white = Math.max(white, Math.abs(line.across));
  return { centre: arm.section.centre !== "none", white };
}

/** The part of a convex polygon where `side` is not negative (Sutherland-Hodgman, one plane). */
function clipHalf(poly: [number, number][], side: (v: [number, number]) => number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const sa = side(a);
    const sb = side(b);
    if (sa >= 0) out.push(a);
    if (sa >= 0 !== sb >= 0) {
      const t = sa / (sa - sb);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

function wander(s: number, seed: number): number {
  return 0.022 * Math.sin(s * 0.19 + seed) + 0.012 * Math.sin(s * 0.71 + seed * 2.3);
}

/** A stable pseudo-random 0..1 from two numbers. */
function hash(a: number, b: number): number {
  const x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return x - Math.floor(x);
}
