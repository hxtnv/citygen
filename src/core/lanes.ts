import type { Arm, Junction, LaidRoad, NetworkLayout } from "./network";
import type { RoadKind, RoadSample, StreetClass } from "./roads";
import { medianBlocks, turnLanesAt } from "./road-sections";

/**
 * The lane graph: every road's lanes, each way, and the ways through each junction from one lane
 * to another - the network as a driver (or, later, the traffic) sees it. Worked out from the
 * network's layout alone, so it follows every edit; the lane marks (`lane-marks.ts`) are painted
 * from it and the traffic signals placed from it, so paint, signals and traffic always agree.
 *
 * - A road has one lane each way (a highway two), its centre half way across its half.
 * - A main street's 7 m each way is one wide lane along the block. Approaching a real junction
 *   (somewhere to go but straight on) with room for it, the last stretch splits into two equal
 *   lanes: the inner one for the left turn (or straight on, with no left), the outer one for the
 *   rest. Too short a block keeps the one lane to the stop line.
 * - An approach is a road's end at a junction, in the direction into it: its lanes, the ways on,
 *   its stop line and what controls it (a signal, a stop sign or nothing: the priority road).
 * - A connector is one way through a junction: from the end of one lane to the start of another,
 *   with its turn and a smooth path over the junction's asphalt.
 *
 * Distances along a road (`s`) are along its full centre line, as its samples'. An offset across
 * is positive to the right of the road's own direction (its samples' `dx, dz`), as the paint's.
 * Three-free and pure; cached per layout ({@link laneGraph}).
 */

export type Turn = "left" | "straight" | "right";
/** A way through a junction: a turn, or a U-turn back the way it came (a very sharp one). */
export type TurnKind = Turn | "u";
/** A travel lane, or one kept for a turn at the junction ahead. */
export type LaneKind = "travel" | "turn";
/** What an approach's traffic answers to: a traffic signal, a stop sign, a give-way line, or nothing (it has priority). */
export type Control = "signal" | "stop" | "yield" | "none";

export type LanePoint = [number, number, number];

export interface Lane {
  /** Its index in the graph's `lanes` (in a single road's lanes, its index there). */
  id: number;
  /** The road's index. */
  road: number;
  /** Which way it runs: +1 toward the road's end, -1 toward its start. */
  sign: 1 | -1;
  kind: LaneKind;
  /** Where it runs along the road, `s0 < s1` whichever way it is driven. */
  s0: number;
  s1: number;
  /** Its centre's offset across (positive: right of the road's own direction). */
  offset: number;
  width: number;
  /** A speed to drive it at, m/s. */
  speed: number;
  /** The ways it may leave the junction it ends at; empty where it does not end at one. */
  turns: Turn[];
  /** Its centre line in the direction of travel, every few metres. */
  path: LanePoint[];
  /** Lanes it runs on into along the same road (where one lane becomes two). */
  next: number[];
  /**
   * Whether traffic in it may cross to the other direction between junctions (turn back at a dead
   * end, say): not over an island or a barrier median, only at a junction's opening.
   */
  crossable: boolean;
}

export interface Connector {
  id: number;
  /** The junction's node id. */
  junction: number;
  /** Lane ids: the one it leaves and the one it joins. */
  from: number;
  to: number;
  turn: TurnKind;
  /** Over the junction from the end of `from` to the start of `to`. */
  path: LanePoint[];
}

export interface Approach {
  id: number;
  /** The junction's node id, the road's index and which of its ends. */
  junction: number;
  road: number;
  end: 0 | 1;
  /** The direction of travel along the road into the junction. */
  sign: 1 | -1;
  /** The ways on from the junction, left to right. */
  turns: Turn[];
  /** The lanes reaching the junction, inside (by the centre line) out. */
  lanes: number[];
  /** Where it widens to two lanes, along the road; null without. */
  split: number | null;
  /**
   * With turn arrows on its lanes as they are (no split): where its arrows' stretch begins, along
   * the road (the lines between its lanes are solid from there on). Null without.
   */
  arrows: number | null;
  /** The stop bar: along the road from `s0` to `s1`; traffic stops behind it. Null without one. */
  stop: { s0: number; s1: number } | null;
  control: Control;
}

