import * as THREE from "three";
import "./style.css";

// ============================================================================
// Renderer + DOM setup
// ============================================================================

const canvas = document.querySelector("#app");
const scaleLabel = document.querySelector("#scale-label");
const statusLabel = document.querySelector("#status");

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  // Allows sane depth precision when near~10^-4 and far~10^23+ in the same frame.
  logarithmicDepthBuffer: true,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
const maxAniso = renderer.capabilities.getMaxAnisotropy();

const scene = new THREE.Scene();
scene.fog = null;

// Initial planes; updateCamera assigns values that always bound the full scene.
const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  1e-4,
  1e24,
);

const ambient = new THREE.AmbientLight(0x6f84aa, 0.48);
scene.add(ambient);

const sunLight = new THREE.DirectionalLight(0xffffff, 1.35);
sunLight.position.set(600, 400, 300);
scene.add(sunLight);

// ============================================================================
// Constants + state
// ============================================================================

// Direct reference for animated scene content; populated in setupScene().
let cloudDisk = null;
/** Populated by createSunWithGlowGroup — limb shader time uniform */
let sunGlowTimeUniform = null;

const metersPerWorldUnit = 1;
const EARTH_RADIUS = 6700;

// Furthest scene content (Cosmic Web, galaxy, Oort) sits within ~this distance of
// the origin. Camera looks at origin from +Y; without (distanceWorld + margin) in
// `far`, bodies like the Kuiper belt pop in only once 5*distanceWorld exceeds their
// depth — the "choppy layer" effect.
const SCENE_RADIUS =
  90_000_000_000;

// Shared between createCityScale (towers) and the Earth texture (city lights)
// so the warm dots visible from space line up with where towers appear up close.
const CITY_CENTERS = [
  { x: -1700, z: 1300 },
  { x: 2200, z: -900 },
  { x: -500, z: -2300 },
  { x: 1800, z: 2000 },
];

// CONTINENTS is the source of truth for land. The Earth texture renders shorelines
// from these via noise; LAND_REGIONS is the bounding-circle fallback used by simpler
// placement helpers (isLandAt / projectToLand) to keep house and city placement cheap.
const CONTINENTS = [
  { x: 200, z: -100, r: 1700, seed: 5.5, biomeBias: 0.3 },
  { x: -1800, z: -900, r: 1900, seed: 11.7, biomeBias: 0.4 },
  { x: 1400, z: -1100, r: 1600, seed: 27.3, biomeBias: 0.55 },
  { x: -500, z: 1800, r: 1500, seed: 41.9, biomeBias: 0.45 },
  { x: 2200, z: 1500, r: 1200, seed: 58.6, biomeBias: 0.65 },
  { x: -2600, z: 1500, r: 1100, seed: 73.2, biomeBias: 0.5 },
  { x: 3200, z: -900, r: 1000, seed: 89.4, biomeBias: 0.7 },
  { x: -3300, z: -1400, r: 900, seed: 102.8, biomeBias: 0.55 },
  { x: 2700, z: 2700, r: 850, seed: 118.1, biomeBias: 0.6 },
  { x: -800, z: -3100, r: 950, seed: 131.5, biomeBias: 0.45 },
];
const LAND_REGIONS = CONTINENTS.map(({ x, z, r }) => ({ x, z, r }));

const minExponent = -1.7;
const maxExponent = 23;

/** Initial zoom when the page loads (tight on the blanket). */
const DEFAULT_EXPONENT = -1.2;
/**
 * Tour return altitude: ~10^0.3 m ≈ 2 m camera height so the full picnic
 * blanket fits in a 60° vertical FOV; DEFAULT_EXPONENT is too close for that.
 */
const TOUR_RETURN_EXPONENT = 0.3;
/** Overview landmark (~10^10.65 m). */
const OVERVIEW_EXPONENT = 10.65;
const OVERVIEW_TOUR_OUT_SECONDS = 14;
const OVERVIEW_TOUR_IN_SECONDS = 12;

let exponent = DEFAULT_EXPONENT;
let speed = 0.18;
let direction = 1;
let paused = false;

/**
 * @type {{
 *   phase: "out" | "in";
 *   elapsed: number;
 *   duration: number;
 *   from: number;
 *   to: number;
 * } | null}
 */
let overviewTour = null;

// ============================================================================
// Inline 2D value noise (zero deps)
// ============================================================================

function hash2(ix, iy) {
  const h = Math.sin(ix * 127.1 + iy * 311.7) * 43758.5453;
  return h - Math.floor(h);
}

function smoothT(t) {
  return t * t * (3 - 2 * t);
}

function valueNoise2D(x, y) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const a = hash2(ix, iy);
  const b = hash2(ix + 1, iy);
  const c = hash2(ix, iy + 1);
  const d = hash2(ix + 1, iy + 1);
  const u = smoothT(fx);
  const v = smoothT(fy);
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
}

function fbm2D(x, y, octaves = 4) {
  let amp = 0.5;
  let freq = 1;
  let sum = 0;
  for (let i = 0; i < octaves; i += 1) {
    sum += amp * valueNoise2D(x * freq, y * freq);
    amp *= 0.5;
    freq *= 2;
  }
  return sum;
}

// ============================================================================
// Sprite + procedural texture helpers
// ============================================================================

