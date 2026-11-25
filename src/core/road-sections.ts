import type { RoadKind, StreetClass, TerrainRoad } from "./roads";
import { ROAD_MEDIAN_LIST, ROAD_SECTION_LIST } from "./road-sections.data";

/**
 * Road profiles ("sections"): a road's cross-section as data. Lanes (how many each way, how wide),
 * the paint (centre line, lines between lanes, edge lines), a paved hard shoulder, the verge (the
 * road raised over the grass on a bank, a gravel fringe on top), sidewalks, how it grades, its
 * junction corners and turn lanes.
 *
 * Authored in `content/library/road-profiles.json`, written to `road-sections.gen.ts` by
 * `bun tools/road-profiles.ts`. Every road names one (`TerrainRoad.section`) and may override a few
 * fields of it (`TerrainRoad.overrides`); a road with none (every road laid before profiles) reads
 * through a `legacy-*` profile picked by its old kind and class, which reproduces exactly how
 * those kinds were drawn, laned and graded. Everything that used to read a width or a style off a
 * road's kind reads {@link sectionOf}. Three-free and pure.
 */

/**
 * The yellow line between the two directions: `auto` is dashed where overtaking is fine and double
 * solid on bends and near junctions; `solid-dashed` is solid on the left of the centre (overtaking
 * allowed only for traffic on the dashed side), `dashed-solid` the other way round.
 */
export type CentreLine = "auto" | "dashed" | "solid" | "double" | "solid-dashed" | "dashed-solid" | "none";

/**
 * What lies between the two directions: nothing (`none`, the centre line only), a `painted` median
 * (a yellow line along each side, hatching between), a `raised` kerbed island paved in concrete, a
 * `grass` island (kerbed, turf on top), a concrete `barrier` (Street Racer's jersey barrier down
 * its middle, a yellow line each side), or a `planted` one: a walk kind's kerb pieces back to back
 * (facing out), paved between, with what is planted and stood on it laid along it at a spacing (a
 * {@link PlantedMedian}: Palm City's planter beds, hedges, palms and lamps down a boulevard). Every kind but `none` opens at a junction: it ends short of
 * it with a rounded nose (an island) or the barrier's end, so traffic can turn across there and
 * nowhere else (`lanes.ts`).
 */
export type MedianKind = "none" | "painted" | "raised" | "grass" | "barrier" | "planted";

/**
 * One thing laid down a planted median, again and again: a model every `every` metres from `phase`
 * past the start of the median's body (past its nose), `offset` across its middle (+ to the left of
 * travel). The model's +X runs along the road (turned `yaw` degrees about up), its foot `y` over
 * the median's top, scaled `scale` (each one a random `vary` more or less, kept by where it
 * stands). `count` and `step`: a group at each place. `tile`: laid end to end instead, each `every` long from its origin and stretched a
 * little so a whole number fill the body (a planter bed). Kept `clear` metres off the noses.
 */
export interface MedianItem {
  model: string;
  every: number;
  phase: number;
  offset: number;
  tile?: boolean;
  /** A group of `count` laid `step` metres apart at each place (a run of hedges between two lamps). */
  count?: number;
  step?: number;
  yaw?: number;
  y?: number;
  scale?: [number, number, number];
  vary?: number;
  clear?: number;
}

/**
 * A planted median: its edges, a walk kind's pieces (`edge`, a walk kind's id) laid back to back
 * facing out, and what is laid down its middle (`items`). Authored in `road-profiles.json`
 * (`medians`); a map may add or change them (`TerrainData.roadMedians`).
 */
export interface PlantedMedian {
  id: string;
  label: string;
  edge: string;
  items: MedianItem[];
}

/**
 * A roadside barrier's kind: today's procedural `guard-rail` (wooden posts, a W-beam, ends turned
 * down into the ground), Street Racer's galvanised `steel-rail` pieces, or its `concrete` jersey
 * barrier pieces. Pieces are tiled along the road, each stretched a little to fit (`barrierPieces`).
 */
export type BarrierKind = "guard-rail" | "steel-rail" | "concrete";

