import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import GUI from "lil-gui";
import { buildCityMeshes, DEFAULT_CITY, generateCity, TOWN_CHARACTER_KNOBS, TOWN_CHARACTERS, type CityData, type CitySettings, type TownCharacter } from "../src/index";

/**
 * URL parameters (for screenshots and sharing):
 *   ?shot           hide the panel and stats
 *   &view=top|angle|street|hero   camera preset
 *   &seed=3&character=village&width=400 ...   any CitySettings number / string field
 */
const params = new URLSearchParams(location.search);
const shot = params.has("shot");
if (shot) document.body.classList.add("shot");

// --- Renderer, scene, lights ---------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: shot });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const sky = new THREE.Color("#cfdbe6");
scene.background = sky;
scene.fog = new THREE.Fog(sky, 600, 1700);

const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 1, 5000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.48;

scene.add(new THREE.HemisphereLight("#e8f0ff", "#6b7a55", 1.1));
const sun = new THREE.DirectionalLight("#fff1dc", 2.6);
sun.position.set(-260, 420, 180);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.6;
scene.add(sun, sun.target);

// --- Settings ------------------------------------------------------------------------------
interface DemoSettings extends CitySettings {
  curvy: number;
  culdesacs: number;
  density: number;
  core: number;
  crossStreet: boolean;
}

const knobsOf = (c: TownCharacter) => TOWN_CHARACTER_KNOBS[c];
const settings: DemoSettings = {
  ...DEFAULT_CITY,
  ...knobsOf(DEFAULT_CITY.character),
  crossStreet: true,
};
for (const [key, value] of params) {
  if (!(key in settings)) continue;
  const was = (settings as unknown as Record<string, unknown>)[key];
  (settings as unknown as Record<string, unknown>)[key] = typeof was === "number" ? Number(value) : typeof was === "boolean" ? value !== "false" && value !== "0" : value;
}
if (params.has("character") && !params.has("curvy")) Object.assign(settings, knobsOf(settings.character), { crossStreet: settings.character === "city" });

// --- Build ---------------------------------------------------------------------------------
let city: CityData | null = null;
let group: THREE.Group | null = null;
const stats = document.getElementById("stats")!;

function dispose(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    mesh.geometry?.dispose();
    const m = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(m)) m.forEach((x) => x.dispose());
    else m?.dispose();
  });
}

function regenerate(): void {
  const t0 = performance.now();
  city = generateCity({ ...settings, angle: (settings.angle * Math.PI) / 180 });
  const t1 = performance.now();
  if (group) {
    scene.remove(group);
    dispose(group);
  }
  group = buildCityMeshes(city);
  scene.add(group);
  const t2 = performance.now();
  // Shadows cover the town.
  const half = Math.max(settings.width, settings.depth) * 0.75;
  const cam = sun.shadow.camera;
  cam.left = -half;
  cam.right = half;
  cam.top = half;
  cam.bottom = -half;
  cam.near = 10;
  cam.far = 1400;
  cam.updateProjectionMatrix();
  stats.textContent = `${city.layout.roads.length} streets, ${city.layout.junctions.length} junctions, ${city.blocks.length} blocks, ${city.buildings.length} buildings, ${city.trees.length} trees | generate ${(t1 - t0).toFixed(0)} ms, meshes ${(t2 - t1).toFixed(0)} ms`;
}

// --- Camera presets ------------------------------------------------------------------------
/** The streets' extent: what the presets frame. */
function extent(): { cx: number; cz: number; size: number } {
  let x0 = Infinity,
    x1 = -Infinity,
    z0 = Infinity,
    z1 = -Infinity;
  for (const laid of city?.layout.roads ?? [])
    for (const p of laid.samples) {
      x0 = Math.min(x0, p.x);
      x1 = Math.max(x1, p.x);
      z0 = Math.min(z0, p.z);
      z1 = Math.max(z1, p.z);
    }
  if (!Number.isFinite(x0)) return { cx: 0, cz: 0, size: Math.max(settings.width, settings.depth) };
  return { cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, size: Math.max(x1 - x0, z1 - z0) + 30 };
}