/** A traffic signal: a pole on the far right corner of an approach, its arm over the lanes. */
export interface SignalPost {
  approach: number;
  junction: number;
  /** The pole's foot (on the sidewalk). */
  at: LanePoint;
  /** Unit direction of travel of the approach it controls (its heads face back along it). */
  facing: [number, number];
  /** Metres from the pole to each lane's centre, across the approach to its left; the pole's reach. */
  lanes: { reach: number; turn: boolean }[];
  /** Whether it carries a mast arm over the lanes (else its heads are on the pole). */
  mast: boolean;
}

export interface LaneGraph {
  lanes: Lane[];
  connectors: Connector[];
  approaches: Approach[];
  signals: SignalPost[];
}

/* Dimensions. */

/** A main street's turn lanes: the longest they run back from the stop line, and the shortest worth splitting. */
export const TURN_LANE = 30;
export const TURN_LANE_MIN = 14;
/** A stop bar's depth along the road, and how far it sits back from the junction's edge. */
export const STOP_DEPTH = 0.5;
const STOP_BACK = 1;
/** A zebra's half depth along the road, and the room kept round it. */
export const ZEBRA_HALF = 1.5;
const ZEBRA_CLEAR = 1;
/** Clear of the junction at a road's far end before an approach may begin (a dead end or a bend). */
const FAR_CLEAR = 10;
/** An arm closer than this to straight ahead (radians) is straight on; past this, a U-turn. */
const STRAIGHT_CONE = 0.7;
const U_TURN = 2.6;
/** Metres between the points of a lane's path. */
const PATH_STEP = 4;

/** How much a road counts at a junction: who gives way to whom (its profile's say, when it has one). */
export function rankOf(road: { kind: RoadKind; class?: StreetClass; section?: { rank: number } }): number {
  if (road.section) return road.section.rank;
  if (road.kind === "highway") return 4;
  if (road.kind === "road") return 3;
  if (road.kind === "dirt") return 0;
  return road.class === "main" ? 3 : road.class === "local" ? 1 : road.class === "lane" ? 0 : 2;
}

/**
 * How a road's approach to the junction at one of its ends takes its turns (`RoadSection.turnLanes`,
 * per approach by `turnStart` / `turnEnd`): `split`, one wide lane each way (6 m or more) split in two
 * for the turns, the inner one the left; `arrows`, its lanes as they are, an arrow in each for the
 * ways it may go; or not at all.
 */
export function turnLaneMode(laid: Pick<LaidRoad, "road" | "section">, end: 0 | 1): "split" | "arrows" | null {
  if (!turnLanesAt(laid.road, end, laid.section)) return null;
  return laid.section.lanes.count === 1 && laid.section.lanes.width >= 6 ? "split" : "arrows";
}

/* Turns. */

const ORDER: readonly Turn[] = ["left", "straight", "right"];

/** The signed angle (radians, positive to the right) from travelling into a junction along `arm` to leaving along `other`. */
function angleTo(arm: Arm, other: Arm): number {
  // Travelling in: the way the arm points, reversed. Right of that is (-tz, tx).
  const tx = -arm.dx;
  const tz = -arm.dz;
  return Math.atan2(other.dx * -tz + other.dz * tx, other.dx * tx + other.dz * tz);
}

/** Each other arm of a junction, and the way a road coming in along `arm` turns to leave along it. */
export function armTurns(junction: Junction, arm: Arm): Map<Arm, Turn> {
  const others = junction.arms.filter((o) => o !== arm);
  const angles = others.map((o) => angleTo(arm, o));
  let ahead = -1;
  angles.forEach((a, i) => {
    if (Math.abs(a) < STRAIGHT_CONE && (ahead < 0 || Math.abs(a) < Math.abs(angles[ahead]!))) ahead = i;
  });
  return new Map(others.map((o, i) => [o, i === ahead ? "straight" : angles[i]! > 0 ? "right" : "left"]));
}