/** Where a side's barriers go: where needed (a drop, a tight bend, a bridge's ends), all along, or never. */
export type BarrierMode = "auto" | "always" | "none";

/** The white line between two lanes of one direction. */
export type LaneLineKind = "dashed" | "solid" | "none";

export interface RoadSection {
  id: string;
  label: string;
  /** Its group in the picker. `legacy` ones stand in for the old fixed kinds. */
  use: "country" | "city" | "industrial" | "track" | "legacy";
  /** The old kind it reads as (written onto the road too, for older readers): dirt or not, town or country. */
  kind: RoadKind;
  /** The old street class it reads as (signals at main streets, an alley's lack of paint). */
  class?: StreetClass;
  /** Lanes each way: how many (1 to 3), how wide, metres, and how fast traffic goes, m/s. */
  lanes: { count: number; width: number; speed: number };
  centre: CentreLine;
  /** The centre line's paint width, metres. */
  centreWidth: number;
  /** Where `auto` forbids overtaking: a country road's rules (long sight lines) or a town street's. */
  passing: "country" | "street";
  laneLines: LaneLineKind;
  /** A white line along each edge of the driven lanes. */
  edgeLine: boolean;
  /** With no hard shoulder: how far in from the asphalt's edge the edge line is. */
  edgeInset: number;
  /** A paved hard shoulder each side, outside the lanes (part of the asphalt), metres. */
  shoulder: number;
  /** Sidewalks each side, metres (0: none, a verge instead). */
  walk: number;
  /**
   * Between the two directions: its kind and its width, lane edge to lane edge, metres (0 with
   * `none`); a planted one's planting (a {@link PlantedMedian}'s id).
   */
  median: { kind: MedianKind; width: number; plant?: string };
  /**
   * What its sidewalks are built of: always `plain` here (procedural paving and a kerb).
   */
  walkKind: string;
  /** Its roadside barriers (roads with a verge): where on each side, and of what kind. */
  barriers: { left: BarrierMode; right: BarrierMode; kind: BarrierKind };
  /**
   * Beside the asphalt (with no sidewalk): `fringe`, a strip of gravel; `lift`, how far the road
   * stands over the grass beside it (0: flush, the old look); `bank`, the run of the bank down to
   * the grass per metre of lift (1: 45 degrees).
   */
  verge: { lift: number; bank: number; fringe: number };
  /** Lanes split, or arrows painted, for the turns at each junction it comes into. */
  turnLanes: boolean;
  /** Its height profile: steepest climb, metres of ground averaged over, and graded ground either side. */
  grade: { maxGrade: number; smoothing: number; bed: number };
  /** Radius of its kerb corners at a junction (a junction may set its own: `RoadNode.corner`). */
  corner: number;
  /**
   * Zebras across it where it comes into a junction of three roads or more with a walked corner
   * beside it, in line with the cross street's sidewalk (`JunctionCrossing`); a road's end may say
   * otherwise (`TerrainRoad.crossStart` / `crossEnd`).
   */
  crossings: boolean;
  /** Metres between street lamps on its sidewalks (staggered); 0 for none. */
  lamps: number;
  /** The street lamp on its sidewalks (its arm along its +Z, turned to the road). */
  lampModel?: string;
  /** A power line along it (a country road's, by the old rules: `auto`), or none. */
  poles: "auto" | "none";
  /** How busy a road it is (who has priority at a junction). */
  rank: number;
  surface: "asphalt" | "dirt";
}

/**
 * A road's own changes to its profile, field by field (each optional: unset is the profile's).
 * `turnStart` / `turnEnd`: turn lanes and arrows on the approach to the junction at its start / end.
 */
