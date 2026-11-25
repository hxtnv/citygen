/**
 * citygen: procedural towns and cities for three.js.
 *
 * `generateCity(settings)` plans a street network, lays it out (junctions, sidewalks, lanes,
 * markings), finds the blocks between the streets, zones them into districts and places buildings
 * on lots facing their streets. `buildCityMeshes(city)` turns that into a `THREE.Group`.
 */
export * from "./core";
export { buildCityMeshes, buildRoadMeshes, buildBuildingMeshes, buildTreeMeshes, buildGround, DEFAULT_PALETTE, type CityPalette, type CityMeshOptions } from "./mesh/city-meshes";
export { RoadGeometry, type RoadArrays, type RoadSlot } from "./mesh/roads-geometry";
