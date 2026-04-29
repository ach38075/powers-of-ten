import * as THREE from "three";
import "./style.css";

const canvases = Array.from(document.querySelectorAll("#app"));
const canvas = canvases[0];
for (let i = 1; i < canvases.length; i += 1) {
  canvases[i].remove();
}
const scaleLabel = document.querySelector("#scale-label");

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();
scene.fog = null;

const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  0.1,
  20_000,
);

const ambient = new THREE.AmbientLight(0x6f84aa, 0.35);
scene.add(ambient);
ambient.intensity = 0.48;

const sunLight = new THREE.DirectionalLight(0xffffff, 1.2);
sunLight.position.set(600, 400, 300);
scene.add(sunLight);
sunLight.intensity = 1.35;

const world = new THREE.Group();
scene.add(world);

const tmpVec = new THREE.Vector3();
const scaleObjects = new Map();
const metersPerWorldUnit = 1;
const EARTH_RADIUS = 6700;
const LAND_REGIONS = [
  { x: -1800, z: -900, r: 1900 },
  { x: 1400, z: -1100, r: 1600 },
  { x: -500, z: 1800, r: 1500 },
  { x: 2200, z: 1500, r: 1200 },
  { x: -2600, z: 1500, r: 1100 },
];
const minExponent = -1.7;
const maxExponent = 23;

let exponent = -1.2;
let speed = 0.18;
let paused = false;

function makeGround(size, color, y = -0.02) {
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(size, 48),
    new THREE.MeshStandardMaterial({ color, roughness: 1.0, metalness: 0.0 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = y;
  return ground;
}

function makeTree(x, z, trunkHeight = 8, crownRadius = 3.2) {
  const group = new THREE.Group();
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.6, 0.8, trunkHeight, 8),
    new THREE.MeshStandardMaterial({ color: 0x5b3b2b, roughness: 1.0 }),
  );
  const crown = new THREE.Mesh(
    new THREE.SphereGeometry(crownRadius, 12, 10),
    new THREE.MeshStandardMaterial({ color: 0x315b2d, roughness: 0.95 }),
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
    new THREE.MeshStandardMaterial({ color: 0x2f5a2e, roughness: 1.0 }),
  );
  bush.position.set(x, 1 * scale, z);
  return bush;
}

function makeCar(x, z, color = 0x3f6fb1, heading = 0) {
  const car = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(7.2, 1.6, 3.8),
    new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.25 }),
  );
  body.position.y = 1.2;
  const cabin = new THREE.Mesh(
    new THREE.BoxGeometry(3.5, 1.3, 3.2),
    new THREE.MeshStandardMaterial({ color: 0xcfd7e6, roughness: 0.45, metalness: 0.15 }),
  );
  cabin.position.set(0.5, 2.15, 0);
  car.add(body);
  car.add(cabin);
  car.position.set(x, 0, z);
  car.rotation.y = heading;
  return car;
}

function randomPointInRing(innerR, outerR) {
  const t = Math.random();
  const radius = Math.sqrt(innerR * innerR + t * (outerR * outerR - innerR * innerR));
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
  return LAND_REGIONS.some((land) => (x - land.x) ** 2 + (z - land.z) ** 2 < land.r ** 2);
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

function addNeighborhoodCluster(group, centerX, centerZ, options = {}) {
  const anchored = projectToLand(centerX, centerZ);
  centerX = anchored.x;
  centerZ = anchored.z;
  const roads = options.roads ?? 4;
  const span = options.span ?? 680;
  const spacing = span / roads;
  const roadMaterial = new THREE.MeshStandardMaterial({ color: 0x2f2f34, roughness: 0.95 });

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

  const occupied = [];
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
            (p) => (candidate.x - p.x) ** 2 + (candidate.z - p.z) ** 2 < 34 ** 2,
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
        const house = new THREE.Mesh(
          new THREE.BoxGeometry(18 + Math.random() * 14, 12 + Math.random() * 20, 16 + Math.random() * 12),
          new THREE.MeshStandardMaterial({
            color: new THREE.Color().setHSL(0.03 + Math.random() * 0.08, 0.45, 0.52 + Math.random() * 0.18),
            roughness: 0.9,
          }),
        );
        house.position.set(housePos.x, house.geometry.parameters.height / 2, housePos.z);
        house.rotation.y = (Math.random() - 0.5) * 1.0;
        group.add(house);
        occupied.push(housePos);

        if (Math.random() < 0.65) {
          const treeSpot = clampToEarth(
            house.position.x + 12 + (Math.random() - 0.5) * 10,
            house.position.z + 12 + (Math.random() - 0.5) * 10,
            40,
          );
          if (isLandAt(treeSpot.x, treeSpot.z)) {
            group.add(makeTree(treeSpot.x, treeSpot.z, 5 + Math.random() * 4, 2 + Math.random()));
          }
        }
      }
    }
  }
}

