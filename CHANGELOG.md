# Changelog

## 0.1.1

- New `citygen/core` entry: the generator alone, plain data out, no three.js import.
- `three` is now an optional peer dependency, needed only for the mesh builders in `citygen`.

## 0.1.0 - 2026-11-25

First release.

- `generateCity(settings)`: street plan, road network with junctions, sidewalks and markings, blocks, districts, lots, buildings and trees from one seed.
- `buildCityMeshes(city)`: procedural three.js meshes for all of it, buildings as instanced boxes.
- Five town characters: `city`, `crossroads`, `hill`, `river`, `village`.
- Demo with a settings panel and camera presets.