/** The ways a road coming into a junction along `arm` can leave it, left to right. */
export function turnsAt(junction: Junction, arm: Arm): Turn[] {
  const found = new Set(armTurns(junction, arm).values());
  return ORDER.filter((t) => found.has(t));
}

/**
 * Which ways each lane of a split approach goes: the inner lane takes the left turn (or straight
 * on, with no left), the outer lane the rest. Null with fewer than two ways to go.
 */
export function laneTurns(turns: readonly Turn[]): { inner: Turn[]; outer: Turn[] } | null {
  if (turns.length < 2) return null;
  const inner: Turn[] = turns.includes("left") ? ["left"] : ["straight"];
  return { inner, outer: turns.filter((t) => !inner.includes(t)) };
}

/**
 * Which ways each of `n` side-by-side lanes (inside out) may go, for an approach with these ways
 * on: one lane goes every way; of two, the inner one left and straight on, the outer one straight
 * on and right (with no way straight on, left and right apart; with one way, both that way).
 */
function sharedTurns(turns: readonly Turn[], n: number): Turn[][] {
  if (n === 1 || turns.length <= 1) return Array.from({ length: n }, () => [...turns]);
  return Array.from({ length: n }, (_, i) => {
    const mine = turns.filter((t) => t === "straight" || (t === "left" && i === 0) || (t === "right" && i === n - 1));
    return mine.length > 0 ? mine : [...turns];
  });
}

/** The arm of a junction that is this end of this laid road. */
export function armOf(junction: Junction, laid: LaidRoad, end: 0 | 1): Arm | undefined {
  const { samples } = laid;
  if (samples.length < 2) return undefined;
  const length = samples[samples.length - 1]!.s;
  // As the layout judges an arm's direction: a few metres out along the road.
  const reach = Math.min(16, length / 3);
  const o = end === 0 ? samples[0]! : samples[samples.length - 1]!;
  const p = along(samples, end === 0 ? reach : length - reach);
  const d = Math.hypot(p.x - o.x, p.z - o.z) || 1;
  const dx = (p.x - o.x) / d;
  const dz = (p.z - o.z) / d;
  let best: Arm | undefined;
  let score = 0.95;
  for (const arm of junction.arms) {
    if (arm.end !== end || Math.abs(arm.half - laid.half) > 1e-6) continue;
    const dot = arm.dx * dx + arm.dz * dz;
    if (dot > score) {
      score = dot;
      best = arm;
    }
  }
  return best;
}

/**
 * What controls traffic coming in along `arm`, before signals: nothing at a bend or a dead end; a
 * stop sign for a road meeting a busier one, or at a crossing of equals with no through road;
 * nothing for the through road. `laneGraph` turns a busy main-street junction's into signals.
 */
export function controlAt(junction: Junction, arm: Arm): Control {
  if (junction.arms.length < 3) return "none";
  // The junction's own say (its card): an all-way stop, no control at all, or give way where the
  // usual would stop (signals are laid on in `laneGraph`).
  const own = junction.node.control;
  if (own === "stop") return "stop";
  if (own === "none" || own === "signals") return own === "none" ? "none" : rankedControl(junction, arm);
  if (own === "yield") return rankedControl(junction, arm) === "stop" ? "yield" : "none";
  return rankedControl(junction, arm);
}

/** Who gives way by the roads' ranks (see {@link controlAt}). */
function rankedControl(junction: Junction, arm: Arm): Control {
  const ranks = junction.arms.map((a) => rankOf(a));
  const top = Math.max(...ranks);
  const mine = rankOf(arm);
  if (mine < top) return "stop";
  if (ranks.filter((r) => r === top).length < 3) return "none";
  // A T of equals: the road through has priority, the stem stops. Any more: an all-way stop.
  if (junction.arms.length === 3) {
    const through = [...armTurns(junction, arm)].some(([other, turn]) => turn === "straight" && rankOf(other) === top);
    return through ? "none" : "stop";
  }
  return "stop";
}