function createPicnicScale() {
  const group = new THREE.Group();
  group.add(makeGround(9, 0x496c3e, 0.0));

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

  const bugBody = new THREE.Mesh(
    new THREE.SphereGeometry(0.055, 16, 12),
    new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.45 }),
  );
  bugBody.position.set(0.16, 0.09, 0.04);
  group.add(bugBody);

  const bugShell = new THREE.Mesh(
    new THREE.SphereGeometry(0.045, 16, 12),
    new THREE.MeshStandardMaterial({ color: 0xd22727, roughness: 0.5 }),
  );
  bugShell.position.set(0.16, 0.102, 0.04);
  group.add(bugShell);

  return group;
}

function createParkScale() {
  const group = new THREE.Group();
  group.add(makeGround(2400, 0x3f6a37, -0.06));

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
  const cityCenters = [
    new THREE.Vector2(-1700, 1300),
    new THREE.Vector2(2200, -900),
    new THREE.Vector2(-500, -2300),
    new THREE.Vector2(1800, 2000),
  ];
  for (const cityCenter of cityCenters) {
    for (let i = 0; i < 16; i += 1) {
    const tower = new THREE.Mesh(
      new THREE.BoxGeometry(65 + Math.random() * 70, 200 + Math.random() * 700, 65 + Math.random() * 70),
      new THREE.MeshStandardMaterial({
        color: new THREE.Color().setHSL(0.58, 0.05, 0.36 + Math.random() * 0.22),
        roughness: 0.84,
      }),
    );
    const angle = (i / 16) * Math.PI * 2 + (Math.random() - 0.5) * 0.25;
    const radius = 260 + Math.random() * 620;
    const projected = clampToEarth(
      cityCenter.x + Math.cos(angle) * radius,
      cityCenter.y + Math.sin(angle) * radius,
      420,
    );
    const x = projected.x;
    const z = projected.z;
    tower.position.set(x, tower.geometry.parameters.height / 2, z);
    group.add(tower);
  }
  }

  // Additional neighborhoods appear on the outskirts at larger scales.
  addNeighborhoodCluster(group, -2200, -300, { roads: 3, span: 420 });
  addNeighborhoodCluster(group, 2100, 1700, { roads: 2, span: 360 });
  addNeighborhoodCluster(group, -500, 2400, { roads: 2, span: 340 });

  return group;
}

function addStarField(radius, count, color, size) {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    const r = radius * (0.4 + Math.random() * 0.6);
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(1 - 2 * Math.random());
    const idx = i * 3;
    positions[idx] = r * Math.sin(phi) * Math.cos(theta);
    positions[idx + 1] = r * Math.cos(phi);
    positions[idx + 2] = r * Math.sin(phi) * Math.sin(theta);
  }
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));

  const points = new THREE.Points(
    geometry,
    new THREE.PointsMaterial({
      color,
      size,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.9,
    }),
  );
  return points;
}

function createEarthScale() {
  const group = new THREE.Group();
  const earthRadius = EARTH_RADIUS;
  const earthGeometry = new THREE.CircleGeometry(earthRadius, 96);
  const earthMaterial = new THREE.MeshStandardMaterial({
    color: 0x2b67ba,
    roughness: 0.55,
    metalness: 0.08,
  });
  const earth = new THREE.Mesh(earthGeometry, earthMaterial);
  earth.rotation.x = -Math.PI / 2;
  earth.position.y = -0.14;
  group.add(earth);

  const landMaterial = new THREE.MeshStandardMaterial({
    color: 0x4c9142,
    roughness: 0.95,
  });

  // Reduced and cleaner land layering to avoid z-fighting/glitch artifacts.
  for (const center of LAND_REGIONS) {
    for (let i = 0; i < 7; i += 1) {
      const angle = Math.random() * Math.PI * 2;
      const radiusOffset = Math.random() * center.r * 0.72;
      const px = center.x + Math.cos(angle) * radiusOffset;
      const pz = center.z + Math.sin(angle) * radiusOffset;
      const blob = new THREE.Mesh(
        new THREE.CircleGeometry(260 + Math.random() * 440, 26),
        landMaterial,
      );
      blob.rotation.x = -Math.PI / 2;
      blob.scale.set(0.65 + Math.random() * 0.95, 1, 0.65 + Math.random() * 0.95);
      blob.rotation.z = Math.random() * Math.PI * 2;
      blob.position.set(px, -0.11, pz);
      group.add(blob);
    }
  }

  const forestMaterial = new THREE.MeshStandardMaterial({ color: 0x315d2b, roughness: 1 });
  for (let i = 0; i < 170; i += 1) {
    const { x, z } = randomPointInRing(140, earthRadius - 160);
    if (!isLandAt(x, z)) {
      continue;
    }
    const dot = new THREE.Mesh(new THREE.CircleGeometry(22 + Math.random() * 26, 10), forestMaterial);
    dot.rotation.x = -Math.PI / 2;
    dot.position.set(x, -0.09, z);
    group.add(dot);
  }

  const hillMaterial = new THREE.MeshStandardMaterial({ color: 0x3b7b33, roughness: 1.0 });
  for (let i = 0; i < 55; i += 1) {
    const { x, z } = randomPointInRing(300, earthRadius - 300);
    if (!isLandAt(x, z)) {
      continue;
    }
    const hill = new THREE.Mesh(
      new THREE.ConeGeometry(36 + Math.random() * 70, 16 + Math.random() * 34, 10),
      hillMaterial,
    );
    hill.position.set(x, hill.geometry.parameters.height / 2 - 0.105, z);
    hill.rotation.y = Math.random() * Math.PI * 2;
    group.add(hill);
  }

  return group;
}