export interface RoadOverrides {
  lanes?: number;
  laneWidth?: number;
  centre?: CentreLine;
  laneLines?: LaneLineKind;
  edgeLine?: boolean;
  shoulder?: number;
  fringe?: number;
  lift?: number;
  turnLanes?: boolean;
  turnStart?: boolean;
  turnEnd?: boolean;
  /** The median's kind and width (see {@link MedianKind}), and a planted one's planting (a {@link PlantedMedian}'s id). */
  median?: MedianKind;
  medianWidth?: number;
  medianPlant?: string;
  /** The kind of the barriers on each side of travel (left, right), where it has them. */
  barrierLeft?: BarrierKind;
  barrierRight?: BarrierKind;
  /** What its sidewalks are built of: `plain` or a walk kind's id (see {@link RoadSection.walkKind}). */
  walkKind?: string;
  /**
   * One side's sidewalk, by side of travel (left, right): its depth (0: none on that side, a road
   * without sidewalks given one on a side), and what it is built of. Unset: as both sides have it.
   */
  walkLeft?: number;
  walkRight?: number;
  walkKindLeft?: string;
  walkKindRight?: string;
  /**
   * Parking bays along a side (a walked one): the kerb steps back {@link BAY_WIDTH} into the
   * sidewalk to make a strip of asphalt, bays painted on it (Palm City's `Road_Small_02` beside
   * `Road_Small_03`).
   */
  parkingLeft?: boolean;
  parkingRight?: boolean;
  /** Metres between its street lamps (0: none), in place of its profile's. */
  lamps?: number;
}

/**
 * A segment's own changes (`TerrainRoad.segment`): a stretch of a road, laid as a road of its own
 * between two joints (`RoadNode.joint`), with these over the road's own overrides. Besides any
 * override, its guard rails per side (as `TerrainRoad.railsLeft` / `railsRight`).
 */
export interface SegmentOverrides extends RoadOverrides {
  railsLeft?: "on" | "off";
  railsRight?: "on" | "off";
}

/** A parking strip's width (the kerb's step back into the sidewalk), its kerb's step's length, a bay's length. */
export const BAY_WIDTH = 2.5;
export const BAY_RAMP = 2.5;
export const BAY_LENGTH = 6;
/** The least sidewalk left behind a parking strip. */
export const BAY_WALK = 1.5;

/** The shipped profiles and planted medians (`road-profiles.json`), by id. */
export const SHIPPED_SECTIONS: Map<string, RoadSection> = new Map(ROAD_SECTION_LIST.map((s) => [s.id, s]));
export const SHIPPED_MEDIANS: Map<string, PlantedMedian> = new Map(ROAD_MEDIAN_LIST.map((m) => [m.id, m]));

/**
 * Every profile now: the shipped ones, with the map's own over them (`TerrainData.roadProfiles`:
 * new ones, and shipped ones it changed, under the same id). See {@link useMapSections}.
 */
export const ROAD_SECTIONS: Map<string, RoadSection> = new Map(SHIPPED_SECTIONS);
/** Every planted median now, likewise (`TerrainData.roadMedians` over the shipped). */
export const PLANTED_MEDIANS: Map<string, PlantedMedian> = new Map(SHIPPED_MEDIANS);

let usedProfiles: unknown = undefined;
let usedMedians: unknown = undefined;

/**
 * Puts a map's own profiles and planted medians over the shipped ones (or, with none, back to the
 * shipped alone): what every reader of a profile (`sectionOf`, `sectionById`) sees from then on.
 * Done when a terrain is read (`decodeTerrain`) and laid out (`layoutNetwork`), and by the
 * editor after an edit to them; cheap when they are the same arrays as last time (so an edit
 * puts new arrays in, never changes them in place).
 */
export function useMapSections(terrain: { roadProfiles?: readonly RoadSection[]; roadMedians?: readonly PlantedMedian[] }): void {
  if (terrain.roadProfiles === usedProfiles && terrain.roadMedians === usedMedians) return;
  usedProfiles = terrain.roadProfiles;
  usedMedians = terrain.roadMedians;
  ROAD_SECTIONS.clear();
  for (const [id, s] of SHIPPED_SECTIONS) ROAD_SECTIONS.set(id, s);
  for (const s of terrain.roadProfiles ?? []) ROAD_SECTIONS.set(s.id, s);
  PLANTED_MEDIANS.clear();
  for (const [id, m] of SHIPPED_MEDIANS) PLANTED_MEDIANS.set(id, m);
  for (const m of terrain.roadMedians ?? []) PLANTED_MEDIANS.set(m.id, m);
}

