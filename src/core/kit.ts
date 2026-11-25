import type { Vec3Tuple } from "./math";
import type { District } from "./blocks";

/**
 * A building the generator can place: only its footprint and height matter to it. What it looks
 * like is up to the renderer (`src/mesh/buildings.ts` draws a box; swap in your own models).
 */
export interface KitBuilding {
  /** Unique id, written into each placed `TerrainStamp.block`. */
  id: string;
  kind: "house" | "shop" | "tower";
  /** Width along the street and depth back from it, metres. */
  size: [number, number];
  /** Height above its ground, metres. */
  height: number;
  /** The districts it is built in (default: by `kind`, see `districtsOf`). */
  districts?: District[];
}

/** The buildings a town is built from. */
export interface TownKit {
  buildings: KitBuilding[];
}

/** One placed building. */
export interface TerrainStamp {
  /** The city block it stands on (`BlockShape.key`). */
  lot?: string;
  /** `KitBuilding.id`. */
  block: string;
  /** Its footprint's centre, on the ground. */
  at: Vec3Tuple;
  /** Quarter turns about Y (unused when `yaw` is set). */
  turn: 0 | 1 | 2 | 3;
  /** Turn about Y, radians: its front (+Z) faces the street. */
  yaw?: number;
  /** The district of its block. */
  district?: District;
}

/** Builds a kit of plain boxes: a few widths and depths per kind, heights from a range. */
export function boxKit(options: { minHeight?: number; maxHeight?: number } = {}): TownKit {
  const lo = options.minHeight ?? 6;
  const hi = Math.max(lo, options.maxHeight ?? 60);
  const buildings: KitBuilding[] = [];
  const add = (kind: KitBuilding["kind"], sizes: [number, number][], h0: number, h1: number): void =>
    sizes.forEach(([w, d], i) => {
      const t = sizes.length > 1 ? i / (sizes.length - 1) : 0;
      buildings.push({ id: `${kind}-${i}`, kind, size: [w, d], height: h0 + (h1 - h0) * ((t * 7) % 1) });
    });
  // Houses: low, small footprints, set back on lots.
  add(
    "house",
    [
      [8, 9],
      [9, 8],
      [10, 10],
      [11, 9],
      [12, 10],
      [9, 11],
      [13, 11],
    ],
    Math.min(lo, 3.5),
    Math.min(Math.max(lo, 6.5), hi),
  );
  // Shops: two to five floors, wide fronts on the street.
  add(
    "shop",
    [
      [10, 12],
      [12, 14],
      [14, 12],
      [16, 16],
      [18, 14],
      [20, 18],
      [24, 16],
      [12, 18],
    ],
    Math.min(lo + 2, hi),
    Math.min(lo + 16, hi),
  );
  // Towers: downtown, tall.
  add(
    "tower",
    [
      [16, 16],
      [18, 20],
      [20, 20],
      [22, 18],
      [24, 24],
      [26, 22],
    ],
    Math.min(lo + 14, hi),
    hi,
  );
  return { buildings };
}