function view(name: string): void {
  const { cx, cz, size: s } = extent();
  controls.target.set(cx, 0, cz);
  if (name === "top") camera.position.set(cx, (s / 2 / Math.tan((camera.fov * Math.PI) / 360)) * Math.max(1, 1 / camera.aspect) * 1.02, cz + 0.001);
  else if (name === "street") {
    camera.position.set(cx + s * 0.13, 34, cz + s * 0.2);
    controls.target.set(cx - s * 0.04, 4, cz - s * 0.05);
  } else if (name === "hero") {
    camera.position.set(cx + s * 0.42, s * 0.26, cz + s * 0.5);
    controls.target.set(cx, 0, cz - s * 0.04);
  } else camera.position.set(cx + s * 0.6, s * 0.5, cz + s * 0.7);
  controls.update();
}

// --- Panel ---------------------------------------------------------------------------------
if (!shot) {
  const gui = new GUI({ title: "citygen" });
  const again = (): void => regenerate();
  gui.add(settings, "seed", 1, 9999, 1).onFinishChange(again);
  gui
    .add(
      {
        random: () => {
          settings.seed = Math.floor(Math.random() * 9999) + 1;
          gui.controllersRecursive().forEach((c) => c.updateDisplay());
          regenerate();
        },
      },
      "random",
    )
    .name("random seed");
  gui.add(settings, "character", TOWN_CHARACTERS as TownCharacter[]).onChange((c: TownCharacter) => {
    Object.assign(settings, knobsOf(c), { crossStreet: c === "city" });
    gui.controllersRecursive().forEach((ctl) => ctl.updateDisplay());
    regenerate();
  });
  const layout = gui.addFolder("Layout");
  layout.add(settings, "width", 150, 900, 10).onFinishChange(again);
  layout.add(settings, "depth", 150, 900, 10).onFinishChange(again);
  layout.add(settings, "block", 40, 120, 1).name("block size").onFinishChange(again);
  layout.add(settings, "angle", -90, 90, 1).name("main street angle").onFinishChange(again);
  layout.add(settings, "crossStreet").name("cross main street").onChange(again);
  const streets = gui.addFolder("Streets");
  streets.add(settings, "irregular", 0, 1, 0.01).onFinishChange(again);
  streets.add(settings, "curvy", 0, 1, 0.01).onFinishChange(again);
  streets.add(settings, "culdesacs", 0, 1, 0.01).name("cul-de-sacs").onFinishChange(again);
  streets.add(settings, "density", 0, 1, 0.01).onFinishChange(again);
  streets.add(settings, "core", 0, 1, 0.01).name("downtown grid").onFinishChange(again);
  const build = gui.addFolder("Buildings");
  build.add(settings, "downtown", 0, 1, 0.01).name("downtown reach").onFinishChange(again);
  build.add(settings, "lots", 0, 1, 0.01).name("street lots").onFinishChange(again);
  build.add(settings, "parks", 0, 0.6, 0.01).onFinishChange(again);
  build.add(settings, "parking", 0, 1, 0.01).name("parking lots").onFinishChange(again);
  build.add(settings, "minHeight", 3, 20, 0.5).name("min height").onFinishChange(again);
  build.add(settings, "maxHeight", 10, 200, 1).name("max height").onFinishChange(again);
  build.add(settings, "trees").onChange(again);
  streets.add(settings, "crossings").name("zebra crossings").onChange(again);
  const cam = gui.addFolder("Camera");
  for (const name of ["angle", "top", "hero", "street"]) cam.add({ [name]: () => view(name) }, name);
}

regenerate();
view(params.get("view") ?? "angle");

addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

let frames = 0;
renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
  // Signals a screenshot tool that the first frames are in.
  if (++frames === 3) document.body.dataset.ready = "1";
});
