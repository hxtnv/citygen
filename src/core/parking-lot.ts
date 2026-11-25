import { insidePolygon, distanceToOutline } from "./polygon";

/**
 * Parking lots: the lot generator (road tool spec section 7). Given a lot's outline (counter-
 * clockwise in X-Z: a block's ground behind its sidewalks) and its settings, it lays out rows of
 * bays fitted to its longest side, aisles between them (each row's front on one), an aisle round
 * the rows' ends, planted islands at the ends of each strip of rows, lamps on every other strip's
 * islands, and the ways in kept clear. What it gives is the plan: the painted lines, the islands'
 * outlines (planted where the lot is drawn), the lamps and the bays.
 *
 * Bays are square to their aisle (90 degrees) or angled (60, 45: lines leaning one way, aisles
 * one-way and narrower). Rows run along the lot's longest side, from that side in:
 *
 *     edge | row > aisle < row row > aisle < row ... | edge
 *
 * a single row against the first edge facing in, then strips of two rows back to back, each with an
 * aisle in front, and a last single row against the far edge when there is room for one. Whatever
 * depth is left over is shared out evenly at both edges.
 *
 * Three-free and pure: the outline and the ways in are all it reads.
 */

type P = [number, number];

/** A lot's settings, all optional (see {@link LOT_DEFAULTS}). */
export interface LotSettings {
  /** A bay's width and depth, metres: a car's 2.6 x 5.2 (`CAR_BAY`), a truck's 3.7 x 16. */
  bay?: [number, number];
  /** An aisle's width, metres (unset: 7 two-way for square bays, 4.5 one-way for angled ones). */
  aisle?: number;
  /** The bays' angle to their aisle, degrees. */
  angle?: LotAngle;
  /** Planted, curbed islands at the ends of each strip of rows (default on). */
  islands?: boolean;
  /** Lamps on every other strip's islands (default on). */
  lamps?: boolean;
  /** More ways in or out besides the block's `entrance`: a point by each street's kerb. */
  ways?: P[];
}

export const LOT_ANGLES = [90, 60, 45] as const;
export type LotAngle = (typeof LOT_ANGLES)[number];

/** A car's bay and a truck's, width and depth, metres. */
export const LOT_CAR_BAY: P = [2.6, 5.2];

export const LOT_DEFAULTS = { bay: LOT_CAR_BAY, angle: 90 as LotAngle, islands: true, lamps: true };

/** An aisle's width unless set: two-way for square bays, one-way for angled. */
export function lotAisle(settings: Pick<LotSettings, "aisle" | "angle">): number {
  if (settings.aisle !== undefined) return settings.aisle;
  return (settings.angle ?? 90) === 90 ? 7 : 4.5;
}

/** Metres the bays keep in from the lot's edge. */
const MARGIN = 0.4;
/** An island's length along its strip, metres (a lamp and a shrub on it, a curb round it). */
const ISLAND = 2.2;
/** Metres an island keeps in from its strip's sides (the bays' outer line runs past it). */
const ISLAND_IN = 0.3;
/** The way in's width and how far either side of it the bays keep clear, metres. */
export const LOT_GATE = 7;
const GATE_CLEAR = 1.2;

/** A bay as laid: its middle on the ground and the way a car parked in it faces (nose in). */
export interface LotBay {
  at: P;
  /** Yaw of the car parked nose in: its facing (x = sin, z = cos), radians. */
  yaw: number;
}

export interface LotLayout {
  /** Painted lines, each from one end to the other. */
  lines: [P, P][];
  /** Islands' outlines, counter-clockwise. */
  islands: P[][];
  /** Lamps: where each stands and the way its arm reaches (yaw, as the street lamps': `atan2(x, z)`). */
  lamps: { at: P; yaw: number }[];
  bays: LotBay[];
}

interface Strip {
  /** Its band across (v from the first edge in). */
  v0: number;
  v1: number;
  /** Its rows: each its band and the way its front (the aisle) faces, +1 further in or -1 back. */
  rows: { v0: number; v1: number; facing: 1 | -1 }[];
}

