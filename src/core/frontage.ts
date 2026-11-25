import type { District } from "./blocks";
import { footprint, grow, overlaps, RoadClearance } from "./blocks";
import { heightAt, type TerrainData, type TerrainScatter } from "./data";
import type { KitBuilding, TerrainStamp } from "./kit";
import { sampleAt, trimmedSamples, type NetworkLayout } from "./network";
import { mulberry32 } from "./noise";
import { acrossRoad } from "./roads";

/**
 * Lots along the streets no block closes round (dead ends, cul-de-sacs, loops out to the town's
 * edge): walking each side of each street, a building every so often set back from the sidewalk
 * and facing it, kept clear of every road and of each other, a tree or two in the back yard.
 */
export interface FrontageOptions {
  seed: number;
  /** Whether a lot may stand at a point (inside the town, on no block). */
  accept: (x: number, z: number) => boolean;
  /** The district a lot at a point is (picks its buildings and spacing). */
  district: (x: number, z: number, main: boolean) => District;
  /** Share of each street side that gets lots, 0..1. */
  fill: number;
  /** Plant trees behind the houses. */
  trees: boolean;
  /** Outlines already built on: kept clear of. */
  taken?: [number, number][][];
}

const SPACING: Partial<Record<District, { setback: [number, number]; gap: [number, number] }>> = {
  suburb: { setback: [3.5, 6.5], gap: [3, 7] },
  shops: { setback: [0.4, 1.5], gap: [0.5, 2.5] },
  downtown: { setback: [0.2, 0.8], gap: [0, 1] },
  industrial: { setback: [4, 8], gap: [5, 10] },
};

export function layFrontage(terrain: TerrainData, layout: NetworkLayout, pools: (district: District) => KitBuilding[], options: FrontageOptions): { stamps: TerrainStamp[]; trees: TerrainScatter[] } {
  const rng = mulberry32(options.seed);
  const range = ([a, b]: [number, number]): number => a + (b - a) * rng();
  const roads = new RoadClearance(layout);
  const placed: { quad: [number, number][]; gapped: [number, number][] }[] = (options.taken ?? []).map((q) => ({ quad: q, gapped: q }));
  const stamps: TerrainStamp[] = [];
  const trees: TerrainScatter[] = [];
  const free = (quad: [number, number][], gap: number): boolean => {
    const gapped = grow(quad, gap);
    return !placed.some((p) => overlaps(p.gapped, quad) || overlaps(gapped, p.quad));
  };
  for (const laid of layout.roads) {
    if (laid.road.kind !== "street" || laid.road.class === "lane") continue;
    const samples = trimmedSamples(laid);
    if (samples.length < 2) continue;
    const s0 = samples[0]!.s;
    const s1 = samples[samples.length - 1]!.s;
    const main = laid.road.class === "main";
    for (const side of [1, -1] as const) {
      const edge = laid.half + Math.max(laid.walk, 1);
      let s = s0 + 4 + rng() * 6;
      for (let tries = 0; s < s1 - 4 && tries < 400; tries++) {
        const p = sampleAt(samples, s);
        const [ex, ez] = acrossRoad(p, side * (edge + 4));
        if (!options.accept(ex, ez) || rng() > options.fill) {
          s += 8;
          continue;
        }
        const district = options.district(ex, ez, main);
        const pool = pools(district);
        const spacing = SPACING[district] ?? SPACING.suburb!;
        if (pool.length === 0) {
          s += 8;
          continue;
        }
        const b = pool[Math.floor(rng() * pool.length)]!;
        const [w, d] = b.size;
        const setback = range(spacing.setback);
        // Facing the street: toward it, across.
        const mid = sampleAt(samples, Math.min(s1, s + w / 2));
        const [cx, cz] = acrossRoad(mid, side * (edge + setback + d / 2));
        const fx = mid.dz * side;
        const fz = -mid.dx * side;
        const quad = footprint(cx, cz, fx, fz, w, d);
        const gap = range(spacing.gap);
        if (quad.every(([x, z]) => options.accept(x, z)) && roads.clearOfRoads(quad, 0.5) && free(quad, gap)) {
          placed.push({ quad, gapped: grow(quad, gap) });
          stamps.push({ block: b.id, at: [cx, heightAt(terrain, cx, cz), cz], turn: 0, yaw: Math.atan2(fx, fz), district });
          if (options.trees && district === "suburb")
            for (let k = 0; k < 2; k++) {
              if (rng() < 0.35) continue;
              const back = d / 2 + 2.5 + rng() * 5;
              const across = (rng() - 0.5) * w;
              const tx = cx - fx * back + fz * across;
              const tz = cz - fz * back - fx * across;
              const spot = footprint(tx, tz, 0, 1, 2.5, 2.5);
              if (!options.accept(tx, tz) || !roads.clearOfRoads(spot, 0.5) || !free(spot, 0.5)) continue;
              placed.push({ quad: spot, gapped: spot });
              trees.push({ model: "tree", at: [tx, heightAt(terrain, tx, tz), tz], scale: 0.8 + rng() * 0.5 });
            }
          s += w + gap;
        } else s += 2.5;
      }
    }
  }
  return { stamps, trees };
}
