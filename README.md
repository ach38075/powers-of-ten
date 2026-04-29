# Universal Zoom (Powers of Ten) - Handoff Notes

Three.js final project that recreates a Powers of Ten-style top-down zoom from a picnic scene on Earth out to cosmic scales.

This README is a detailed implementation handoff so Nik can continue from the current state quickly.

## Quick Start

```bash
npm install
npm run dev
```

Production build:

```bash
npm run build
npm run preview
```

## Current Controls

- `Space` pause/resume zoom.
- `Arrow Up` increase zoom speed.
- `Arrow Down` decrease zoom speed.

## Project Structure

- `index.html`: app shell, canvas, HUD text.
- `src/style.css`: full-screen canvas and HUD styling.
- `src/main.js`: all scene, procedural generation, zoom logic, and scale transitions.

## Core Design + Procedure

The app is one persistent Three.js scene with a top-down camera. Objects are generated once per scale layer and then blended in based on zoom exponent.

### 1) Camera + Zoom Model

- Zoom state uses `exponent`, interpreted as distance `10^exponent` meters.
- Camera is fixed top-down:
  - `camera.position.set(0, distanceWorld, 0)`
  - `camera.lookAt(0,0,0)`
- `near`/`far` planes are updated dynamically each frame in `updateCamera()`.

### 2) Scale Layers

Scale layers are defined in `scaleDefinitions` with:

- `name`
- `min` / `max` exponent
- `blend` (fade width)
- `factory` function

Current layers:

- Picnic Blanket
- Park and Trees
- Neighborhood
- Cityscape
- Earth
- Near Space
- Solar System
- Milky Way
- Cosmic Web

### 3) Scene Initialization

- `initializeScales()` creates each layer once and stores it in `scaleObjects`.
- `updateRanges()` computes alpha using `smoothStep()` and applies material opacity via `setObjectOpacity()`.
- This means no hard scene replacement, only progressive reveal in one scene graph.

### 4) Procedural Earth/City/Neighborhood

Key Earth-side helpers in `src/main.js`:

- `randomPointInRing()` for radial sampling.
- `clampToEarth()` to keep placements inside Earth disk bounds.
- `isLandAt()` and `projectToLand()` to place buildings/trees on land.
- `addNeighborhoodCluster()` builds multi-block neighborhoods with non-overlapping house placement attempts.

Earth visual strategy currently:

- Large blue Earth base disk.
- Overlapping land blobs (green).
- Trees/forest patches and hills.
- City/neighborhood clusters constrained to land zones.

### 5) Space/Solar Design (Current)

- Near Space currently includes:
  - planar star points (for earlier star visibility),
  - inner planets,
  - outer planets,
  - sun.
- Planet debug colors currently map to requested ROYGBIV scheme:
  - Mercury red, Venus orange, Earth blue, Mars yellow, Jupiter green, Saturn blue, Uranus purple, Neptune pink.
- Planet radii are scaled from real km radii using one conversion:
  - `kmToWorld = EARTH_RADIUS / 6371`.

## What Has Been Done So Far

- Built full Vite + Three.js project from scratch.
- Implemented continuous logarithmic zoom with keyboard control.
- Added staged Earth-to-cosmos content generation and blending.
- Added picnic origin scene (now checkered red/white blanket).
- Added park/neighborhood/city procedural content layers.
- Reworked multiple times to remove hard swaps and keep single-scene continuity.
- Added planetary scale mode with size ratios tied to Earth radius.
- Added debug coloring for easy planet identification.
- Added stars and tuned multiple times for earlier visibility.
- Repeatedly tuned camera/spacing/opacity for overlap and visibility issues.

## Known Issues / Next Work (Priority)

### Must Fix Next

1) Fix Earth design artifacts:

- Grass/water still looks glitchy/noisy at some zooms.
- Land mass shapes need cleaner, less "blobby" generation.
- Improve street design so it reads as coherent road networks.

2) Fix star visibility behavior:

- Stars still need cleaner "visible as soon as space begins" behavior.
- Prevent noisy over-dense star patches around planet cluster.

3) Expand beyond current solar staging:

- Improve transition from near-space to larger astronomical scales.
- Add clearer orbital context and layout readability.

4) Fix sun rendering/placement polish:

- Sun still sometimes feels visually intrusive or awkward in frame.
- Need final camera-space composition that never blocks key planets.

5) Add reverse zoom:

- Implement controlled zoom back in (toggle direction or keybind).
- Ensure layer transitions work both outward and inward.

### Nice-to-Have

- Optional planet labels for debugging (toggleable).
- Better art direction for Earth textures/coastlines.
- Performance pass for high object counts.

## Suggested Next Implementation Order

1. Stabilize Earth rendering first (reduce coplanar geometry + cleaner land/water generation).
2. Refactor stars into one consistent strategy (planar + distant blend rules).
3. Lock solar composition (sun/planet spacing) with no overlap.
4. Add reverse zoom flow and test transitions in both directions.
5. Then polish visuals and presentation HUD.

## Notes for Nik

- Most iteration complexity is in `src/main.js`.
- The fastest way to tune feel is adjusting:
  - `scaleDefinitions` thresholds/blends,
  - positions inside `createPlanetaryScale()` and `createSolarScale()`,
  - geometry density in `createEarthScale()`.
- If visuals break, first check for:
  - coplanar meshes causing z-fighting,
  - too many transparent overlapping materials,
  - objects placed outside intended land/earth bounds.