/**
 * Lays out a lot (see the file's comment). `gates`: the ways in, each a point on its outline (the
 * sidewalk's back edge where the way in crosses it); the bays and islands in front of each are left
 * out, so a car drives straight in to an aisle.
 */
export function layoutLot(outline: readonly P[], settings: LotSettings = {}, gates: readonly P[] = [], sides: readonly P[] = outline): LotLayout {
  const out: LotLayout = { lines: [], islands: [], lamps: [], bays: [] };
  if (outline.length < 3) return out;
  const [w, d] = settings.bay ?? LOT_DEFAULTS.bay;
  const angle = settings.angle ?? LOT_DEFAULTS.angle;
  const aisle = Math.max(3, lotAisle(settings));
  const islands = settings.islands ?? LOT_DEFAULTS.islands;
  const lamps = settings.lamps ?? LOT_DEFAULTS.lamps;
  if (w < 1 || d < 2) return out;
  const theta = (angle * Math.PI) / 180;
  const sin = Math.sin(theta);
  const cos = Math.abs(Math.cos(theta)) < 1e-9 ? 0 : Math.cos(theta);
  // A row's depth across and a bay's width along it (a parallelogram when angled).
  const depth = d * sin;
  const along = w / sin;
  const lean = d * cos;

  // The frame: along the longest side (u), in from it (v).
  const side = longest(sides);
  const [ax, az] = side.a;
  const ux = side.dx;
  const uz = side.dz;
  const vx = -uz;
  const vz = ux;
  const toWorld = (u: number, v: number): P => [ax + ux * u + vx * v, az + uz * u + vz * v];
  const local = outline.map(([x, z]) => [(x - ax) * ux + (z - az) * uz, (x - ax) * vx + (z - az) * vz] as P);
  const vMin = Math.min(...local.map((p) => p[1])) + MARGIN;
  const vMax = Math.max(...local.map((p) => p[1])) - MARGIN;
  const room = vMax - vMin;
  if (room < depth + aisle) return out;

  // The strips across, from the first edge in.
  const strips: Strip[] = [];
  let v = vMin;
  strips.push({ v0: v, v1: v + depth, rows: [{ v0: v, v1: v + depth, facing: 1 }] });
  v += depth + aisle;
  while (v + 2 * depth + aisle <= vMax + 1e-6) {
    strips.push({
      v0: v,
      v1: v + 2 * depth,
      rows: [
        { v0: v, v1: v + depth, facing: -1 },
        { v0: v + depth, v1: v + 2 * depth, facing: 1 },
      ],
    });
    v += 2 * depth + aisle;
  }
  if (v + depth <= vMax + 1e-6) {
    strips.push({ v0: v, v1: v + depth, rows: [{ v0: v, v1: v + depth, facing: -1 }] });
    v += depth;
  } else v -= aisle;
  // The depth left over shared out at both edges.
  const shift = Math.max(0, vMax - v) / 2;
  for (const s of strips) {
    s.v0 += shift;
    s.v1 += shift;
    for (const r of s.rows) {
      r.v0 += shift;
      r.v1 += shift;
    }
  }

  // The ways in: each its point and the way in from the edge there (the outline's inward normal).
  const ways = gates.map((g) => gateFrame(outline, g));
  const inGate = (x: number, z: number, reach: number): boolean =>
    ways.some((g) => {
      const a = (x - g.at[0]) * g.tx + (z - g.at[1]) * g.tz;
      const n = (x - g.at[0]) * g.nx + (z - g.at[1]) * g.nz;
      return Math.abs(a) < LOT_GATE / 2 + GATE_CLEAR && n > -1 && n < reach;
    });
  const gateReach = depth + MARGIN + shift + 1.5;
  const clear = (x: number, z: number): boolean => insidePolygon(outline as P[], x, z) && distanceToOutline(outline as P[], x, z) > MARGIN - 0.15;

  // A strip's span along: inside the lot all across it, less an end aisle at either end.
  const endAisle = Math.max(aisle, 6);
  const doubles = strips.filter((s) => s.rows.length === 2);
  for (const strip of strips) {
    const span = spanAt(local, strip.v0 + 0.01, strip.v1 - 0.01);
    if (!span) continue;
    const u0 = span[0] + MARGIN + endAisle;
    const u1 = span[1] - MARGIN - endAisle;
    const island = islands ? ISLAND : 0;
    // Room along for the bays (an angled row's lean taken off its length).
    const b0 = u0 + island;
    const b1 = u1 - island - lean;
    const n = Math.floor((b1 - b0) / along + 1e-6);
    if (n < 2) continue;
    const start = b0 + (b1 - b0 - n * along) / 2;
    // Islands at both ends, the full depth of the strip, the bays' ends against them.
    const ends: { u0: number; u1: number }[] = islands
      ? [
          { u0: start - island, u1: start },
          { u0: start + n * along + lean, u1: start + n * along + lean + island },
        ]
      : [];
    // Lamps on every other strip of two rows (on every strip when there are none).
    const lit = lamps && (doubles.length === 0 || doubles.indexOf(strip) % 2 === 0);
    for (const e of ends) {
      const ring: P[] = [toWorld(e.u0, strip.v0 + ISLAND_IN), toWorld(e.u1, strip.v0 + ISLAND_IN), toWorld(e.u1, strip.v1 - ISLAND_IN), toWorld(e.u0, strip.v1 - ISLAND_IN)];
      if (ring.some(([x, z]) => !clear(x, z) || inGate(x, z, gateReach))) continue;
      out.islands.push(ring);
      if (lit) {
        const mid = toWorld((e.u0 + e.u1) / 2, (strip.v0 + strip.v1) / 2);
        // Its arm reaching along the strip, over the bays.
        const sign = e.u0 < start ? 1 : -1;
        out.lamps.push({ at: mid, yaw: Math.atan2(ux * sign, uz * sign) });
      }
    }
    // No islands: a lamp at each end of the strip's back line instead.
    if (!islands && lit)
      for (const [u, sign] of [
        [start - 0.6, 1],
        [start + n * along + lean + 0.6, -1],
      ] as const) {
        const back = strip.rows.length === 2 ? strip.rows[0]!.v1 : strip.rows[0]!.facing === 1 ? strip.v0 + 0.3 : strip.v1 - 0.3;
        const at = toWorld(u, back);
        if (clear(at[0], at[1]) && !inGate(at[0], at[1], gateReach)) out.lamps.push({ at, yaw: Math.atan2(ux * sign, uz * sign) });
      }
    // Each row's bays: kept where wholly on the lot and clear of the ways in.
    const kept = strip.rows.map((row) => {
      const vb = row.facing === 1 ? row.v0 : row.v1;
      const vf = row.facing === 1 ? row.v1 : row.v0;
      const keep: boolean[] = [];
      for (let k = 0; k < n; k++) {
        const ub = start + k * along;
        // Its four corners: the back's two, the front's two (leaned along by its angle).
        const corners: P[] = [toWorld(ub, vb), toWorld(ub + along, vb), toWorld(ub + along + lean, vf), toWorld(ub + lean, vf)];
        const ok = corners.every(([x, z]) => clear(x, z)) && !corners.some(([x, z]) => inGate(x, z, gateReach));
        keep.push(ok);
        if (!ok) continue;
        const mid = toWorld(ub + along / 2 + lean / 2, (vb + vf) / 2);
        // Nose in: from the front towards the back, along the bay's lean.
        const fx = -(ux * lean + vx * (vf - vb));
        const fz = -(uz * lean + vz * (vf - vb));
        out.bays.push({ at: mid, yaw: Math.atan2(fx, fz) });
      }
      // The lines between its bays (and at the ends of each run of them).
      for (let k = 0; k <= n; k++) {
        if (!keep[k - 1] && !keep[k]) continue;
        const ub = start + k * along;
        out.lines.push([toWorld(ub, vb), toWorld(ub + lean, vf)]);
      }
      return { keep, vb };
    });
    // The back line: one down the middle of a strip of two rows, else along its row's back.
    const vline = kept[0]!.vb;
    let from = -1;
    for (let k = 0; k <= n; k++) {
      const on = k < n && kept.some((r) => r.keep[k]);
      if (on && from < 0) from = k;
      if (!on && from >= 0) {
        out.lines.push([toWorld(start + from * along, vline), toWorld(start + k * along, vline)]);
        from = -1;
      }
    }
  }
  return out;
}

