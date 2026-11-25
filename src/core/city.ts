import { flatTerrain, type TerrainData, type TerrainScatter } from "./data";
import { districtsOf, fillBlock, findBlocks, insidePolygon, lotEntranceFor, type BlockShape, type District } from "./blocks";
import { layFrontage } from "./frontage";
import { boxKit, type KitBuilding, type TerrainStamp, type TownKit } from "./kit";
import { layoutNetwork, linkRoads, type NetworkLayout } from "./network";
import { mulberry32 } from "./noise";
import { layTownStreets, planTownStreets, TOWN_CHARACTER_KNOBS, type TownCharacter, type TownStreetPlan } from "./town-plan";

/** Everything that shapes a city. Every field but `seed` has a default. */
export interface CitySettings {
  /** Seeds the street plan and everything built on it. */
  seed: number;
  /** How the town grows (see `TownCharacter`): its street pattern and default knobs. */
  character: TownCharacter;
  /** The area the streets are laid in, metres along the main street (`width`) and across it (`depth`). */
  width: number;
  depth: number;
  /** About how far apart side streets are along the main street, metres. */
  block: number;
  /** 0..1: how much downtown streets wander off square and back streets bend. */
  irregular: number;
  /** 0..1: how much residential streets bend and wander (default: the character's). */
  curvy?: number;
  /** 0..1: how many residential streets end in a cul-de-sac (default: the character's). */
  culdesacs?: number;
  /** 0..1: how much of the area round downtown gets streets (default: the character's). */
  density?: number;
  /** 0..1: how big the downtown grid is (default: the character's). */
  core?: number;
  /** A second main street across the first (default: for a city). */
  crossStreet?: boolean;
  /** The main street's direction, radians. */
  angle: number;
  /** Roads out of town, radians (`atan2(dz, dx)`): the main street runs out along them. */
  exits?: number[];
  /** Share of each street side outside the blocks that gets lots, 0..1. */
  lots: number;
  /** Chance a small shops or industrial block is a parking lot instead, 0..1. */
  parking: number;
  /** Share of residential blocks turned into parks, 0..1. */
  parks: number;
  /** How far out from the middle (0..1 of the town's half size) downtown towers reach. */
  downtown: number;
  /** Lowest and tallest building heights, metres. */
  minHeight: number;
  maxHeight: number;
  /** Zebra crossings at junctions. */
  crossings: boolean;
  /** Trees in parks and gardens. */
  trees: boolean;
  /** The buildings to place (default: a kit of boxes from `minHeight` / `maxHeight`). */
  kit?: TownKit;
}

export const DEFAULT_CITY: CitySettings = {
  seed: 1,
  character: "city",
  width: 520,
  depth: 420,
  block: 62,
  irregular: 0.5,
  angle: 0,
  lots: 0.9,
  parks: 0.1,
  parking: 0.15,
  downtown: 0.42,
  minHeight: 6,
  maxHeight: 70,
  crossings: true,
  trees: true,
};

/** One placed building. Its footprint is centred on (x, z); its front (+Z when `yaw` is 0) faces the street. */
export interface CityBuilding {
  /** The kit building it is (`KitBuilding.id`). */
  id: string;
  kind: KitBuilding["kind"];
  district: District;
  /** The block it stands on (`BlockShape.key`). */
  block: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  width: number;
  depth: number;
  height: number;
}

export interface CityBlock {
  shape: BlockShape;
  district: District;
  /** A parking lot: asphalt, painted bays, planted islands (drawn by the road meshes). */
  parking?: boolean;
}

/** A generated city: the ground and road network, the blocks, what stands on them. */
export interface CityData {
  settings: CitySettings;
  /** The ground grid with the roads and junction nodes on it: what `buildRoadMeshes` draws. */
  terrain: TerrainData;
  /** The street plan as planned (nodes and streets), before it was laid. */
  plan: TownStreetPlan;
  /** The network laid out: every road's samples, widths and sidewalks, every junction's outline. */
  layout: NetworkLayout;
  blocks: CityBlock[];
  buildings: CityBuilding[];
  /** Trees: position on the ground and a scale. */
  trees: { x: number; y: number; z: number; scale: number }[];
  /** The area's bounds, for framing a camera. */
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
}

