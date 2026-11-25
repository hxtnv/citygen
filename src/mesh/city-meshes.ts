import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  Vector3,
} from "three";
import type { CityBuilding, CityData } from "../core/city";
import type { District } from "../core/blocks";
import { mulberry32 } from "../core/noise";
import { RoadGeometry, type RoadSlot } from "./roads-geometry";

/** Colours for everything drawn. Any left out keeps its default. */
export interface CityPalette {
  ground: string;
  asphalt: string;
  dirt: string;
  sidewalk: string;
  concrete: string;
  shoulder: string;
  median: string;
  /** Building colours per district: a few each, picked at random per building. */
  districts: Partial<Record<District, string[]>>;
  roof: string;
  treeLeaves: string;
  treeTrunk: string;
}

export const DEFAULT_PALETTE: CityPalette = {
  ground: "#93a873",
  asphalt: "#3d3f44",
  dirt: "#7a6247",
  sidewalk: "#b9b5ac",
  concrete: "#9d9a93",
  shoulder: "#8a8676",
  median: "#6f9150",
  districts: {
    downtown: ["#c9d3dc", "#a9b8c6", "#d8d2c4", "#8e9fb1", "#e3e0d8", "#b7c4cf"],
    shops: ["#e0b48a", "#d99a7a", "#efd9a8", "#c9a27e", "#e6c9b5", "#b88b6a"],
    suburb: ["#f2ede4", "#e8d9c0", "#d6e0e6", "#f0e0d0", "#e3d3c3", "#cfd8c8"],
    industrial: ["#9aa0a6", "#b3a58f", "#8f9a8c", "#a7a39b"],
    park: ["#e8e0d0"],
    empty: ["#cccccc"],
  },
  roof: "#5a5d63",
  treeLeaves: "#6f9a4c",
  treeTrunk: "#6b4f35",
};

export interface CityMeshOptions {
  palette?: Partial<CityPalette>;
  /** Cast and receive shadows (default true). */
  shadows?: boolean;
  /** Draw the ground plane (default true). */
  ground?: boolean;
}

/** Everything of a city as one group: ground, roads, buildings, trees. */
export function buildCityMeshes(city: CityData, options: CityMeshOptions = {}): Group {
  const palette = { ...DEFAULT_PALETTE, ...options.palette, districts: { ...DEFAULT_PALETTE.districts, ...options.palette?.districts } };
  const shadows = options.shadows ?? true;
  const group = new Group();
  group.name = "city";
  if (options.ground ?? true) group.add(buildGround(city, palette, shadows));
  group.add(buildRoadMeshes(city, palette, shadows));
  group.add(buildBuildingMeshes(city.buildings, palette, shadows));
  if (city.trees.length) group.add(buildTreeMeshes(city.trees, palette, shadows));
  return group;
}

/** A flat ground plane under the whole area. */
export function buildGround(city: CityData, palette: CityPalette = DEFAULT_PALETTE, shadows = true): Mesh {
  const { minX, maxX, minZ, maxZ } = city.bounds;
  const size = Math.max(maxX - minX, maxZ - minZ) * 4;
  const geometry = new PlaneGeometry(size, size);
  geometry.rotateX(-Math.PI / 2);
  const mesh = new Mesh(geometry, new MeshStandardMaterial({ color: palette.ground, roughness: 1 }));
  mesh.name = "ground";
  mesh.position.set((minX + maxX) / 2, -0.02, (minZ + maxZ) / 2);
  mesh.receiveShadow = shadows;
  return mesh;
}

/**
 * The road network as merged meshes, one per surface: asphalt, painted lines (vertex coloured),
 * sidewalks and kerbs, junction paving, lawns. Procedural, no textures.
 */