/** Whether a junction gets traffic signals: main streets crossing, or a main street's junction with turn lanes. */
function signalled(junction: Junction, split: boolean): boolean {
  if (junction.arms.length < 3) return false;
  const own = junction.node.control;
  if (own === "signals") return true;
  if (own !== undefined && own !== "auto") return false;
  const main = junction.arms.filter((a) => a.kind === "street" && a.class === "main").length;
  const major = junction.arms.filter((a) => rankOf(a) >= 3).length;
  return main >= 3 || (main >= 1 && major >= 2 && split);
}

/* One road's lanes. */

/** One road's lanes and its approaches to the junctions at its ends; ids index these arrays. */
export interface RoadLanes {
  lanes: Lane[];
  approaches: Approach[];
}

/**
 * A road's lanes, each way, and its approaches, from the junctions at its ends (`junctionAt`, by
 * node id). See the file's comment.
 */
export function roadLanes(laid: LaidRoad, junctionAt: (id: number) => Junction | undefined): RoadLanes {
  const out: RoadLanes = { lanes: [], approaches: [] };
  const { road, samples, section } = laid;
  // The lanes take the road's lanes' band each way, from its median's edge (`inner`) out; a hard
  // shoulder past them is not a lane, nor is the median.
  const inner = section.inner;
  const half = section.band - inner;
  if (samples.length < 2) return out;
  const length = samples[samples.length - 1]!.s;
  const s0 = laid.trimStart;
  const s1 = length - laid.trimEnd;
  const driven = s1 - s0;
  if (driven < 0.5) return out;
  const crossings = road.crossings ?? [];
  const n = section.lanes.count;
  const speed = section.lanes.speed;
  const crossable = !medianBlocks(section.median.kind);
  const ends = ([0, 1] as const).map((end) => {
    const id = end === 0 ? road.from : road.to;
    const junction = id === undefined ? undefined : junctionAt(id);
    const arm = junction ? armOf(junction, laid, end) : undefined;
    const turns = junction && arm ? turnsAt(junction, arm) : [];
    return { end, junction, arm, turns, real: turns.length >= 2, control: junction && arm ? controlAt(junction, arm) : ("none" as Control) };
  });

  for (const sign of [1, -1] as const) {
    // Into the junction at the end it runs toward.
    const end: 0 | 1 = sign === 1 ? 1 : 0;
    const e = ends[end]!;
    const other = ends[1 - end]!;
    const mouth = end === 1 ? s1 : s0;
    const start = end === 1 ? s0 : s1;
    /** Metres back from the junction's edge, as a distance along the road. */
    const back = (b: number): number => mouth - sign * b;
    const make = (kind: LaneKind, from: number, until: number, offset: number, width: number, turns: Turn[]): Lane => {
      const lane: Lane = {
        id: out.lanes.length,
        road: laid.index,
        sign,
        kind,
        s0: Math.min(from, until),
        s1: Math.max(from, until),
        offset: sign * (inner + offset),
        width,
        speed: kind === "turn" ? Math.min(speed, 9) : speed,
        turns,
        path: [],
        next: [],
        crossable,
      };
      lane.path = lanePath(samples, lane);
      out.lanes.push(lane);
      return lane;
    };

    // The stop bar, behind any zebra at the junction, where there is a control (or a main street's real junction).
    const room = other.real ? driven / 2 : driven - FAR_CLEAR;
    const zebras = crossings.map((c) => sign * (mouth - c)).filter((b) => b > -ZEBRA_HALF && b < room + ZEBRA_HALF);
    let far = STOP_BACK;
    for (const b of zebras) if (b < 12) far = Math.max(far, b + ZEBRA_HALF + ZEBRA_CLEAR);
    // A zebra across this end of it at the junction (in line with the cross street's sidewalks): behind it.
    const trimHere = end === 1 ? laid.trimEnd : laid.trimStart;
    for (const z of e.junction?.crossings ?? []) if (z.road === laid.index && z.end === end) far = Math.max(far, z.c1 - trimHere + ZEBRA_CLEAR);
    const near = far + STOP_DEPTH;
    const mode = turnLaneMode(laid, end);
    const wantsStop = e.junction !== undefined && e.arm !== undefined && (e.control !== "none" || (mode !== null && e.real));
    const stop = wantsStop && near + 0.5 < Math.max(room, driven * 0.45) ? { s0: Math.min(back(far), back(near)), s1: Math.max(back(far), back(near)) } : null;

    // A main street's turn lanes, where the block is long enough and nothing is in the way.
    const turnLane = Math.min(TURN_LANE, room);
    const split = mode === "split" && e.real && stop !== null && turnLane >= TURN_LANE_MIN && zebras.every((b) => b < far || b - ZEBRA_HALF - ZEBRA_CLEAR > turnLane);
    const lanes: Lane[] = [];
    if (split) {
      const at = back(turnLane);
      const mid = make("travel", start, at, half / 2, half, []);
      const ways = laneTurns(e.turns)!;
      const kindOf = (turns: Turn[]): LaneKind => (turns.length === 1 && turns[0] !== "straight" ? "turn" : "travel");
      const inner = make(kindOf(ways.inner), at, mouth, half / 4, half / 2, ways.inner);
      const outer = make(kindOf(ways.outer), at, mouth, (half * 3) / 4, half / 2, ways.outer);
      mid.next = [inner.id, outer.id];
      lanes.push(inner, outer);
    } else {
      const ways = sharedTurns(e.turns, n);
      for (let i = 0; i < n; i++) lanes.push(make("travel", start, mouth, ((i + 0.5) * half) / n, half / n, e.junction ? ways[i]! : []));
    }
    if (e.junction && e.arm && e.turns.length > 0)
      out.approaches.push({
        id: out.approaches.length,
        junction: e.junction.node.id,
        road: laid.index,
        end,
        sign,
        turns: e.turns,
        lanes: lanes.map((l) => l.id),
        split: split ? back(turnLane) : null,
        arrows: !split && mode === "arrows" && e.real && stop !== null ? back(Math.min(TURN_LANE, room)) : null,
        stop,
        control: e.control,
      });
  }
  return out;
}