/** Generates a city. Deterministic for its settings. */
export function generateCity(options: Partial<CitySettings> = {}): CityData {
  const settings: CitySettings = { ...DEFAULT_CITY, ...options };
  const { width, depth, angle } = settings;
  // The ground: flat, with room round the town.
  const reach = Math.hypot(width, depth) / 2 + 60;
  const spacing = 4;
  const cells = Math.ceil((reach * 2) / spacing) + 1;
  const terrain = flatTerrain({
    width: cells,
    depth: cells,
    spacing,
    layers: [
      { name: "grass", color: [0.36, 0.46, 0.25] },
      { name: "paving", color: [0.55, 0.55, 0.53] },
    ],
  });

  // Streets.
  const knobs = TOWN_CHARACTER_KNOBS[settings.character];
  const plan = planTownStreets(
    { x: 0, z: 0 },
    {
      width,
      depth,
      angle,
      block: settings.block,
      irregular: settings.irregular,
      seed: settings.seed,
      character: settings.character,
      crossStreet: settings.crossStreet ?? settings.character === "city",
      curvy: settings.curvy ?? knobs.curvy,
      culdesacs: settings.culdesacs ?? knobs.culdesacs,
      density: settings.density ?? knobs.density,
      core: settings.core ?? knobs.core,
      ...(settings.exits ? { exits: settings.exits } : {}),
    },
  );
  const laid = layTownStreets(terrain, plan);
  // Zebra crossings at junctions of three or more streets, on the main and local streets.
  if (settings.crossings) for (const road of laid.roads) if (road.class !== "lane") road.crossStart = road.crossEnd = true;
  linkRoads(terrain);
  const layout = layoutNetwork(terrain);

  // Blocks and their districts.
  const kit = settings.kit ?? boxKit({ minHeight: settings.minHeight, maxHeight: settings.maxHeight });
  const byId = new Map(kit.buildings.map((b) => [b.id, b]));
  const rng = mulberry32(settings.seed * 101 + 7);
  const blocks: CityBlock[] = [];
  const buildings: CityBuilding[] = [];
  const trees: CityData["trees"] = [];
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  const radius = (x: number, z: number): number => Math.hypot((x * ca + z * sa) / (width / 2), (-x * sa + z * ca) / (depth / 2));
  const add = (stamps: readonly TerrainStamp[], district: (stamp: TerrainStamp) => District, block: string): void => {
    for (const stamp of stamps) {
      const b = byId.get(stamp.block);
      if (!b) continue;
      const d = district(stamp);
      buildings.push({
        id: b.id,
        kind: b.kind,
        district: d,
        block,
        x: stamp.at[0],
        y: stamp.at[1],
        z: stamp.at[2],
        yaw: stamp.yaw ?? (stamp.turn * Math.PI) / 2,
        width: b.size[0],
        depth: b.size[1],
        height: buildingHeight(settings, b, d, radius(stamp.at[0], stamp.at[2]), rng()),
      });
    }
  };
  const plant = (scatter: readonly TerrainScatter[]): void => {
    for (const tree of scatter) {
      const s = tree.scale;
      trees.push({ x: tree.at[0], y: tree.at[1], z: tree.at[2], scale: typeof s === "number" ? s : 1 });
    }
  };
  let seed = settings.seed * 101;
  terrain.blocks = [];
  for (const shape of findBlocks(terrain, layout)) {
    let district = blockDistrict(settings, shape, onMainStreet(shape, layout), radius(shape.centre[0], shape.centre[1]), rng());
    // Now and then a small block off downtown is a parking lot.
    const parking = (district === "shops" || district === "industrial") && shape.area < 6000 && rng() < settings.parking;
    if (parking) district = "empty";
    blocks.push({ shape, district, ...(parking ? { parking: true } : {}) });
    terrain.blocks.push({
      key: shape.key,
      district,
      seed,
      ...(district === "park" ? { ground: "park" as const } : {}),
      ...(parking ? { ground: "lot" as const, entrance: lotEntranceFor(shape) } : {}),
    });
    const fill = fillBlock(terrain, kit, shape, district, seed++, { trees: settings.trees ? ["tree"] : [], layout });
    add(fill.stamps, () => district, shape.key);
    plant(fill.trees);
  }

  // Lots along the streets no block closes round: houses, shops on the main street near the middle.
  const pools = new Map<District, KitBuilding[]>();
  const pool = (district: District): KitBuilding[] => {
    let list = pools.get(district);
    if (!list) pools.set(district, (list = kit.buildings.filter((b) => districtsOf(b).includes(district))));
    return list;
  };
  const frontage = layFrontage(terrain, layout, pool, {
    seed: settings.seed * 17 + 3,
    accept: (x, z) => radius(x, z) < 1.02 && !blocks.some((b) => insidePolygon(b.shape.outline, x, z)),
    district: (x, z, main) => {
      const r = radius(x, z);
      if (main && r < Math.max(0.35, settings.downtown * 1.3)) return "shops";
      if (r > 0.85 && hash(x, z) > 0.9) return "industrial";
      return "suburb";
    },
    fill: settings.lots,
    trees: settings.trees,
  });
  add(frontage.stamps, (stamp) => stamp.district ?? "suburb", "");
  plant(frontage.trees);
  return { settings, terrain, plan, layout, blocks, buildings, trees, bounds: { minX: -reach, maxX: reach, minZ: -reach, maxZ: reach } };
}