/** Wider, softer falloff for star points — reads as glow with additive blending. */
function createStarGlowSpriteTexture(size = 128) {
  const spriteCanvas = document.createElement("canvas");
  spriteCanvas.width = size;
  spriteCanvas.height = size;
  const ctx = spriteCanvas.getContext("2d");
  if (!ctx) {
    return null;
  }
  const center = size / 2;
  const radius = size * 0.49;
  const grad = ctx.createRadialGradient(
    center,
    center,
    0,
    center,
    center,
    radius,
  );
  grad.addColorStop(0.0, "rgba(255,255,255,1)");
  grad.addColorStop(0.12, "rgba(255,252,248,0.92)");
  grad.addColorStop(0.35, "rgba(255,238,220,0.45)");
  grad.addColorStop(0.62, "rgba(255,210,170,0.16)");
  grad.addColorStop(1.0, "rgba(255,190,150,0)");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(center, center, radius, 0, Math.PI * 2);
  ctx.fill();
  const tex = new THREE.CanvasTexture(spriteCanvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function createEarthTexture(size = 1536) {
  const earthCanvas = document.createElement("canvas");
  earthCanvas.width = size;
  earthCanvas.height = size;
  const ctx = earthCanvas.getContext("2d");

  const worldToPx = (w) => ((w / EARTH_RADIUS + 1) / 2) * size;
  const lengthToPx = (l) => (l / EARTH_RADIUS) * (size / 2);

  // Ocean radial base.
  const oceanGrad = ctx.createRadialGradient(
    size / 2,
    size / 2,
    0,
    size / 2,
    size / 2,
    size * 0.5,
  );
  oceanGrad.addColorStop(0.0, "#143a6b");
  oceanGrad.addColorStop(0.6, "#0d2c52");
  oceanGrad.addColorStop(1.0, "#08213e");
  ctx.fillStyle = oceanGrad;
  ctx.fillRect(0, 0, size, size);

  // Per-continent shoreline polygon + biome detail + coastline + lakes.
  for (const continent of CONTINENTS) {
    const POINTS = 128;
    const polygon = new Path2D();
    for (let i = 0; i < POINTS; i += 1) {
      const angle = (i / POINTS) * Math.PI * 2;
      const cosA = Math.cos(angle);
      const sinA = Math.sin(angle);
      const noise = fbm2D(
        cosA * 1.6 + continent.seed,
        sinA * 1.6 + continent.seed,
        4,
      );
      const radius = continent.r * (0.78 + 0.34 * noise);
      const xPx = worldToPx(continent.x + cosA * radius);
      const yPx = worldToPx(continent.z + sinA * radius);
      if (i === 0) {
        polygon.moveTo(xPx, yPx);
      } else {
        polygon.lineTo(xPx, yPx);
      }
    }
    polygon.closePath();

    ctx.fillStyle = "#2c6c3b";
    ctx.fill(polygon);

    // Biome detail: per-pixel sampling within the continent bounding box, clipped
    // to the polygon. Bounding box keeps cost proportional to actual land area.
    ctx.save();
    ctx.clip(polygon);
    const bboxR = continent.r * 1.15;
    const x0 = Math.max(0, Math.floor(worldToPx(continent.x - bboxR)));
    const y0 = Math.max(0, Math.floor(worldToPx(continent.z - bboxR)));
    const x1 = Math.min(size, Math.ceil(worldToPx(continent.x + bboxR)));
    const y1 = Math.min(size, Math.ceil(worldToPx(continent.z + bboxR)));
    const w = x1 - x0;
    const h = y1 - y0;
    if (w > 0 && h > 0) {
      const img = ctx.getImageData(x0, y0, w, h);
      const data = img.data;
      for (let py = 0; py < h; py += 1) {
        for (let px = 0; px < w; px += 1) {
          const idx = (py * w + px) * 4;
          if (data[idx + 3] === 0) {
            continue;
          }
          const wx = (((x0 + px) / size) * 2 - 1) * EARTH_RADIUS;
          const wy = (((y0 + py) / size) * 2 - 1) * EARTH_RADIUS;
          const elev = fbm2D(
            wx * 0.0009 + continent.seed,
            wy * 0.0009 - continent.seed,
            4,
          );
          const biome = elev + continent.biomeBias * 0.18;

          let r = 44;
          let g = 108;
          let b = 59;
          if (biome > 0.66) {
            r = 110;
            g = 98;
            b = 86;
          } else if (biome > 0.55) {
            r = 200;
            g = 167;
            b = 106;
          } else if (biome > 0.42) {
            r = 111;
            g = 156;
            b = 74;
          }

          const lat = Math.abs(wy) / EARTH_RADIUS;
          if (lat > 0.78) {
            const t = Math.min(1, (lat - 0.78) / 0.22);
            r = Math.round(r * (1 - t) + 232 * t);
            g = Math.round(g * (1 - t) + 240 * t);
            b = Math.round(b * (1 - t) + 246 * t);
          }

          data[idx] = r;
          data[idx + 1] = g;
          data[idx + 2] = b;
        }
      }
      ctx.putImageData(img, x0, y0);
    }
    ctx.restore();

    ctx.strokeStyle = "rgba(15, 35, 55, 0.55)";
    ctx.lineWidth = 2;
    ctx.stroke(polygon);

    if (continent.r >= 1300) {
      const lakeCount = 1 + Math.floor((continent.r - 1300) / 400);
      for (let li = 0; li < lakeCount; li += 1) {
        const lx =
          continent.x +
          (fbm2D(continent.seed + li * 7.7, li * 3.1) - 0.5) *
            continent.r *
            0.6;
        const ly =
          continent.z +
          (fbm2D(continent.seed + li * 5.3, li * 9.1 + 13) - 0.5) *
            continent.r *
            0.6;
        const lr = 60 + fbm2D(continent.seed + li, li * 2.4) * 110;
        ctx.beginPath();
        ctx.arc(worldToPx(lx), worldToPx(ly), lengthToPx(lr), 0, Math.PI * 2);
        ctx.fillStyle = "#0d2c52";
        ctx.fill();
      }
    }
  }

  // City lights (warm dots visible from space).
  for (const cc of CITY_CENTERS) {
    const cxPx = worldToPx(cc.x);
    const cyPx = worldToPx(cc.z);
    const grad = ctx.createRadialGradient(cxPx, cyPx, 0, cxPx, cyPx, 28);
    grad.addColorStop(0.0, "rgba(255,212,138,0.95)");
    grad.addColorStop(0.55, "rgba(255,180,90,0.4)");
    grad.addColorStop(1.0, "rgba(255,180,90,0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cxPx, cyPx, 28, 0, Math.PI * 2);
    ctx.fill();
  }

  const tex = new THREE.CanvasTexture(earthCanvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAniso;
  return tex;
}

function createCloudTexture(size = 512) {
  const cloudCanvas = document.createElement("canvas");
  cloudCanvas.width = size;
  cloudCanvas.height = size;
  const ctx = cloudCanvas.getContext("2d");
  const img = ctx.createImageData(size, size);
  const data = img.data;
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      const idx = (py * size + px) * 4;
      const dx = px - size / 2;
      const dy = py - size / 2;
      const r = Math.hypot(dx, dy) / (size / 2);
      if (r > 0.99) {
        data[idx + 3] = 0;
        continue;
      }
      const wx = (px / size) * 8;
      const wy = (py / size) * 8;
      const n = fbm2D(wx, wy, 4);
      const a = Math.max(0, n - 0.55) * 280;
      data[idx] = 245;
      data[idx + 1] = 248;
      data[idx + 2] = 252;
      data[idx + 3] = Math.min(220, a) * (1 - r * 0.3);
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cloudCanvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function createCloudLayer() {
  const wrapper = new THREE.Group();
  wrapper.name = "earth-clouds";
  wrapper.rotation.x = -Math.PI / 2;
  wrapper.position.y = 0.5;

  const disk = new THREE.Mesh(
    new THREE.CircleGeometry(EARTH_RADIUS * 0.999, 128),
    new THREE.MeshBasicMaterial({
      map: createCloudTexture(),
      transparent: true,
      depthWrite: false,
      opacity: 0.7,
    }),
  );
  disk.name = "earth-clouds-disk";
  wrapper.add(disk);
  return wrapper;
}

function createAtmosphereRing() {
  const group = new THREE.Group();
  group.name = "earth-atmosphere";
  // Stacked rings of decreasing opacity approximate a soft fade outward without
  // requiring a custom shader or a baked ring texture with awkward UV mapping.
  const layers = [
    { inner: 1.0, outer: 1.012, opacity: 0.55 },
    { inner: 1.012, outer: 1.025, opacity: 0.32 },
    { inner: 1.025, outer: 1.045, opacity: 0.18 },
    { inner: 1.045, outer: 1.07, opacity: 0.08 },
  ];
  for (const layer of layers) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(
        EARTH_RADIUS * layer.inner,
        EARTH_RADIUS * layer.outer,
        96,
      ),
      new THREE.MeshBasicMaterial({
        color: 0x8cc8ff,
        transparent: true,
        opacity: layer.opacity,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.3;
    group.add(ring);
  }
  return group;
}

// ============================================================================
// Picnic-scale primitives + placement helpers
// ============================================================================

function makeTree(x, z, trunkHeight = 8, crownRadius = 3.2) {
  const group = new THREE.Group();
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.6, 0.8, trunkHeight, 8),
    new THREE.MeshLambertMaterial({ color: 0x5b3b2b }),
  );
  const crown = new THREE.Mesh(
    new THREE.SphereGeometry(crownRadius, 12, 10),
    new THREE.MeshLambertMaterial({ color: 0x315b2d }),
  );
  trunk.position.y = trunkHeight / 2;
  crown.position.y = trunkHeight + crownRadius * 0.65;
  group.position.set(x, 0, z);
  group.add(trunk);
  group.add(crown);
  return group;
}

function makeBush(x, z, scale = 1) {
  const bush = new THREE.Mesh(
    new THREE.SphereGeometry(1.25 * scale, 10, 8),
    new THREE.MeshLambertMaterial({ color: 0x2f5a2e }),
  );
  bush.position.set(x, 1 * scale, z);
  return bush;
}

function createLyingPerson(options = {}) {
  const person = new THREE.Group();
  const skin = options.skin ?? 0xe6b48c;
  const shirt = options.shirt ?? 0x5678c9;
  const pants = options.pants ?? 0x2f3e62;

  const head = new THREE.Mesh(
    new THREE.SphereGeometry(0.11, 12, 10),
    new THREE.MeshStandardMaterial({ color: skin, roughness: 0.85 }),
  );
  head.position.set(-0.45, 0.155, 0);
  person.add(head);

  // Single tapered body: narrower near neck, wider toward hips.
  const torso = new THREE.Mesh(
    new THREE.CylinderGeometry(0.06, 0.17, 0.5, 12),
    new THREE.MeshStandardMaterial({ color: shirt, roughness: 0.9 }),
  );
  torso.rotation.z = Math.PI / 2;
  torso.position.set(-0.12, 0.11, 0);
  person.add(torso);

  const leftLeg = new THREE.Mesh(
    new THREE.BoxGeometry(0.45, 0.1, 0.12),
    new THREE.MeshStandardMaterial({ color: pants, roughness: 0.92 }),
  );
  leftLeg.position.set(0.34, 0.08, -0.08);
  person.add(leftLeg);

  const rightLeg = new THREE.Mesh(
    new THREE.BoxGeometry(0.45, 0.1, 0.12),
    new THREE.MeshStandardMaterial({ color: pants, roughness: 0.92 }),
  );
  rightLeg.position.set(0.34, 0.08, 0.08);
  person.add(rightLeg);

  return person;
}

function randomPointInRing(innerR, outerR) {
  const t = Math.random();
  const radius = Math.sqrt(
    innerR * innerR + t * (outerR * outerR - innerR * innerR),
  );
  const angle = Math.random() * Math.PI * 2;
  return { x: Math.cos(angle) * radius, z: Math.sin(angle) * radius };
}

function clampToEarth(x, z, margin = 0) {
  const limit = EARTH_RADIUS - margin;
  const length = Math.hypot(x, z);
  if (length <= limit || length === 0) {
    return { x, z };
  }
  const s = limit / length;
  return { x: x * s, z: z * s };
}

function isLandAt(x, z) {
  return LAND_REGIONS.some(
    (land) => (x - land.x) ** 2 + (z - land.z) ** 2 < land.r ** 2,
  );
}

function projectToLand(x, z) {
  if (isLandAt(x, z)) {
    return { x, z };
  }
  let best = null;
  for (const land of LAND_REGIONS) {
    const dx = x - land.x;
    const dz = z - land.z;
    const dist = Math.hypot(dx, dz) || 1;
    const px = land.x + (dx / dist) * land.r * 0.65;
    const pz = land.z + (dz / dist) * land.r * 0.65;
    const delta = (x - px) ** 2 + (z - pz) ** 2;
    if (!best || delta < best.delta) {
      best = { x: px, z: pz, delta };
    }
  }
  return best ? { x: best.x, z: best.z } : { x, z };
}

// ============================================================================
// Neighborhood (instanced houses)
// ============================================================================

function addNeighborhoodCluster(group, centerX, centerZ, options = {}) {
  const anchored = projectToLand(centerX, centerZ);
  centerX = anchored.x;
  centerZ = anchored.z;
  const roads = options.roads ?? 4;
  const span = options.span ?? 680;
  const spacing = span / roads;
  const roadMaterial = new THREE.MeshLambertMaterial({ color: 0x2f2f34 });

  for (let i = -roads + 1; i <= roads - 1; i += 1) {
    const roadA = new THREE.Mesh(
      new THREE.PlaneGeometry(span * 2, 34),
      roadMaterial,
    );
    roadA.rotation.x = -Math.PI / 2;
    roadA.position.set(centerX, 0.012, centerZ + i * spacing);
    group.add(roadA);

    const roadB = new THREE.Mesh(
      new THREE.PlaneGeometry(34, span * 2),
      roadMaterial,
    );
    roadB.rotation.x = -Math.PI / 2;
    roadB.position.set(centerX + i * spacing, 0.012, centerZ);
    group.add(roadB);
  }

  // First pass collects house specs; second pass batches into a single
  // InstancedMesh so the cluster costs one draw call instead of dozens.
  const occupied = [];
  const houseSpecs = [];
  for (let bx = -roads; bx < roads; bx += 1) {
    for (let bz = -roads; bz < roads; bz += 1) {
      const blockCenterX = centerX + (bx + 0.5) * spacing;
      const blockCenterZ = centerZ + (bz + 0.5) * spacing;
      const houseCount = 3 + Math.floor(Math.random() * 3);
      for (let h = 0; h < houseCount; h += 1) {
        let housePos = null;
        for (let attempt = 0; attempt < 14; attempt += 1) {
          const candidate = {
            x: blockCenterX + (Math.random() - 0.5) * (spacing * 0.55),
            z: blockCenterZ + (Math.random() - 0.5) * (spacing * 0.55),
          };
          const tooClose = occupied.some(
            (p) =>
              (candidate.x - p.x) ** 2 + (candidate.z - p.z) ** 2 < 34 ** 2,
          );
          if (!tooClose) {
            housePos = candidate;
            break;
          }
        }
        if (!housePos) {
          continue;
        }
        if (!isLandAt(housePos.x, housePos.z)) {
          continue;
        }
        houseSpecs.push({
          x: housePos.x,
          z: housePos.z,
          w: 18 + Math.random() * 14,
          h: 12 + Math.random() * 20,
          d: 16 + Math.random() * 12,
          rotY: (Math.random() - 0.5) * 1.0,
          color: new THREE.Color().setHSL(
            0.03 + Math.random() * 0.08,
            0.45,
            0.52 + Math.random() * 0.18,
          ),
        });
        occupied.push(housePos);
      }
    }
  }

  if (houseSpecs.length > 0) {
    const houses = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshLambertMaterial(),
      houseSpecs.length,
    );
    const dummy = new THREE.Object3D();
    for (let i = 0; i < houseSpecs.length; i += 1) {
      const s = houseSpecs[i];
      dummy.position.set(s.x, s.h / 2, s.z);
      dummy.rotation.set(0, s.rotY, 0);
      dummy.scale.set(s.w, s.h, s.d);
      dummy.updateMatrix();
      houses.setMatrixAt(i, dummy.matrix);
      houses.setColorAt(i, s.color);
    }
    houses.instanceMatrix.needsUpdate = true;
    if (houses.instanceColor) {
      houses.instanceColor.needsUpdate = true;
    }
    group.add(houses);
  }

  for (const s of houseSpecs) {
    if (Math.random() < 0.65) {
      const treeSpot = clampToEarth(
        s.x + 12 + (Math.random() - 0.5) * 10,
        s.z + 12 + (Math.random() - 0.5) * 10,
        40,
      );
      if (isLandAt(treeSpot.x, treeSpot.z)) {
        group.add(
          makeTree(
            treeSpot.x,
            treeSpot.z,
            5 + Math.random() * 4,
            2 + Math.random(),
          ),
        );
      }
    }
  }
}

// ============================================================================
// Scale factories
// ============================================================================

function createPicnicScale() {
  const group = new THREE.Group();

  const blanket = new THREE.Mesh(
    new THREE.BoxGeometry(2.2, 0.06, 1.4),
    new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.9 }),
  );
  blanket.position.set(0, 0.02, 0);
  group.add(blanket);

  const tileSize = 0.22;
  for (let ix = -4; ix <= 4; ix += 1) {
    for (let iz = -2; iz <= 2; iz += 1) {
      const isRed = (ix + iz) % 2 === 0;
      const tile = new THREE.Mesh(
        new THREE.BoxGeometry(tileSize, 0.012, tileSize),
        new THREE.MeshStandardMaterial({
          color: isRed ? 0xba1e1e : 0xf4f4f4,
          roughness: 0.88,
        }),
      );
      tile.position.set(ix * tileSize, 0.062, iz * tileSize);
      group.add(tile);
    }
  }

  const personA = createLyingPerson({
    skin: 0xe8bd99,
    shirt: 0xff46a2,
    pants: 0x420453,
  });
  personA.position.set(-0.34, 0.02, 0.06);
  personA.rotation.y = -Math.PI / 2;
  group.add(personA);

  const personB = createLyingPerson({
    skin: 0xc99774,
    shirt: 0xd07b4d,
    pants: 0x4a2f26,
  });
  personB.position.set(0.34, 0.02, -0.06);
  personB.rotation.y = -Math.PI / 2;
  group.add(personB);

  const basketGroup = new THREE.Group();
  basketGroup.position.set(0.02, 0.1, -0.1);
  basketGroup.rotation.y = 0.35;

  const picnicBasket = new THREE.Mesh(
    new THREE.BoxGeometry(0.22, 0.14, 0.16),
    new THREE.MeshStandardMaterial({ color: 0x8b5a2b, roughness: 0.92 }),
  );
  basketGroup.add(picnicBasket);

  const basketHandle = new THREE.Mesh(
    new THREE.TorusGeometry(0.05, 0.008, 10, 24, Math.PI),
    new THREE.MeshStandardMaterial({ color: 0x6e4522, roughness: 0.9 }),
  );
  basketHandle.rotation.y = Math.PI / 2;
  basketHandle.rotation.z = 0.2;
  basketHandle.position.set(0, 0.085, 0);
  basketGroup.add(basketHandle);

  group.add(basketGroup);

  return group;
}

function createParkScale() {
  const group = new THREE.Group();

  // Keep the center open for the picnic and reveal trees around it.
  for (let i = 0; i < 90; i += 1) {
    const { x, z } = randomPointInRing(45, 360);
    group.add(makeTree(x, z, 7 + Math.random() * 4, 2.4 + Math.random() * 1.4));
  }

  for (let i = 0; i < 180; i += 1) {
    const { x, z } = randomPointInRing(20, 420);
    group.add(makeBush(x, z, 0.5 + Math.random() * 0.4));
  }

  return group;
}

function createNeighborhoodScale() {
  const group = new THREE.Group();
  addNeighborhoodCluster(group, 560, 420, { roads: 3, span: 420 });
  return group;
}

function createCityScale() {
  const group = new THREE.Group();

  const totalTowers = CITY_CENTERS.length * 16;
  const towers = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshLambertMaterial(),
    totalTowers,
  );
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  let towerIdx = 0;
  for (const center of CITY_CENTERS) {
    for (let i = 0; i < 16; i += 1) {
      const w = 65 + Math.random() * 70;
      const h = 200 + Math.random() * 700;
      const d = 65 + Math.random() * 70;
      const angle = (i / 16) * Math.PI * 2 + (Math.random() - 0.5) * 0.25;
      const radius = 260 + Math.random() * 620;
      const projected = clampToEarth(
        center.x + Math.cos(angle) * radius,
        center.z + Math.sin(angle) * radius,
        420,
      );
      dummy.position.set(projected.x, h / 2, projected.z);
      dummy.rotation.set(0, 0, 0);
      dummy.scale.set(w, h, d);
      dummy.updateMatrix();
      towers.setMatrixAt(towerIdx, dummy.matrix);
      color.setHSL(0.58, 0.05, 0.36 + Math.random() * 0.22);
      towers.setColorAt(towerIdx, color);
      towerIdx += 1;
    }
  }
  towers.instanceMatrix.needsUpdate = true;
  if (towers.instanceColor) {
    towers.instanceColor.needsUpdate = true;
  }
  group.add(towers);

  // Outskirt neighborhoods so cities feel embedded in suburbs at larger zooms.
  addNeighborhoodCluster(group, -2200, -300, { roads: 3, span: 420 });
  addNeighborhoodCluster(group, 2100, 1700, { roads: 2, span: 360 });
  addNeighborhoodCluster(group, -500, 2400, { roads: 2, span: 340 });

  return group;
}