/** A lane's centre line in its direction of travel. */
function lanePath(samples: readonly RoadSample[], lane: Pick<Lane, "s0" | "s1" | "offset" | "sign">): LanePoint[] {
  const steps = Math.max(1, Math.ceil((lane.s1 - lane.s0) / PATH_STEP));
  const out: LanePoint[] = [];
  for (let k = 0; k <= steps; k++) {
    const p = sampleOn(samples, lane.s0 + ((lane.s1 - lane.s0) * k) / steps);
    out.push([p.x - p.dz * lane.offset, p.y, p.z + p.dx * lane.offset]);
  }
  return lane.sign === 1 ? out : out.reverse();
}

/* The whole network. */

const cache = new WeakMap<NetworkLayout, LaneGraph>();

/** The lane graph of a laid-out network (worked out once per layout). See the file's comment. */
export function laneGraph(layout: NetworkLayout): LaneGraph {
  const known = cache.get(layout);
  if (known) return known;
  const graph = buildGraph(layout);
  cache.set(layout, graph);
  return graph;
}

function buildGraph(layout: NetworkLayout): LaneGraph {
  const byNode = new Map(layout.junctions.map((j) => [j.node.id, j]));
  const graph: LaneGraph = { lanes: [], connectors: [], approaches: [], signals: [] };
  const armOfApproach = new Map<Approach, Arm>();
  /**
   * Per arm (a road's end at a junction, found as `roadLanes` finds it, so a road renumbered by an
   * edit is still matched): the lanes leaving the junction along it, inside out, and its approach.
   */
  const leaving = new Map<Arm, Lane[]>();
  const into = new Map<Arm, Approach>();
  for (const laid of layout.roads) {
    const own = roadLanes(laid, (id) => byNode.get(id));
    const arms = ([0, 1] as const).map((end) => {
      const junction = byNode.get((end === 0 ? laid.road.from : laid.road.to) ?? NaN);
      return junction ? armOf(junction, laid, end) : undefined;
    });
    const base = graph.lanes.length;
    for (const lane of own.lanes) {
      lane.id += base;
      lane.next = lane.next.map((i) => i + base);
      graph.lanes.push(lane);
    }
    for (const approach of own.approaches) {
      approach.id = graph.approaches.length;
      approach.lanes = approach.lanes.map((i) => i + base);
      graph.approaches.push(approach);
      const arm = arms[approach.end];
      if (arm) {
        into.set(arm, approach);
        armOfApproach.set(approach, arm);
      }
    }
    // Leaving the start: the lanes running +s that begin at the road's start (and -s at its end).
    const starts: [Lane[], Lane[]] = [[], []];
    const lo = Math.min(...own.lanes.map((l) => l.s0));
    const hi = Math.max(...own.lanes.map((l) => l.s1));
    for (const lane of own.lanes) {
      if (lane.sign === 1 && lane.s0 <= lo + 1e-6) starts[0].push(lane);
      if (lane.sign === -1 && lane.s1 >= hi - 1e-6) starts[1].push(lane);
    }
    starts.forEach((list, end) => {
      list.sort((a, b) => Math.abs(a.offset) - Math.abs(b.offset));
      const arm = arms[end];
      if (arm) leaving.set(arm, list);
    });
  }

  // Signals: a junction's approaches all answer to them, where it is signalled.
  const atJunction = new Map<number, Approach[]>();
  for (const a of graph.approaches) atJunction.set(a.junction, [...(atJunction.get(a.junction) ?? []), a]);
  for (const [id, approaches] of atJunction) {
    const junction = byNode.get(id)!;
    if (
      !signalled(
        junction,
        approaches.some((a) => a.split !== null),
      )
    )
      continue;
    for (const a of approaches) a.control = "signal";
  }

  // Connectors: from each approach's lanes to the lanes leaving by each way they may go.
  for (const junction of layout.junctions) {
    // A cul-de-sac: round its bulb and back out the way it came (a U-turn, round the back).
    if (junction.arms.length === 1 && junction.node.bulb && junction.outline.length > 2) {
      const arm = junction.arms[0]!;
      const out = leaving.get(arm) ?? [];
      // The lanes in: those of its street running toward it (a dead end has no approach: nowhere to
      // turn but round), as far along as they go.
      const sign = arm.end === 1 ? 1 : -1;
      const toward = graph.lanes.filter((l) => l.road === arm.road && l.sign === sign);
      const reach = sign === 1 ? Math.max(...toward.map((l) => l.s1)) : Math.min(...toward.map((l) => l.s0));
      const ending = toward.filter((l) => Math.abs((sign === 1 ? l.s1 : l.s0) - reach) < 1e-6);
      if (out.length)
        for (const lane of ending) {
          const to = out[out.length - 1]!;
          const path = roundBulb(junction, arm, lane.path[lane.path.length - 1]!, to.path[0]!);
          graph.connectors.push({ id: graph.connectors.length, junction: junction.node.id, from: lane.id, to: to.id, turn: "u", path });
        }
      continue;
    }
    if (junction.arms.length < 2) continue;
    for (const arm of junction.arms) {
      const approach = into.get(arm);
      if (!approach) continue;
      const ways = armTurns(junction, arm);
      approach.lanes.forEach((laneId, index) => {
        const lane = graph.lanes[laneId]!;
        for (const [other, turn] of ways) {
          if (!lane.turns.includes(turn)) continue;
          const targets = leaving.get(other) ?? [];
          if (targets.length === 0) continue;
          const to = turn === "left" ? targets[0]! : turn === "right" ? targets[targets.length - 1]! : targets[Math.min(index, targets.length - 1)]!;
          const angle = Math.abs(angleTo(arm, other));
          graph.connectors.push({
            id: graph.connectors.length,
            junction: junction.node.id,
            from: lane.id,
            to: to.id,
            turn: angle > U_TURN ? "u" : turn,
            path: connectorPath(lane.path[lane.path.length - 1]!, lane.path[lane.path.length - 2] ?? lane.path[0]!, to.path[0]!, to.path[1] ?? to.path[0]!),
          });
        }
      });
    }
  }

  // A signal post for each signalled approach.
  for (const a of graph.approaches) {
    if (a.control !== "signal") continue;
    const arm = armOfApproach.get(a);
    const post = arm ? signalPost(byNode.get(a.junction)!, arm, a, graph.lanes) : null;
    if (post) graph.signals.push(post);
  }
  return graph;
}

