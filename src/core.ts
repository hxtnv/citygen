/**
 * citygen/core: the generator alone, plain data out, no three.js. Use it to drive any renderer
 * (Babylon, PlayCanvas, a 2D map, an export to another engine). `citygen` re-exports all of it.
 */
export { generateCity, DEFAULT_CITY, type CitySettings, type CityData, type CityBuilding, type CityBlock } from "./core/city";
export { boxKit, type KitBuilding, type TownKit } from "./core/kit";
export { TOWN_CHARACTERS, TOWN_CHARACTER_KNOBS, type TownCharacter, type TownKnobs, type TownStreetPlan } from "./core/town-plan";
export { DISTRICTS, type District, type BlockShape } from "./core/blocks";
export type { NetworkLayout, LaidRoad, Junction } from "./core/network";
export type { TerrainData } from "./core/data";