function createEarthScale() {
  const group = new THREE.Group();

  const earth = new THREE.Mesh(
    new THREE.CircleGeometry(EARTH_RADIUS, 256),
    new THREE.MeshLambertMaterial({
      map: createEarthTexture(),
    }),
  );
  earth.rotation.x = -Math.PI / 2;
  earth.position.y = -0.14;
  earth.name = "earth-surface";
  group.add(earth);

  group.add(createCloudLayer());
  group.add(createAtmosphereRing());

  return group;
}

function createSunWithGlowGroup(sunRadiusWorld, x, z) {
  const g = new THREE.Group();
  g.name = "sun-scale-root";
  g.position.set(x, 0, z);

  // Single disk with limb-only opacity in the fragment shader — no oversized
  // corona geometry, so log-depth quirks cannot tint distant scene fill.
  const glowExtent = 1.045;
  const glowGeom = new THREE.CircleGeometry(sunRadiusWorld * glowExtent, 96);
  const glowUniforms = {
    uTime: { value: 0 },
    uCoreR: { value: sunRadiusWorld },
    uOuterNorm: { value: glowExtent },
    uColor: { value: new THREE.Color(0xff9a44) },
  };
  const glowMat = new THREE.ShaderMaterial({
    uniforms: glowUniforms,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.NormalBlending,
    side: THREE.DoubleSide,
    renderOrder: -40,
    vertexShader: `
      uniform float uCoreR;
      varying float vNormR;
      void main() {
        vNormR = length(position.xy) / uCoreR;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform float uTime;
      uniform float uOuterNorm;
      uniform vec3 uColor;
      varying float vNormR;
      void main() {
        float pulse = 0.82 + 0.18 * sin(uTime * 1.6);
        float breathe = 0.012 * sin(uTime * 0.85 + 0.7);
        float inner = 0.962 + breathe;
        float mid = 0.992 + breathe * 0.4;
        float outer = uOuterNorm + breathe * 0.6;
        float a = smoothstep(inner, mid, vNormR) * (1.0 - smoothstep(mid + 0.012, outer, vNormR));
        a *= 0.52 * pulse;
        if (a < 0.008) discard;
        gl_FragColor = vec4(uColor, a);
      }
    `,
  });

  const glow = new THREE.Mesh(glowGeom, glowMat);
  glow.rotation.x = -Math.PI / 2;
  g.add(glow);

  sunGlowTimeUniform = glowUniforms.uTime;

  const core = new THREE.Mesh(
    new THREE.CircleGeometry(sunRadiusWorld, 80),
    new THREE.MeshBasicMaterial({
      color: 0xfffef5,
      depthTest: true,
      depthWrite: true,
      renderOrder: -39,
    }),
  );
  core.rotation.x = -Math.PI / 2;
  g.add(core);

  return g;
}