function createPlanetaryScale() {
  const group = new THREE.Group();
  const kmToWorld = EARTH_RADIUS / 6_371;
  const anchorZ = 0;

  // Planar starfield on Earth's plane so stars enter earlier during zoom-out.
  const planarStars = new THREE.BufferGeometry();
  const starCount = 9000;
  const positions = new Float32Array(starCount * 3);
  for (let i = 0; i < starCount; i += 1) {
    const angle = Math.random() * Math.PI * 2;
    const radius = 14_000 + Math.random() * 420_000;
    const idx = i * 3;
    positions[idx] = Math.cos(angle) * radius;
    positions[idx + 1] = 0;
    positions[idx + 2] = anchorZ + Math.sin(angle) * radius;
  }
  planarStars.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  group.add(
    new THREE.Points(
      planarStars,
      new THREE.PointsMaterial({
        color: 0xf4f7ff,
        size: 18,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.85,
      }),
    ),
  );

  const innerPlanets = [
    { radiusKm: 2_440, color: 0xff2e2e, x: -38_000, z: anchorZ - 1_500 }, // Mercury red
    { radiusKm: 6_052, color: 0xff8e1a, x: -24_000, z: anchorZ + 900 },   // Venus orange
    { radiusKm: 3_390, color: 0xffdb3a, x: 24_000, z: anchorZ - 1_100 },  // Mars yellow
  ];
  for (const planet of innerPlanets) {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(planet.radiusKm * kmToWorld, 26, 16),
      new THREE.MeshBasicMaterial({ color: planet.color }),
    );
    mesh.position.set(planet.x, 0, planet.z);
    group.add(mesh);
  }

  // Outer planets are present in the same scene from the start, farther right.
  const outerPlanets = [
    { radiusKm: 69_911, color: 0x31c94e, x: 170_000, z: anchorZ + 8_000 }, // Jupiter green
    { radiusKm: 58_232, color: 0x3d72ff, x: 345_000, z: anchorZ - 6_000 }, // Saturn blue
    { radiusKm: 25_362, color: 0x8e44ff, x: 470_000, z: anchorZ + 5_000 }, // Uranus purple
    { radiusKm: 24_622, color: 0xff5fb5, x: 600_000, z: anchorZ - 7_000 }, // Neptune pink
  ];
  for (const planet of outerPlanets) {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(planet.radiusKm * kmToWorld, 28, 18),
      new THREE.MeshBasicMaterial({ color: planet.color }),
    );
    mesh.position.set(planet.x, 0, planet.z);
    group.add(mesh);
  }

  // Sun stays left and off center so it does not block Earth.
  const sun = new THREE.Mesh(
    new THREE.SphereGeometry(696_700 * kmToWorld, 30, 20),
    new THREE.MeshBasicMaterial({ color: 0xffc06b }),
  );
  sun.position.set(-900_000, -700_000, anchorZ);
  group.add(sun);

  return group;
}

function createSolarScale() {
  const group = new THREE.Group();
  group.add(addStarField(1_400_000, 20000, 0xdde4ff, 65));

  return group;
}

function createGalacticScale() {
  const group = new THREE.Group();
  const armCount = 5;
  const starsPerArm = 2200;
  const positions = new Float32Array(armCount * starsPerArm * 3);

  let cursor = 0;
  for (let arm = 0; arm < armCount; arm += 1) {
    const armOffset = (arm / armCount) * Math.PI * 2;
    for (let i = 0; i < starsPerArm; i += 1) {
      const t = i / starsPerArm;
      const radius = 2000 + t * 8500 + (Math.random() - 0.5) * 280;
      const angle = armOffset + t * 8.0 + (Math.random() - 0.5) * 0.25;
      positions[cursor] = Math.cos(angle) * radius;
      positions[cursor + 1] = (Math.random() - 0.5) * 700;
      positions[cursor + 2] = Math.sin(angle) * radius;
      cursor += 3;
    }
  }

  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  group.add(
    new THREE.Points(
      geom,
      new THREE.PointsMaterial({
        color: 0xc9d4ff,
        size: 6,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.85,
      }),
    ),
  );
  return group;
}