export function buildRoadMeshes(city: CityData, palette: CityPalette = DEFAULT_PALETTE, shadows = true): Group {
  const arrays = new RoadGeometry(city.terrain).buildArrays();
  const group = new Group();
  group.name = "roads";
  const flat = (color: string, extra: Partial<ConstructorParameters<typeof MeshStandardMaterial>[0]> = {}): MeshStandardMaterial =>
    new MeshStandardMaterial({ color, roughness: 0.95, metalness: 0, ...extra });
  const materials: Record<RoadSlot, MeshStandardMaterial> = {
    asphalt: flat(palette.asphalt, { roughness: 0.9 }),
    lots: flat(palette.asphalt, { roughness: 0.9 }),
    dirt: flat(palette.dirt),
    paint: flat("#ffffff", { vertexColors: true, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    walk: flat(palette.sidewalk),
    concrete: flat(palette.concrete),
    shoulder: flat(palette.shoulder),
    roadside: flat("#ffffff", { vertexColors: true }),
    median: flat(palette.median),
  };
  for (const [slot, made] of Object.entries(arrays) as [RoadSlot, NonNullable<(typeof arrays)[RoadSlot]>][]) {
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(made.position, 3));
    geometry.setAttribute("normal", new BufferAttribute(made.normal, 3));
    geometry.setAttribute("uv", new BufferAttribute(made.uv, 2));
    if (made.color) geometry.setAttribute("color", new BufferAttribute(made.color, 3));
    geometry.computeBoundingSphere();
    const mesh = new Mesh(geometry, materials[slot]);
    mesh.name = slot;
    mesh.receiveShadow = shadows;
    mesh.castShadow = shadows && (slot === "walk" || slot === "concrete");
    group.add(mesh);
  }
  return group;
}

/**
 * Buildings as boxes: one instanced mesh for the walls of every building, one for the roofs (a
 * slab a touch wider on top of shops and towers, a low pyramid-ish cap on houses), each instance
 * coloured from its district's palette.
 */
export function buildBuildingMeshes(buildings: readonly CityBuilding[], palette: CityPalette = DEFAULT_PALETTE, shadows = true): Group {
  const group = new Group();
  group.name = "buildings";
  if (buildings.length === 0) return group;
  const box = new BoxGeometry(1, 1, 1);
  box.translate(0, 0.5, 0);
  const walls = new InstancedMesh(box, facadeMaterial(), buildings.length);
  const roofs = new InstancedMesh(box, new MeshStandardMaterial({ color: palette.roof, roughness: 0.9 }), buildings.length);
  const houses = buildings.filter((b) => b.kind === "house").length;
  const capGeometry = new ConeGeometry(Math.SQRT1_2, 1, 4, 1);
  capGeometry.rotateY(Math.PI / 4);
  capGeometry.translate(0, 0.5, 0);
  const caps = new InstancedMesh(capGeometry, new MeshStandardMaterial({ color: palette.roof, roughness: 0.9, flatShading: true }), Math.max(1, houses));
  const m = new Matrix4();
  const q = new Quaternion();
  const up = new Vector3(0, 1, 0);
  const color = new Color();
  let n = 0;
  let c = 0;
  buildings.forEach((b, i) => {
    const roll = mulberry32(Math.round(b.x * 131 + b.z * 71) ^ i)();
    const colours = palette.districts[b.district] ?? ["#cccccc"];
    color.set(colours[Math.floor(roll * colours.length) % colours.length]!);
    q.setFromAxisAngle(up, b.yaw);
    m.compose(new Vector3(b.x, b.y, b.z), q, new Vector3(b.width, b.height, b.depth));
    walls.setMatrixAt(i, m);
    walls.setColorAt(i, color);
    if (b.kind === "house") {
      m.compose(new Vector3(b.x, b.y + b.height, b.z), q, new Vector3(b.width * 1.08, Math.min(b.width, b.depth) * 0.4, b.depth * 1.08));
      caps.setMatrixAt(c++, m);
    } else {
      m.compose(new Vector3(b.x, b.y + b.height, b.z), q, new Vector3(b.width * 0.96, 0.6, b.depth * 0.96));
      roofs.setMatrixAt(n++, m);
    }
  });
  roofs.count = n;
  caps.count = c;
  for (const mesh of [walls, roofs, caps]) {
    mesh.castShadow = shadows;
    mesh.receiveShadow = shadows;
    mesh.computeBoundingSphere();
    group.add(mesh);
  }
  walls.name = "walls";
  roofs.name = "roofs";
  caps.name = "house-roofs";
  return group;
}

/** Trees as instanced cones on trunks. */
export function buildTreeMeshes(trees: CityData["trees"], palette: CityPalette = DEFAULT_PALETTE, shadows = true): Group {
  const group = new Group();
  group.name = "trees";
  const trunkGeometry = new CylinderGeometry(0.18, 0.25, 2, 6);
  trunkGeometry.translate(0, 1, 0);
  const crownGeometry = new ConeGeometry(1.8, 4.5, 7);
  crownGeometry.translate(0, 3.8, 0);
  const trunks = new InstancedMesh(trunkGeometry, new MeshStandardMaterial({ color: palette.treeTrunk, roughness: 1 }), trees.length);
  const crowns = new InstancedMesh(crownGeometry, new MeshStandardMaterial({ color: palette.treeLeaves, roughness: 0.9, flatShading: true }), trees.length);
  const m = new Matrix4();
  const q = new Quaternion();
  const color = new Color();
  const base = new Color(palette.treeLeaves);
  trees.forEach((t, i) => {
    const s = t.scale;
    q.setFromAxisAngle(new Vector3(0, 1, 0), (t.x * 7.1 + t.z * 3.3) % (Math.PI * 2));
    m.compose(new Vector3(t.x, t.y, t.z), q, new Vector3(s, s, s));
    trunks.setMatrixAt(i, m);
    crowns.setMatrixAt(i, m);
    const shade = 0.85 + ((((t.x * 12.9898 + t.z * 78.233) % 1) + 1) % 1) * 0.3;
    crowns.setColorAt(i, color.copy(base).multiplyScalar(shade));
  });
  for (const mesh of [trunks, crowns]) {
    mesh.castShadow = shadows;
    mesh.receiveShadow = shadows;
    mesh.computeBoundingSphere();
    group.add(mesh);
  }
  return group;
}

/**
 * Walls with rows of windows: each instance's box measured in metres (its scale read off its
 * instance matrix), a window every 3.2 m along each wall and a floor every 3.4 m up, so they keep
 * their size whatever the building's.
 */
const FACADE_VARYINGS = ["#include <common>", "varying vec3 vFacade;", "varying vec3 vFacadeNormal;", "varying float vFacadeTop;"].join(String.fromCharCode(10));

function facadeMaterial(): MeshStandardMaterial {
  const material = new MeshStandardMaterial({ roughness: 0.85, metalness: 0.02 });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace("#include <common>", FACADE_VARYINGS).replace(
      "#include <begin_vertex>",
      `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vec3 facadeScale = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
        #else
          vec3 facadeScale = vec3(1.0);
        #endif
        vFacade = position * facadeScale;
        vFacadeNormal = normal;
        vFacadeTop = facadeScale.y;`,
    );
    shader.fragmentShader = shader.fragmentShader.replace("#include <common>", FACADE_VARYINGS).replace(
      "#include <color_fragment>",
      `#include <color_fragment>
        if (abs(vFacadeNormal.y) < 0.5) {
          float along = abs(vFacadeNormal.x) > 0.5 ? vFacade.z : vFacade.x;
          float fu = fract(along / 3.2 + 0.5);
          float fv = fract(vFacade.y / 3.4);
          bool glass = vFacade.y > 1.0 && vFacade.y < vFacadeTop - 0.7 && fu > 0.22 && fu < 0.78 && fv > 0.32 && fv < 0.8;
          if (glass) diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.13, 0.17, 0.22), 0.82);
          // A darker band at the foot.
          if (vFacade.y < 0.5) diffuseColor.rgb *= 0.7;
        }`,
    );
  };
  return material;
}