function planetMaterial(hex) {
  return new THREE.MeshStandardMaterial({
    color: hex,
    emissive: hex,
    emissiveIntensity: 0.22,
    roughness: 0.91,
    metalness: 0.03,
  });
}

function createPlanetaryScale() {
  const group = new THREE.Group();
  const kmToWorld = EARTH_RADIUS / 6_371;
  const anchorZ = 0;
  const sunCenter = new THREE.Vector2(-780_000, anchorZ - 80_000);

  // Realistic palette: Mercury gray, Venus cream clouds, Mars iron oxide rust,
  // Jupiter ammonia bands (sandy), Saturn pale ammonia ice, Uranus methane cyan,
  // Neptune deep methane blue.
  const innerPlanets = [
    {
      radiusKm: 2_440,
      color: 0xb0aca4,
      x: -38_000,
      z: anchorZ - 1_500,
      orbitAngle: 2.55,
    },
    {
      radiusKm: 6_052,
      color: 0xd4c28a,
      x: -24_000,
      z: anchorZ + 900,
      orbitAngle: 2.0,
    },
    {
      radiusKm: 3_390,
      color: 0xb5553c,
      x: 24_000,
      z: anchorZ - 1100,
      orbitAngle: 0.65,
    },
  ];
  for (const planet of innerPlanets) {
    const radiusFromSun = Math.hypot(
      planet.x - sunCenter.x,
      planet.z - sunCenter.y,
    );
    const x = sunCenter.x + Math.cos(planet.orbitAngle) * radiusFromSun;
    const z = sunCenter.y + Math.sin(planet.orbitAngle) * radiusFromSun;
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(planet.radiusKm * kmToWorld, 26, 16),
      planetMaterial(planet.color),
    );
    mesh.position.set(x, 0, z);
    group.add(mesh);
  }

  const outerPlanets = [
    {
      radiusKm: 69_911,
      color: 0xc0a075,
      x: 140_000,
      z: anchorZ + 6_000,
      orbitAngle: 1.1,
    },
    {
      radiusKm: 58_232,
      color: 0xd8c9a0,
      x: 400_000,
      z: anchorZ - 6_000,
      orbitAngle: 0.38,
    },
    {
      radiusKm: 25_362,
      color: 0x62c9db,
      x: 620_000,
      z: anchorZ + 5_000,
      orbitAngle: -0.55,
    },
    {
      radiusKm: 24_622,
      color: 0x2a52c4,
      x: 730_000,
      z: anchorZ - 7_000,
      orbitAngle: -1.12,
    },
  ];
  for (const planet of outerPlanets) {
    const radiusFromSun = Math.hypot(
      planet.x - sunCenter.x,
      planet.z - sunCenter.y,
    );
    const x = sunCenter.x + Math.cos(planet.orbitAngle) * radiusFromSun;
    const z = sunCenter.y + Math.sin(planet.orbitAngle) * radiusFromSun;
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(planet.radiusKm * kmToWorld, 28, 18),
      planetMaterial(planet.color),
    );
    mesh.position.set(x, 0, z);
    group.add(mesh);

    if (planet.radiusKm === 58_232) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(
          planet.radiusKm * kmToWorld * 1.25,
          planet.radiusKm * kmToWorld * 1.9,
          64,
        ),
        new THREE.MeshStandardMaterial({
          color: 0xc8bfa2,
          emissive: 0x6a5e48,
          emissiveIntensity: 0.12,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0.82,
          roughness: 0.95,
          metalness: 0,
        }),
      );
      ring.rotation.set(-Math.PI / 2 + 0.26, 0.0, 0.36);
      ring.position.copy(mesh.position);
      group.add(ring);
    }
  }

  const sunRadiusWorld = 696_700 * kmToWorld;
  group.add(
    createSunWithGlowGroup(sunRadiusWorld, -780_000, anchorZ - 80_000),
  );

  return group;
}