/**
 * A block's district: on the main street, shops (downtown towers in a city's middle); off it,
 * houses, now and then a park, and out at the edge the odd yard of industry. `r` is the block's
 * distance from the middle as a share of the town's half size, `roll` 0..1 at random.
 */
function blockDistrict(settings: CitySettings, block: BlockShape, onMain: boolean, r: number, roll: number): District {
  const city = settings.character === "city";
  const core = settings.downtown;
  let district: District;
  if (onMain) district = city && r < core ? "downtown" : r < 0.8 && block.area < 4800 ? "shops" : "suburb";
  else district = city && r < core * 0.7 ? "downtown" : city && r < core * 1.1 ? "shops" : "suburb";
  if (district === "suburb" && roll < settings.parks) district = "park";
  else if (district === "suburb" && r > 0.8 && roll > 0.88) district = "industrial";
  return district;
}

/** Whether a block lies along a main street: its outline within reach of one's sidewalk. */
function onMainStreet(block: BlockShape, layout: NetworkLayout): boolean {
  for (const laid of layout.roads) {
    if (laid.road.kind !== "street" || laid.road.class !== "main") continue;
    const reach = laid.half + laid.walk + 3;
    for (const p of laid.samples) for (const [x, z] of block.outline) if (Math.abs(p.x - x) < reach && Math.abs(p.z - z) < reach && Math.hypot(p.x - x, p.z - z) < reach) return true;
  }
  return false;
}

/** A building's height: its kit height, towers rising toward the middle into a skyline. */
function buildingHeight(settings: CitySettings, b: KitBuilding, district: District, r: number, roll: number): number {
  const lo = settings.minHeight;
  const hi = Math.max(lo, settings.maxHeight);
  if (district === "downtown") {
    const near = Math.max(0, 1 - r / Math.max(0.05, settings.downtown));
    return Math.max(lo, lo + (hi - lo) * (0.25 + 0.75 * near ** 1.3) * (0.55 + 0.45 * roll));
  }
  if (b.kind === "house") return Math.min(b.height, hi) * (0.85 + 0.3 * roll);
  return Math.min(hi, b.height * (0.8 + 0.4 * roll));
}

function hash(a: number, b: number): number {
  const v = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
  return v - Math.floor(v);
}