/** A planted median by id, or null. */
export function plantedMedian(id: string | undefined): PlantedMedian | null {
  return (id ? PLANTED_MEDIANS.get(id) : undefined) ?? null;
}

/** The profile a road laid before profiles reads through: by its old kind and street class. */
export function legacySectionId(road: Pick<TerrainRoad, "kind" | "class">): string {
  if (road.kind === "street") return road.class ? `legacy-${road.class}` : "legacy-street";
  return `legacy-${road.kind}`;
}

/** The profile with this id, or the legacy one for a kind when there is none such. */
export function sectionById(id: string | undefined, fallback: Pick<TerrainRoad, "kind" | "class"> = { kind: "road" }): RoadSection {
  return (id ? ROAD_SECTIONS.get(id) : undefined) ?? ROAD_SECTIONS.get(legacySectionId(fallback))!;
}

/** A road's cross-section as resolved: its profile with its overrides, and what follows from them. */
export interface ResolvedSection extends RoadSection {
  /** Centre to the inner edge of its lanes: half its median's width (0 with none), metres. */
  inner: number;
  /** Centre to the outer edge of its lanes (median and lanes), metres. */
  band: number;
  /** Centre to the asphalt's edge (lanes and hard shoulder), metres. */
  half: number;
}

/** The fields an override may set, clamped to what makes a road. */
function applied(base: RoadSection, o: RoadOverrides | undefined): RoadSection {
  if (!o) return base;
  const out: RoadSection = { ...base, lanes: { ...base.lanes }, verge: { ...base.verge }, median: { ...base.median }, barriers: { ...base.barriers } };
  if (o.medianPlant !== undefined) out.median.plant = o.medianPlant;
  if (o.lanes !== undefined) out.lanes.count = Math.min(3, Math.max(1, Math.round(o.lanes)));
  if (o.laneWidth !== undefined) out.lanes.width = Math.min(8, Math.max(2, o.laneWidth));
  if (o.centre !== undefined) out.centre = o.centre;
  if (o.laneLines !== undefined) out.laneLines = o.laneLines;
  if (o.edgeLine !== undefined) out.edgeLine = o.edgeLine;
  if (o.shoulder !== undefined) out.shoulder = Math.min(5, Math.max(0, o.shoulder));
  if (o.fringe !== undefined) out.verge.fringe = Math.min(4, Math.max(0, o.fringe));
  if (o.lift !== undefined) out.verge.lift = Math.min(1.5, Math.max(0, o.lift));
  if (o.turnLanes !== undefined) out.turnLanes = o.turnLanes;
  if (o.walkKind !== undefined) out.walkKind = o.walkKind;
  if (o.lamps !== undefined) out.lamps = Math.max(0, o.lamps);
  if (o.median !== undefined) {
    // A median switched on where the profile has none takes the kind's usual width.
    if (out.median.kind === "none" || out.median.width <= 0) out.median.width = MEDIAN_WIDTH[o.median];
    out.median.kind = o.median;
  }
  if (o.medianWidth !== undefined) out.median.width = Math.min(MEDIAN_RANGE[1], Math.max(MEDIAN_RANGE[0], o.medianWidth));
  if (out.median.kind === "planted" && !plantedMedian(out.median.plant)) out.median.plant = PLANTED_MEDIANS.keys().next().value;
  if (out.median.kind === "none") out.median.width = 0;
  else out.median.width = Math.max(out.median.width, MEDIAN_LEAST[out.median.kind]);
  return out;
}

/**
 * A road's cross-section: its profile (`section`, or the legacy one for its kind) with its
 * overrides applied. An old tiled town's roads have no fringe.
 */
export function sectionOf(road: Pick<TerrainRoad, "kind" | "class" | "section" | "overrides" | "town"> & { segment?: SegmentOverrides }): ResolvedSection {
  const base = road.section ? sectionById(road.section, road) : ROAD_SECTIONS.get(legacySectionId(road))!;
  const s = applied(applied(base, road.overrides), road.segment);
  const inner = s.median.kind === "none" ? 0 : s.median.width / 2;
  const band = inner + s.lanes.count * s.lanes.width;
  const resolved: ResolvedSection = { ...s, inner, band, half: band + s.shoulder };
  if (road.town !== undefined && resolved.verge.fringe > 0) resolved.verge = { ...resolved.verge, fringe: 0 };
  return resolved;
}