function createKuiperBeltScale() {
  const group = new THREE.Group();
  const center = new THREE.Vector3(-780_000, -1_200_000, 0);
  const count = 32000;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const rockPalette = [0xc8c8c8, 0xb8bcc2, 0xd6d6d6, 0xaeb3b9];
  for (let i = 0; i < count; i += 1) {
    const angle = Math.random() * Math.PI * 2;
    const radius = 2_100_000 + Math.random() * 1_400_000;
    const idx = i * 3;
    positions[idx] = center.x + Math.cos(angle) * radius;
    positions[idx + 1] = center.y + (Math.random() - 0.5) * 40_000;
    positions[idx + 2] = center.z + Math.sin(angle) * radius;

    const c = new THREE.Color(
      rockPalette[Math.floor(Math.random() * rockPalette.length)],
    );
    colors[idx] = c.r;
    colors[idx + 1] = c.g;
    colors[idx + 2] = c.b;
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geom.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  const kuiperGlow = createStarGlowSpriteTexture(96);
  group.add(
    new THREE.Points(
      geom,
      new THREE.PointsMaterial({
        vertexColors: true,
        map: kuiperGlow,
        alphaMap: kuiperGlow,
        alphaTest: 0.02,
        size: 3.2,
        sizeAttenuation: false,
        transparent: true,
        opacity: 0.88,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    ),
  );
  return group;
}

function createOortCloudScale() {
  const group = new THREE.Group();
  const center = new THREE.Vector3(-780_000, -5_200_000, 0);
  const count = 24000;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    const u = Math.random();
    const v = Math.random();
    const theta = 2 * Math.PI * u;
    const phi = Math.acos(2 * v - 1);
    const radius = 5_400_000 + Math.random() * 4_600_000;
    const idx = i * 3;
    positions[idx] = center.x + radius * Math.sin(phi) * Math.cos(theta);
    positions[idx + 1] = center.y + radius * Math.cos(phi);
    positions[idx + 2] = center.z + radius * Math.sin(phi) * Math.sin(theta);
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const oortGlow = createStarGlowSpriteTexture(96);
  group.add(
    new THREE.Points(
      geom,
      new THREE.PointsMaterial({
        color: 0xd8ecff,
        map: oortGlow,
        alphaMap: oortGlow,
        alphaTest: 0.02,
        size: 2.45,
        sizeAttenuation: false,
        transparent: true,
        opacity: 0.65,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    ),
  );
  return group;
}

function createGalacticScale() {
  const group = new THREE.Group();
  const galacticCenter = new THREE.Vector3(
    55_000_000,
    -120_000_000,
    -3_600_000_000,
  );
  const galaxyRadius = 12_000_000_000;
  const coreRadius = 2_200_000_000;
  const armCount = 5;
  const starsPerArm = 16_000;
  const haloCount = 10_500;
  const brightBodyCount = 420;
  const starGlowSprite = createStarGlowSpriteTexture();
  // Layered reveal: sparse first (closer), then denser farther away.
  const sparseLayerY = 0;
  const midLayerY = -260_000_000;
  const denseLayerY = -560_000_000;

  const armPositions = new Float32Array(armCount * starsPerArm * 3);
  const armColors = new Float32Array(armCount * starsPerArm * 3);
  let armCursor = 0;
  for (let arm = 0; arm < armCount; arm += 1) {
    const armOffset = (arm / armCount) * Math.PI * 2;
    for (let i = 0; i < starsPerArm; i += 1) {
      const t = i / starsPerArm;
      const radius =
        coreRadius +
        t * (galaxyRadius - coreRadius) +
        (Math.random() - 0.5) * 90_000_000;
      const angle = armOffset + t * 10.0 + (Math.random() - 0.5) * 0.28;
      armPositions[armCursor] = galacticCenter.x + Math.cos(angle) * radius;
      armPositions[armCursor + 1] =
        galacticCenter.y +
        denseLayerY +
        (Math.random() - 0.5) * (460_000_000 + radius * 0.05);
      armPositions[armCursor + 2] = galacticCenter.z + Math.sin(angle) * radius;

      const warmth = 0.3 + Math.random() * 0.7;
      armColors[armCursor] = 0.65 + warmth * 0.35;
      armColors[armCursor + 1] = 0.7 + warmth * 0.3;
      armColors[armCursor + 2] = 0.9 + (1 - warmth) * 0.1;
      armCursor += 3;
    }
  }
  const armGeom = new THREE.BufferGeometry();
  armGeom.setAttribute("position", new THREE.BufferAttribute(armPositions, 3));
  armGeom.setAttribute("color", new THREE.BufferAttribute(armColors, 3));
  group.add(
    new THREE.Points(
      armGeom,
      new THREE.PointsMaterial({
        // Stars render at constant pixel size so the spiral pattern is
        // visible across the entire Milky Way zoom range. With attenuation
        // on, the previous 2M-world-unit size projected to ~4e-9 px at the
        // layer's intended camera distance.
        size: 2.85,
        sizeAttenuation: false,
        map: starGlowSprite,
        alphaMap: starGlowSprite,
        alphaTest: 0.02,
        vertexColors: true,
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    ),
  );

  const haloPositions = new Float32Array(haloCount * 3);
  const haloColors = new Float32Array(haloCount * 3);
  let haloCursor = 0;
  for (let i = 0; i < haloCount; i += 1) {
    const t = Math.pow(Math.random(), 1.15);
    const radius = t * galaxyRadius * 1.18;
    const angle = Math.random() * Math.PI * 2;
    haloPositions[haloCursor] = galacticCenter.x + Math.cos(angle) * radius;
    haloPositions[haloCursor + 1] =
      galacticCenter.y +
      sparseLayerY +
      (Math.random() - 0.5) * (380_000_000 + radius * 0.04);
    haloPositions[haloCursor + 2] = galacticCenter.z + Math.sin(angle) * radius;
    haloColors[haloCursor] = 0.55 + Math.random() * 0.2;
    haloColors[haloCursor + 1] = 0.6 + Math.random() * 0.2;
    haloColors[haloCursor + 2] = 0.72 + Math.random() * 0.2;
    haloCursor += 3;
  }
  const haloGeom = new THREE.BufferGeometry();
  haloGeom.setAttribute(
    "position",
    new THREE.BufferAttribute(haloPositions, 3),
  );
  haloGeom.setAttribute("color", new THREE.BufferAttribute(haloColors, 3));
  group.add(
    new THREE.Points(
      haloGeom,
      new THREE.PointsMaterial({
        size: 2.15,
        sizeAttenuation: false,
        map: starGlowSprite,
        alphaMap: starGlowSprite,
        alphaTest: 0.02,
        vertexColors: true,
        transparent: true,
        opacity: 0.62,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    ),
  );

  const midCount = Math.floor((armCount * starsPerArm) / 3);
  const midPositions = new Float32Array(midCount * 3);
  const midColors = new Float32Array(midCount * 3);
  let midCursor = 0;
  for (let i = 0; i < midCount; i += 1) {
    const t = Math.pow(Math.random(), 1.35);
    const radius = coreRadius + t * (galaxyRadius * 0.96 - coreRadius);
    const arm = Math.floor(Math.random() * armCount);
    const armOffset = (arm / armCount) * Math.PI * 2;
    const angle = armOffset + t * 10.0 + (Math.random() - 0.5) * 0.24;
    midPositions[midCursor] = galacticCenter.x + Math.cos(angle) * radius;
    midPositions[midCursor + 1] =
      galacticCenter.y +
      midLayerY +
      (Math.random() - 0.5) * (320_000_000 + radius * 0.03);
    midPositions[midCursor + 2] = galacticCenter.z + Math.sin(angle) * radius;
    const c = 0.72 + Math.random() * 0.22;
    midColors[midCursor] = c;
    midColors[midCursor + 1] = c;
    midColors[midCursor + 2] = 0.9 + Math.random() * 0.1;
    midCursor += 3;
  }
  const midGeom = new THREE.BufferGeometry();
  midGeom.setAttribute("position", new THREE.BufferAttribute(midPositions, 3));
  midGeom.setAttribute("color", new THREE.BufferAttribute(midColors, 3));
  group.add(
    new THREE.Points(
      midGeom,
      new THREE.PointsMaterial({
        size: 2.35,
        sizeAttenuation: false,
        map: starGlowSprite,
        alphaMap: starGlowSprite,
        alphaTest: 0.02,
        vertexColors: true,
        transparent: true,
        opacity: 0.75,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    ),
  );

  // 420 bright bodies are batched into a single InstancedMesh so the dense
  // spiral reads at one draw call instead of 420.
  const brightBodies = new THREE.InstancedMesh(
    new THREE.SphereGeometry(1, 10, 8),
    new THREE.MeshBasicMaterial(),
    brightBodyCount,
  );
  const dummy = new THREE.Object3D();
  const bodyColor = new THREE.Color();
  for (let i = 0; i < brightBodyCount; i += 1) {
    const t = Math.pow(Math.random(), 1.35);
    const radius = coreRadius + t * (galaxyRadius * 0.94 - coreRadius);
    const arm = Math.floor(Math.random() * armCount);
    const armOffset = (arm / armCount) * Math.PI * 2;
    const angle = armOffset + t * 10.0 + (Math.random() - 0.5) * 0.2;
    const r = 4_000_000 + Math.random() * 4_000_000;
    dummy.position.set(
      galacticCenter.x + Math.cos(angle) * radius,
      galacticCenter.y +
        denseLayerY +
        (Math.random() - 0.5) * (420_000_000 + radius * 0.04),
      galacticCenter.z + Math.sin(angle) * radius,
    );
    dummy.rotation.set(0, 0, 0);
    dummy.scale.setScalar(r);
    dummy.updateMatrix();
    brightBodies.setMatrixAt(i, dummy.matrix);
    bodyColor.setHSL(
      0.07 + Math.random() * 0.1,
      0.55 + Math.random() * 0.35,
      0.58 + Math.random() * 0.32,
    );
    brightBodies.setColorAt(i, bodyColor);
  }
  brightBodies.instanceMatrix.needsUpdate = true;
  if (brightBodies.instanceColor) {
    brightBodies.instanceColor.needsUpdate = true;
  }
  group.add(brightBodies);

  // Massive black hole at the galactic center.
  const blackHole = new THREE.Mesh(
    new THREE.SphereGeometry(70_000_000, 36, 24),
    new THREE.MeshBasicMaterial({ color: 0x030303 }),
  );
  blackHole.position.set(
    galacticCenter.x,
    galacticCenter.y + denseLayerY,
    galacticCenter.z,
  );
  group.add(blackHole);

  return group;
}

function createCosmicScale() {
  const group = new THREE.Group();
  const center = new THREE.Vector3(55_000_000, -200_000_000, -3_600_000_000);
  const count = 6500;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const scaleSize = 60_000_000_000;
  const cosmicGlow = createStarGlowSpriteTexture();
  for (let i = 0; i < count; i += 1) {
    const idx = i * 3;
    positions[idx] = center.x + (Math.random() - 0.5) * scaleSize;
    positions[idx + 1] = center.y + (Math.random() - 0.5) * scaleSize * 0.5;
    positions[idx + 2] = center.z + (Math.random() - 0.5) * scaleSize;
    const t = Math.random();
    colors[idx] = 0.7 + t * 0.3;
    colors[idx + 1] = 0.6 + t * 0.3;
    colors[idx + 2] = 0.85 + (1 - t) * 0.15;
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geom.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  group.add(
    new THREE.Points(
      geom,
      new THREE.PointsMaterial({
        size: 2.85,
        sizeAttenuation: false,
        map: cosmicGlow,
        alphaMap: cosmicGlow,
        alphaTest: 0.02,
        vertexColors: true,
        transparent: true,
        opacity: 0.9,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    ),
  );
  return group;
}

// ============================================================================
// Scene composition
// ============================================================================

function setupScene() {
  // Every factory is added directly to the scene at full opacity. There is
  // no layer-fade orchestration, no per-frame opacity updates, and no name
  // map — once setupScene returns, the scene graph is complete.
  scene.add(createPicnicScale());
  scene.add(createParkScale());
  scene.add(createNeighborhoodScale());
  scene.add(createCityScale());

  const earth = createEarthScale();
  scene.add(earth);
  // Cache the cloud disk so animate() can spin it without re-traversing.
  cloudDisk = earth.getObjectByName("earth-clouds-disk");

  scene.add(createPlanetaryScale());
  scene.add(createKuiperBeltScale());
  scene.add(createOortCloudScale());
  scene.add(createGalacticScale());
  scene.add(createCosmicScale());
}

function updateCamera() {
  const distanceMeters = 10 ** exponent;
  const distanceWorld = distanceMeters / metersPerWorldUnit;
  camera.position.set(0, distanceWorld, 0);
  camera.lookAt(0, 0, 0);

  // Keep everything in frustum: farthest point is at most ~distanceWorld + SCENE_RADIUS
  // along the top-down ray (plus diagonal slack). Old `5 * distanceWorld` clipped
  // Kuiper / Oort / galaxy until the camera crossed an exponent threshold.
  camera.near = Math.max(1e-5, distanceWorld / 200_000);
  camera.far = Math.max(
    100_000,
    distanceWorld + SCENE_RADIUS * 2.5,
    SCENE_RADIUS * 2.5,
  );
  camera.updateProjectionMatrix();

  if (scaleLabel) {
    scaleLabel.textContent = `10^${exponent.toFixed(2)} m`;
  }

  if (statusLabel) {
    if (overviewTour) {
      const leg = overviewTour.phase === "out" ? "Zoom out" : "Return";
      statusLabel.textContent = `${leg} (tour) | ${speed.toFixed(2)}x`;
    } else if (paused) {
      statusLabel.textContent = "Paused";
    } else {
      const dirText = direction > 0 ? "Outward" : "Inward";
      statusLabel.textContent = `${speed.toFixed(2)}x | ${dirText}`;
    }
  }
}

// ============================================================================
// Animation loop + input
// ============================================================================

const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  // Clamp dt so a backgrounded tab does not produce a single huge step
  // when the user returns and the clock has accumulated wall time.
  const dt = Math.min(clock.getDelta(), 0.1);

  if (overviewTour) {
    overviewTour.elapsed += dt;
    const rawT = Math.min(1, overviewTour.elapsed / overviewTour.duration);
    const k = smoothT(rawT);
    exponent = THREE.MathUtils.lerp(overviewTour.from, overviewTour.to, k);

    if (rawT >= 1) {
      exponent = overviewTour.to;
      if (overviewTour.phase === "out") {
        overviewTour = {
          phase: "in",
          elapsed: 0,
          duration: OVERVIEW_TOUR_IN_SECONDS,
          from: OVERVIEW_EXPONENT,
          to: TOUR_RETURN_EXPONENT,
        };
      } else {
        overviewTour = null;
        exponent = TOUR_RETURN_EXPONENT;
        paused = true;
      }
    }
  } else if (!paused) {
    exponent += direction * speed * dt;
    exponent = THREE.MathUtils.clamp(exponent, minExponent, maxExponent);
  }

  if (cloudDisk) {
    cloudDisk.rotation.z += dt * 0.02;
  }

  if (sunGlowTimeUniform) {
    sunGlowTimeUniform.value = clock.getElapsedTime();
  }

  updateCamera();

  renderer.render(scene, camera);
}

window.addEventListener("keydown", (event) => {
  if (event.code === "Enter") {
    overviewTour = {
      phase: "out",
      elapsed: 0,
      duration: OVERVIEW_TOUR_OUT_SECONDS,
      from: exponent,
      to: OVERVIEW_EXPONENT,
    };
    event.preventDefault();
  } else if (event.code === "Space") {
    if (overviewTour) {
      event.preventDefault();
      return;
    }
    paused = !paused;
    event.preventDefault();
  } else if (event.code === "ArrowUp") {
    if (overviewTour) {
      event.preventDefault();
      return;
    }
    speed = Math.min(1.2, speed + 0.05);
    event.preventDefault();
  } else if (event.code === "ArrowDown") {
    if (overviewTour) {
      event.preventDefault();
      return;
    }
    speed = Math.max(0.05, speed - 0.05);
    event.preventDefault();
  } else if (event.code === "KeyR") {
    if (overviewTour) {
      event.preventDefault();
      return;
    }
    direction *= -1;
    event.preventDefault();
  } else if (event.code === "Home") {
    if (overviewTour) {
      event.preventDefault();
      return;
    }
    exponent = minExponent;
    event.preventDefault();
  } else if (event.code === "End") {
    if (overviewTour) {
      event.preventDefault();
      return;
    }
    exponent = maxExponent;
    event.preventDefault();
  }
});

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    // Reset the clock so the first dt after returning to the tab is small.
    clock.start();
  }
});

setupScene();
updateCamera();
animate();
