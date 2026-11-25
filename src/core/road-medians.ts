import { type RoadSample } from "./roads";
import type { MedianKind, ResolvedSection } from "./road-sections";

/**
 * Medians and barriers as pieces of a road (`road-sections.ts` says which a road has): where a
 * road's median runs and stops, the outline of a kerbed island (a nose at each end), the concrete
 * barrier down a median's middle, and pack barrier pieces tiled along a run - each piece stretched
 * a little so a whole number of them fit it exactly, turned and pitched to follow the road.
 *
 * Three-free and pure. `roads-geometry.ts` draws the islands and the paint, `network.ts` places
 * the pieces (as street furniture, so they are instanced and collide like props) and adds their
 * colliders to the terrain's.
 */

/** Metres a median stops short of a junction's edge (or a dead end's): the opening traffic turns across. */
export const MEDIAN_OPEN = 1.5;
/** How far in from the lanes' edge an island's kerb stands: the yellow line runs between. */
export const MEDIAN_INSET = 0.45;
/** An island's kerb height over the road. */
export const ISLAND_HEIGHT = 0.15;
/** How far in from the lanes' edge a median's yellow line runs (its middle). */
export const MEDIAN_LINE_IN = 0.15;

/** Where a road's median runs: its kind, along the road from `s0` to `s1`, and an island's half width. */
export interface MedianRun {
  kind: Exclude<MedianKind, "none">;
  s0: number;
  s1: number;
  /** A closed loop's runs on round through its seam: no ends, no noses. */
  closed: boolean;
  /** Its start and end run on into the next segment's median through a seamless joint: no nose there. */
  open?: [boolean, boolean];
  /** An island's half width (raised and grass ones); the barrier's or the paint's otherwise. */
  half: number;
  /** A planted one's planting (a `PlantedMedian`'s id). */
  plant?: string;
}

/** Metres a median's nose keeps back from a zebra across the road (a refuge's edge, not in the stripes). */
export const NOSE_BACK = 0.6;

/**
 * A road's median along its trimmed samples (`trimmedSamples`): from just past the junction (or the
 * end) at its start to just short of the one at its end, or all round a closed loop. Null with no
 * median, or too short a road for one.
 */
export function medianRun(section: Pick<ResolvedSection, "median" | "inner">, samples: readonly RoadSample[], closed = false, open?: readonly [boolean, boolean]): MedianRun | null {
  const { kind } = section.median;
  if (kind === "none" || section.inner <= 0 || samples.length < 2) return null;
  const a = samples[0]!.s;
  const b = samples[samples.length - 1]!.s;
  const half = kind === "raised" || kind === "grass" ? Math.max(0.3, section.inner - MEDIAN_INSET) : section.inner;
  const plant = kind === "planted" && section.median.plant ? { plant: section.median.plant } : {};
  if (closed) return { kind, s0: a, s1: b, closed: true, half, ...plant };
  const ends = open && (open[0] || open[1]) ? { open: [open[0], open[1]] as [boolean, boolean] } : {};
  const s0 = open?.[0] ? a : a + MEDIAN_OPEN;
  const s1 = open?.[1] ? b : b - MEDIAN_OPEN;
  // Room for both noses and a little between.
  if (s1 - s0 < Math.max(open?.[0] && open?.[1] ? 0.5 : 4, half * (2 - (open?.[0] ? 1 : 0) - (open?.[1] ? 1 : 0)) + 1)) return null;
  return { kind, s0, s1, closed: false, half, ...plant, ...ends };
}

/** Whether a median run has a nose at its start (0) or end (1): not round a loop, nor where it runs on through a joint. */
export function hasNose(run: MedianRun, end: 0 | 1): boolean {
  return !run.closed && !run.open?.[end];
}

/**
 * A road's median as it runs, cut where people cross (`cuts`: stretches along the road, a zebra's
 * at a junction or between two): each piece of it ends {@link NOSE_BACK} short of the stripes in a
 * nose, so the crossing runs through an opening. A piece too short for its noses is left out. A
 * closed loop's median runs on whole.
 */
