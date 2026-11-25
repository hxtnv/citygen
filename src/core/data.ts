import type { QuatTuple, Vec3Tuple } from "./math";
import type { TerrainBlock } from "./blocks";
import type { TerrainStamp } from "./kit";
import type { RoadNode } from "./network";
import type { TerrainRoad } from "./roads";
import type { PlantedMedian, RoadSection } from "./road-sections";

/**
 * The world a town is laid on: a height grid (flat by default) plus everything the generator puts
 * on it. Every generation step reads and writes this one record.
 */

/** A ground paint layer (only its colour is used here). */
export interface TerrainLayer {
  name: string;
  color: [number, number, number];
}

/** A loose placed thing (trees in parks and gardens). `model` is a free-form id. */
export interface TerrainScatter {
  model: string;
  at: Vec3Tuple;
  rotation?: QuatTuple;
  scale?: number | Vec3Tuple;
}

export interface TerrainData {
  /** Grid points along X and Z. */
  width: number;
  depth: number;
  /** Metres between grid points. */
  spacing: number;
  /** World position of grid point (0, 0). */
  origin: [number, number];
  /** Row-major heights, `width * depth`. */
  heights: Float32Array;
  /** Per grid point RGBA paint weights (layer 0 grass, 1 paving, 2 road). */
  splat: Uint8Array;
  layers: TerrainLayer[];
  scatter: TerrainScatter[];
  seaLevel?: number;
  roads?: TerrainRoad[];
  nodes?: RoadNode[];
  roadProfiles?: RoadSection[];
  roadMedians?: PlantedMedian[];
  blocks?: TerrainBlock[];
  stamps?: TerrainStamp[];
  linked?: boolean;
}

export function flatTerrain(options: { width: number; depth: number; spacing: number; origin?: [number, number]; height?: number; layers: TerrainLayer[] }): TerrainData {
  const count = options.width * options.depth;
  const splat = new Uint8Array(count * 4);
  for (let i = 0; i < count; i++) splat[i * 4] = 255;
  return {
    width: options.width,
    depth: options.depth,
    spacing: options.spacing,
    origin: options.origin ?? [(-(options.width - 1) * options.spacing) / 2, (-(options.depth - 1) * options.spacing) / 2],
    heights: new Float32Array(count).fill(options.height ?? 0),
    splat,
    layers: options.layers,
    scatter: [],
  };
}

/**
 * Ground height at a world X, Z: bilinear between the four samples round it, clamped to the edge.
 *
 * Matches the drawn and collided surface to within the triangle split (both cut each cell along
 * the same diagonal is not guaranteed), which is centimetres on a gentle slope. Use a raycast
 * where exact matters.
 */
export function heightAt(terrain: TerrainData, x: number, z: number): number {
  const gx = Math.min(Math.max((x - terrain.origin[0]) / terrain.spacing, 0), terrain.width - 1);
  const gz = Math.min(Math.max((z - terrain.origin[1]) / terrain.spacing, 0), terrain.depth - 1);
  const x0 = Math.min(Math.floor(gx), terrain.width - 2);
  const z0 = Math.min(Math.floor(gz), terrain.depth - 2);
  const fx = gx - x0;
  const fz = gz - z0;
  const w = terrain.width;
  const h = terrain.heights;
  const a = h[z0 * w + x0]!;
  const b = h[z0 * w + x0 + 1]!;
  const c = h[(z0 + 1) * w + x0]!;
  const d = h[(z0 + 1) * w + x0 + 1]!;
  return (a * (1 - fx) + b * fx) * (1 - fz) + (c * (1 - fx) + d * fx) * fz;
}

/**
 * Ground height at a world X, Z exactly as the terrain's mesh draws it: each grid cell two flat
 * triangles, split from its (i, j+1) corner to its (i+1, j) one (`mesh.ts`). `heightAt` is bilinear
 * and differs from this by up to a quarter of a cell's twist at its middle: what a fence post, a
 * check or anything that must not sink into (or float over) the drawn ground wants instead.
 */
export function meshHeightAt(terrain: TerrainData, x: number, z: number): number {
  const gx = Math.min(Math.max((x - terrain.origin[0]) / terrain.spacing, 0), terrain.width - 1.0001);
  const gz = Math.min(Math.max((z - terrain.origin[1]) / terrain.spacing, 0), terrain.depth - 1.0001);
  const i = Math.floor(gx);
  const j = Math.floor(gz);
  const fx = gx - i;
  const fz = gz - j;
  const w = terrain.width;
  const h = terrain.heights;
  const a = h[j * w + i]!;
  const b = h[j * w + i + 1]!;
  const c = h[(j + 1) * w + i]!;
  const d = h[(j + 1) * w + i + 1]!;
  if (fx + fz <= 1) return a + (b - a) * fx + (c - a) * fz;
  return d + (c - d) * (1 - fx) + (b - d) * (1 - fz);
}