/**
 * The way round a cul-de-sac's bulb from where a lane ends (`p`) to where the lane back out starts
 * (`q`): an arc round the node the long way, by the back of the bulb (away from its street), out
 * to half a lane inside the kerb there.
 */
function roundBulb(junction: Junction, arm: Arm, p: LanePoint, q: LanePoint): LanePoint[] {
  const { node } = junction;
  const a0 = Math.atan2(p[2] - node.z, p[0] - node.x);
  const a1 = Math.atan2(q[2] - node.z, q[0] - node.x);
  const r0 = Math.hypot(p[0] - node.x, p[2] - node.z);
  const r1 = Math.hypot(q[0] - node.x, q[2] - node.z);
  const back = arm.angle + Math.PI;
  // Counter-clockwise or clockwise from a0 to a1: the way whose middle is at the back.
  const ccw = (((a1 - a0) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  const sweep = [ccw, ccw - Math.PI * 2].sort((x, y) => {
    const off = (d: number): number => Math.abs(Math.atan2(Math.sin(a0 + d / 2 - back), Math.cos(a0 + d / 2 - back)));
    return off(x) - off(y);
  })[0]!;
  const rb = node.bulb ? node.bulb - arm.half / 2 - 1 : Math.min(r0, r1);
  const steps = Math.max(8, Math.ceil((Math.abs(sweep) * rb) / 2));
  const out: LanePoint[] = [];
  for (let k = 0; k <= steps; k++) {
    const t = k / steps;
    const a = a0 + sweep * t;
    const base = r0 + (r1 - r0) * t;
    const r = base + (rb - base) * Math.sin(Math.PI * t);
    out.push([node.x + Math.cos(a) * r, p[1] + (q[1] - p[1]) * t, node.z + Math.sin(a) * r]);
  }
  return out;
}

/**
 * A smooth way over a junction from `p` (arriving from `pBefore`) to `q` (leaving toward `qAfter`):
 * a quadratic curve through where the two lines meet when they do, ahead of both; else a cubic
 * leaving and arriving along them.
 */
function connectorPath(p: LanePoint, pBefore: LanePoint, q: LanePoint, qAfter: LanePoint): LanePoint[] {
  const unit = (a: LanePoint, b: LanePoint): [number, number] => {
    const d = Math.hypot(b[0] - a[0], b[2] - a[2]) || 1;
    return [(b[0] - a[0]) / d, (b[2] - a[2]) / d];
  };
  const [ax, az] = unit(pBefore, p);
  const [bx, bz] = unit(q, qAfter);
  const gap = Math.hypot(q[0] - p[0], q[2] - p[2]);
  const steps = Math.max(4, Math.ceil(gap / 2));
  const out: LanePoint[] = [];
  const cross = ax * bz - az * bx;
  // Where p + a t meets q - b u.
  const t = Math.abs(cross) > 0.15 ? ((q[0] - p[0]) * bz - (q[2] - p[2]) * bx) / cross : -1;
  const u = Math.abs(cross) > 0.15 ? ((q[0] - p[0]) * az - (q[2] - p[2]) * ax) / cross : -1;
  for (let k = 0; k <= steps; k++) {
    const f = k / steps;
    const y = p[1] + (q[1] - p[1]) * f;
    if (t > 0.5 && u > 0.5 && t < gap * 2 && u < gap * 2) {
      const cx = p[0] + ax * t;
      const cz = p[2] + az * t;
      const g = 1 - f;
      out.push([g * g * p[0] + 2 * g * f * cx + f * f * q[0], y, g * g * p[2] + 2 * g * f * cz + f * f * q[2]]);
    } else {
      const h0 = 2 * f ** 3 - 3 * f ** 2 + 1;
      const h1 = f ** 3 - 2 * f ** 2 + f;
      const h2 = -2 * f ** 3 + 3 * f ** 2;
      const h3 = f ** 3 - f ** 2;
      out.push([h0 * p[0] + h1 * gap * ax + h2 * q[0] + h3 * gap * bx, y, h0 * p[2] + h1 * gap * az + h2 * q[2] + h3 * gap * bz]);
    }
  }
  return out;
}

/** How far out from an approach's right edge a signal pole stands, metres. */
const POLE_OUT = 0.9;
/** The longest reach from a pole to a lane's centre that a mast arm serves. */
export const MAST_REACH = 6.6;

/**
 * Where an approach's signal stands: on the far right corner, just past the junction - on the
 * right of the road straight ahead, a little way along it, or (no road straight ahead) on the far
 * kerb across the junction - with how far each of its lanes is to the pole's left.
 */
function signalPost(junction: Junction, arm: Arm, approach: Approach, lanes: readonly Lane[]): SignalPost | null {
  // The way in, and right of it.
  const fx = -arm.dx;
  const fz = -arm.dz;
  const rx = -fz;
  const rz = fx;
  const { node } = junction;
  const ways = armTurns(junction, arm);
  const ahead = [...ways].find(([, t]) => t === "straight")?.[0];
  let x: number;
  let z: number;
  if (ahead) {
    // Along the road ahead, a little past its mouth, on its right ((-dz, dx) of the way along it).
    const out = ahead.trim + 2.5;
    const lateral = ahead.half + (ahead.walk > 0 ? POLE_OUT : 1.6);
    x = node.x + ahead.dx * out - ahead.dz * lateral;
    z = node.z + ahead.dz * out + ahead.dx * lateral;
  } else {
    // Across the junction to the far kerb of the road it meets, then out onto its sidewalk.
    let reach = 0;
    for (const other of junction.arms) {
      if (other === arm) continue;
      const sin = Math.abs(fx * other.dz - fz * other.dx);
      if (sin > 0.5) reach = Math.max(reach, other.half / sin + (other.walk > 0 ? Math.min(other.walk / 2, 1.5) : 1.6) / sin);
    }
    if (reach === 0) return null;
    x = node.x + fx * reach + rx * (arm.half + POLE_OUT);
    z = node.z + fz * reach + rz * (arm.half + POLE_OUT);
  }
  // Each lane's centre, as a distance to the pole's left across the approach: the pole's own
  // offset to the right of the approach's centre line (through the node), less the lane's.
  const pole = (x - node.x) * rx + (z - node.z) * rz;
  const toLane = approach.lanes.map((id) => ({ reach: pole - Math.abs(lanes[id]!.offset), turn: lanes[id]!.kind === "turn" }));
  // A mast arm over a wide approach whose lanes it reaches; heads on the pole for a narrow one.
  const mast = arm.half >= 5 && toLane.every((l) => l.reach > 1 && l.reach < MAST_REACH);
  return { approach: approach.id, junction: junction.node.id, at: [x, node.y, z], facing: [fx, fz], lanes: toLane, mast };
}

/* Helpers. */

/** A point `s` along a sampled line, interpolated, with its direction and height. */
function sampleOn(samples: readonly RoadSample[], s: number): RoadSample {
  if (s <= samples[0]!.s) return samples[0]!;
  for (let i = 0; i < samples.length - 1; i++) {
    const a = samples[i]!;
    const b = samples[i + 1]!;
    if (b.s >= s) {
      const t = (s - a.s) / Math.max(1e-6, b.s - a.s);
      return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, dx: a.dx, dz: a.dz, s, y: a.y + (b.y - a.y) * t };
    }
  }
  return samples[samples.length - 1]!;
}

function along(line: readonly { x: number; z: number; s: number }[], s: number): { x: number; z: number } {
  return sampleOn(line as readonly RoadSample[], s);
}