function createCosmicScale() {
  const group = new THREE.Group();
  group.add(addStarField(32_000, 20_000, 0xeff3ff, 7.4));

  for (let i = 0; i < 8; i += 1) {
    const cluster = new THREE.Mesh(
      new THREE.IcosahedronGeometry(220 + Math.random() * 120, 1),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color().setHSL(0.62 + Math.random() * 0.15, 0.55, 0.66),
        transparent: true,
        opacity: 0.23,
        wireframe: true,
      }),
    );
    cluster.position.set(
      (Math.random() - 0.5) * 28_000,
      (Math.random() - 0.5) * 18_000,
      (Math.random() - 0.5) * 28_000,
    );
    group.add(cluster);
  }

  return group;
}

function smoothStep(edge0, edge1, x) {
  const t = THREE.MathUtils.clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function setObjectOpacity(object, alpha) {
  object.visible = alpha > 0.002;
  object.traverse((child) => {
    if (!child.material) {
      return;
    }
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) {
      if (material.userData.baseOpacity === undefined) {
        material.userData.baseOpacity = material.opacity ?? 1;
      }
      material.opacity = material.userData.baseOpacity * alpha;
      const shouldTransparent = alpha < 0.999;
      material.transparent = shouldTransparent;
      material.depthWrite = alpha > 0.98;
      if (material.userData.wasTransparent !== shouldTransparent) {
        material.needsUpdate = true;
        material.userData.wasTransparent = shouldTransparent;
      }
    }
  });
}

const scaleDefinitions = [
  { name: "Picnic Blanket", min: -2, max: 0.6, blend: 0.42, factory: createPicnicScale },
  { name: "Park and Trees", min: 0.25, max: 2.2, blend: 0.52, factory: createParkScale },
  { name: "Neighborhood", min: 1.5, max: 4.1, blend: 0.52, factory: createNeighborhoodScale },
  { name: "Cityscape", min: 3.2, max: 5.9, blend: 0.56, factory: createCityScale },
  { name: "Earth", min: 2.8, max: 8, blend: 1.0, factory: createEarthScale },
  { name: "Near Space", min: 4.4, max: 10.5, blend: 0.95, factory: createPlanetaryScale },
  { name: "Solar System", min: 8.6, max: 14, blend: 0.6, factory: createSolarScale },
  { name: "Milky Way", min: 14, max: 19, blend: 0.6, factory: createGalacticScale },
  { name: "Cosmic Web", min: 19, max: 24, blend: 0.6, factory: createCosmicScale },
];

function initializeScales() {
  for (const def of scaleDefinitions) {
    const object = def.factory();
    object.name = def.name;
    world.add(object);
    scaleObjects.set(def.name, object);
    setObjectOpacity(object, 0);
  }
}

function updateRanges() {
  for (const def of scaleDefinitions) {
    const object = scaleObjects.get(def.name);
    if (!object) {
      continue;
    }
    const alpha = smoothStep(def.min - def.blend, def.min + def.blend, exponent);
    setObjectOpacity(object, alpha);
  }
}

function updateCamera() {
  const distanceMeters = 10 ** exponent;
  const distanceWorld = distanceMeters / metersPerWorldUnit;
  camera.position.set(0, distanceWorld, 0);
  camera.lookAt(tmpVec.set(0, 0, 0));

  const smoothFar = Math.max(10_000, distanceWorld * 5);
  camera.far = smoothFar;
  camera.near = Math.max(0.01, distanceWorld / 50_000);
  camera.updateProjectionMatrix();

  const activeName =
    scaleDefinitions.find((range) => exponent >= range.min && exponent < range.max)?.name ??
    "Transition";
  scaleLabel.textContent = `${activeName} | 10^${exponent.toFixed(2)} m`;
}

const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const dt = clock.getDelta();

  if (!paused) {
    exponent += speed * dt;
    exponent = THREE.MathUtils.clamp(exponent, minExponent, maxExponent);
    if (exponent === maxExponent) {
      paused = true;
    }
  }

  updateRanges();
  updateCamera();

  renderer.render(scene, camera);
}

window.addEventListener("keydown", (event) => {
  if (event.code === "Space") {
    paused = !paused;
  }
  if (event.code === "ArrowUp") {
    speed = Math.min(1.2, speed + 0.05);
  }
  if (event.code === "ArrowDown") {
    speed = Math.max(0.05, speed - 0.05);
  }
});

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
});

initializeScales();
updateRanges();
updateCamera();
animate();