/** The outline's longest side: its start and unit direction (counter-clockwise round it). */
function longest(outline: readonly P[]): { a: P; dx: number; dz: number } {
  let best = 0;
  let most = -1;
  // Short sides (a sidewalk's samples along a curve) run together: the longest straight stretch.
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i]!;
    const b = outline[(i + 1) % outline.length]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (len > most) {
      most = len;
      best = i;
    }
  }
  const a = outline[best]!;
  const b = outline[(best + 1) % outline.length]!;
  return { a, dx: (b[0] - a[0]) / most, dz: (b[1] - a[1]) / most };
}

/** Where a line across (at `v`) is inside the outline (in its frame): its widest stretch. */
function intervalAt(local: readonly P[], v: number): P | null {
  const xs: number[] = [];
  for (let i = 0; i < local.length; i++) {
    const a = local[i]!;
    const b = local[(i + 1) % local.length]!;
    if ((a[1] <= v && b[1] > v) || (b[1] <= v && a[1] > v)) xs.push(a[0] + ((v - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
  }
  xs.sort((p, q) => p - q);
  let best: P | null = null;
  for (let i = 0; i + 1 < xs.length; i += 2) if (!best || xs[i + 1]! - xs[i]! > best[1] - best[0]) best = [xs[i]!, xs[i + 1]!];
  return best;
}

/** Where a band across (from `v0` to `v1`) is inside the outline all across it. */
function spanAt(local: readonly P[], v0: number, v1: number): P | null {
  let lo = -Infinity;
  let hi = Infinity;
  // Its edges, a few lines between, and every corner of the outline within it.
  const vs = [v0, v1, (v0 + v1) / 2, ...local.map((p) => p[1]).filter((v) => v > v0 && v < v1)];
  for (const v of vs) {
    const span = intervalAt(local, v);
    if (!span) return null;
    lo = Math.max(lo, span[0]);
    hi = Math.min(hi, span[1]);
  }
  return hi > lo ? [lo, hi] : null;
}

/** A way in's frame: its point, along the edge there (t) and in from it (n). */
function gateFrame(outline: readonly P[], at: P): { at: P; tx: number; tz: number; nx: number; nz: number } {
  let best = 0;
  let near = Infinity;
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i]!;
    const b = outline[(i + 1) % outline.length]!;
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const l2 = dx * dx + dz * dz;
    if (l2 < 1e-9) continue;
    const t = Math.max(0, Math.min(1, ((at[0] - a[0]) * dx + (at[1] - a[1]) * dz) / l2));
    const d = Math.hypot(a[0] + dx * t - at[0], a[1] + dz * t - at[1]);
    if (d < near) {
      near = d;
      best = i;
    }
  }
  const a = outline[best]!;
  const b = outline[(best + 1) % outline.length]!;
  const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const tx = (b[0] - a[0]) / l;
  const tz = (b[1] - a[1]) / l;
  // In: left of the way round (counter-clockwise).
  return { at: [at[0], at[1]], tx, tz, nx: -tz, nz: tx };
}

/** A convex ring (counter-clockwise) with every side moved in by `by` metres. */
export function insetRing(ring: readonly P[], by: number): P[] {
  const n = ring.length;
  const lines = ring.map((a, i) => {
    const b = ring[(i + 1) % n]!;
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const dx = (b[0] - a[0]) / l;
    const dz = (b[1] - a[1]) / l;
    // In: left of the way round.
    return { x: a[0] - dz * by, z: a[1] + dx * by, dx, dz };
  });
  return ring.map((p, i) => {
    const a = lines[(i - 1 + n) % n]!;
    const b = lines[i]!;
    const den = a.dx * b.dz - a.dz * b.dx;
    if (Math.abs(den) < 1e-9) return [b.x, b.z] as P;
    const t = ((b.x - a.x) * b.dz - (b.z - a.z) * b.dx) / den;
    return [a.x + a.dx * t, a.z + a.dz * t] as P;
  });
}
