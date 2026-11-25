/** Convex polygon clipping, for taking one surface out from under another. Vertices are [x, y, z, ...extra]. */

/**
 * A convex polygon of vertices (X, Y, Z, then anything else carried along: uvs) cut to one side of
 * a line in X-Z: what `keep` is at least 0 for, the crossings interpolated in every value.
 */
function clipHalf(poly: number[][], keep: (v: number[]) => number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const sa = keep(a);
    const sb = keep(b);
    if (sa >= 0) out.push(a);
    if (sa >= 0 !== sb >= 0) {
      const u = sa / (sa - sb);
      out.push(a.map((v, k) => v + (b[k]! - v) * u));
    }
  }
  return out;
}

/**
 * A convex polygon with convex outlines taken out of it (X, Z, counter-clockwise: inside to the left of each
 * side): the convex pieces of `poly` left outside all of them.
 */
export function outsideConvex(poly: number[][], cuts: readonly (readonly (readonly [number, number])[])[]): number[][][] {
  let pieces = [poly];
  for (const corners of cuts) {
    const next: number[][][] = [];
    for (const piece of pieces) {
      const fragments: number[][][] = [];
      let rest = piece;
      for (let k = 0; k < corners.length && rest.length >= 3; k++) {
        const p = corners[k]!;
        const q = corners[(k + 1) % corners.length]!;
        // Inside is to the left of each side.
        const side = (v: number[]): number => (q[0] - p[0]) * (v[2]! - p[1]) - (q[1] - p[1]) * (v[0]! - p[0]);
        const outside = clipHalf(rest, (v) => -side(v));
        if (outside.length >= 3 && area(outside) > 1e-8) fragments.push(outside);
        rest = clipHalf(rest, side);
      }
      // Nothing of it inside the cut: kept whole, not split along the cut's sides for nothing.
      if (rest.length < 3 || area(rest) <= 1e-8) next.push(piece);
      else next.push(...fragments);
    }
    pieces = next;
  }
  return pieces;
}

/** A polygon's area in X-Z (vertices X, Y, Z, ...), unsigned. */
function area(poly: readonly number[][]): number {
  let a = 0;
  for (let k = 0; k < poly.length; k++) {
    const p = poly[k]!;
    const q = poly[(k + 1) % poly.length]!;
    a += p[0]! * q[2]! - q[0]! * p[2]!;
  }
  return Math.abs(a) / 2;
}
