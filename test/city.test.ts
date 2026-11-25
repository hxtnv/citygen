import { expect, test } from "bun:test";
import { buildCityMeshes, generateCity, TOWN_CHARACTERS } from "../src/index";

test("every character makes streets, blocks and buildings", () => {
  for (const character of TOWN_CHARACTERS) {
    const city = generateCity({ seed: 3, character });
    expect(city.layout.roads.length).toBeGreaterThan(10);
    expect(city.blocks.length).toBeGreaterThan(0);
    expect(city.buildings.length).toBeGreaterThan(20);
  }
});

test("deterministic for a seed", () => {
  const a = generateCity({ seed: 42 });
  const b = generateCity({ seed: 42 });
  expect(b.buildings).toEqual(a.buildings);
  expect(generateCity({ seed: 43 }).buildings).not.toEqual(a.buildings);
});

test("no building stands on a road", () => {
  const city = generateCity({ seed: 9 });
  for (const b of city.buildings)
    for (const laid of city.layout.roads)
      for (const p of laid.samples) expect(Math.hypot(p.x - b.x, p.z - b.z)).toBeGreaterThan(laid.half);
});

test("meshes build", () => {
  const group = buildCityMeshes(generateCity({ seed: 1, character: "village" }));
  expect(group.getObjectByName("roads")!.children.length).toBeGreaterThan(2);
  expect(group.getObjectByName("buildings")!.children.length).toBe(3);
});