export function medianRuns(
  section: Pick<ResolvedSection, "median" | "inner">,
  samples: readonly RoadSample[],
  closed = false,
  cuts: readonly (readonly [number, number])[] = [],
  open?: readonly [boolean, boolean],
): MedianRun[] {
  const run = medianRun(section, samples, closed, open);
  if (!run) return [];
  if (run.closed || cuts.length === 0) return [run];
  let spans: [number, number, boolean, boolean][] = [[run.s0, run.s1, !!run.open?.[0], !!run.open?.[1]]];
  for (const [c0, c1] of cuts) {
    const a = c0 - NOSE_BACK;
    const b = c1 + NOSE_BACK;
    spans = spans.flatMap(([x, y, ox, oy]): [number, number, boolean, boolean][] =>
      b <= x || a >= y
        ? [[x, y, ox, oy]]
        : (
            [
              [x, a, ox, false],
              [b, y, false, oy],
            ] as [number, number, boolean, boolean][]
          ).filter(([p, q]) => q > p),
    );
  }
  return spans
    .filter(([x, y, ox, oy]) => y - x >= Math.max(ox && oy ? 0.5 : 4, run.half * (2 - (ox ? 1 : 0) - (oy ? 1 : 0)) + 1))
    .map(([s0, s1, ox, oy]) => {
      const { open: _open, ...rest } = run;
      return { ...rest, s0, s1, ...(ox || oy ? { open: [ox, oy] as [boolean, boolean] } : {}) };
    });
}

/** Where a median's body (between its noses) runs: from past its first nose to short of its last. */
export function medianBody(run: MedianRun): [number, number] {
  return [hasNose(run, 0) ? run.s0 + run.half : run.s0, hasNose(run, 1) ? run.s1 - run.half : run.s1];
}

/**
 * An island's stations along the road: at each its half width `w` (0 at a nose's tip). Round each
 * nose a semicircle, so its kerb curves round the end; along the body, every sample of the road.
 */
export function islandStations(run: MedianRun, samples: readonly RoadSample[]): { s: number; w: number }[] {
  const h = run.half;
  const out: { s: number; w: number }[] = [];
  const NOSE = 8;
  if (hasNose(run, 0))
    for (let k = 0; k < NOSE; k++) {
      // From the tip round to the side: angle from 0 to 90 degrees off the road's line.
      const a = (k / NOSE) * (Math.PI / 2);
      out.push({ s: run.s0 + h - h * Math.cos(a), w: h * Math.sin(a) });
    }
  const [lo, hi] = medianBody(run);
  out.push({ s: lo, w: h });
  for (const p of samples) if (p.s > lo + 0.05 && p.s < hi - 0.05) out.push({ s: p.s, w: h });
  out.push({ s: hi, w: h });
  if (hasNose(run, 1))
    for (let k = NOSE - 1; k >= 0; k--) {
      const a = (k / NOSE) * (Math.PI / 2);
      out.push({ s: run.s1 - h + h * Math.cos(a), w: h * Math.sin(a) });
    }
  return out;
}

/** A point `s` along a road's samples, interpolated (direction, height and fold limits too). */
export function pointAlong(samples: readonly RoadSample[], s: number): RoadSample {
  if (s <= samples[0]!.s) return samples[0]!;
  for (let i = 0; i < samples.length - 1; i++) {
    const a = samples[i]!;
    const b = samples[i + 1]!;
    if (b.s >= s) {
      const t = (s - a.s) / Math.max(1e-6, b.s - a.s);
      const left = Math.min(a.left ?? Infinity, b.left ?? Infinity);
      const right = Math.min(a.right ?? Infinity, b.right ?? Infinity);
      return {
        x: a.x + (b.x - a.x) * t,
        z: a.z + (b.z - a.z) * t,
        dx: a.dx,
        dz: a.dz,
        s,
        y: a.y + (b.y - a.y) * t,
        ...(Number.isFinite(left) ? { left } : {}),
        ...(Number.isFinite(right) ? { right } : {}),
      };
    }
  }
  return samples[samples.length - 1]!;
}