/** A median's usual width when switched on, the least each kind takes, and the range a road may set. */
export const MEDIAN_WIDTH: Record<MedianKind, number> = { none: 0, painted: 2, raised: 3, grass: 5, barrier: 2.8, planted: 5 };
export const MEDIAN_LEAST: Record<MedianKind, number> = { none: 0, painted: 0.6, raised: 1.6, grass: 2, barrier: 1.4, planted: 2 };
export const MEDIAN_RANGE: [number, number] = [0.6, 20];

/** The kind of a road's barriers on one side of travel (1 the left): its segment's, its own, else its profile's. */
export function barrierKindOf(road: Pick<TerrainRoad, "kind" | "class" | "section" | "overrides" | "town" | "segment">, side: 1 | -1, section = sectionOf(road)): BarrierKind {
  const key = side === 1 ? "barrierLeft" : "barrierRight";
  return road.segment?.[key] ?? road.overrides?.[key] ?? section.barriers.kind;
}

/** One of a road's own settings as it reads on it: its segment's, else its own overrides'. */
export function ownOverride<K extends keyof RoadOverrides>(road: Pick<TerrainRoad, "overrides" | "segment">, key: K): RoadOverrides[K] {
  return road.segment?.[key] !== undefined ? road.segment[key] : road.overrides?.[key];
}

/**
 * A road's sidewalks side by side (left of travel, then right): each one's depth (0: none), what
 * it is built of (a walk kind's id or `plain`), and whether it has parking bays. `base` is the
 * depth both have unless a side says otherwise (`walkWidth`'s old answer: the profile's, the road's
 * `sidewalk` switch). A side with bays keeps at least {@link BAY_WALK} behind them.
 */
export function walkSides(
  road: Pick<TerrainRoad, "kind" | "class" | "section" | "overrides" | "town" | "segment">,
  base: number,
  section = sectionOf(road),
): { walk: [number, number]; kind: [string, string]; parking: [boolean, boolean] } {
  const side = (left: boolean): { walk: number; kind: string; parking: boolean } => {
    const own = ownOverride(road, left ? "walkLeft" : "walkRight");
    let walk = Math.max(0, Math.min(20, own ?? base));
    const kind = ownOverride(road, left ? "walkKindLeft" : "walkKindRight") ?? section.walkKind;
    const parking = walk > 0 && !!ownOverride(road, left ? "parkingLeft" : "parkingRight");
    if (parking) walk = Math.max(walk, BAY_WIDTH + BAY_WALK);
    return { walk, kind, parking };
  };
  const l = side(true);
  const r = side(false);
  return { walk: [l.walk, r.walk], kind: [l.kind, r.kind], parking: [l.parking, r.parking] };
}

/** Whether a median keeps traffic from crossing it between junctions (an island or a barrier; paint does not). */
export function medianBlocks(kind: MedianKind): boolean {
  return kind === "raised" || kind === "grass" || kind === "barrier" || kind === "planted";
}

/** Whether turn lanes (or arrows) are on for a road's approach to the junction at its start (0) or end (1). */
export function turnLanesAt(road: Pick<TerrainRoad, "kind" | "class" | "section" | "overrides" | "town">, end: 0 | 1, section = sectionOf(road)): boolean {
  const own = end === 0 ? road.overrides?.turnStart : road.overrides?.turnEnd;
  return own ?? section.turnLanes;
}

/**
 * A road's verge as drawn and graded: lifted only when it has a fringe to stand the bank on and no
 * sidewalk, and only by more than the few centimetres the ground already sits under a road.
 */
export function liftOf(section: Pick<RoadSection, "verge" | "walk">, walk: number, fringe: number): number {
  if (walk > 0 || fringe <= 0) return 0;
  return section.verge.lift >= 0.1 ? section.verge.lift : 0;
}
