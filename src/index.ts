/**
 * citygen: procedural towns and cities for three.js.
 *
 * `generateCity(settings)` plans a street network, lays it out (junctions, sidewalks, lanes,
 * markings), finds the blocks between the streets, zones them into districts and places buildings
 * on lots facing their streets. `buildCityMeshes(city)` turns that into a `THREE.Group`.
 */
export { generateCity, DEFAULT_CITY, type CitySettings, type CityData, type CityBuilding, type CityBlock } from "./core/city";
export { boxKit, type KitBuilding, type TownKit } from "./core/kit";
export { TOWN_CHARACTERS, TOWN_CHARACTER_KNOBS, type TownCharacter, type TownKnobs, type TownStreetPlan } from "./core/town-plan";
export { DISTRICTS, type District, type BlockShape } from "./core/blocks";
export type { NetworkLayout, LaidRoad, Junction } from "./core/network";
export type { TerrainData } from "./core/data";
export { buildCityMeshes, buildRoadMeshes, buildBuildingMeshes, buildTreeMeshes, buildGround, DEFAULT_PALETTE, type CityPalette, type CityMeshOptions } from "./mesh/city-meshes";
export { RoadGeometry, type RoadArrays, type RoadSlot } from "./mesh/roads-geometry";
