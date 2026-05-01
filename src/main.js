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
const ALWAYS_ON_LAYERS = new Set([
  "Earth",
  "Near Space",
  "Solar System",
  "Kuiper Belt",
  "Oort Cloud",
  "Milky Way",
  "Cosmic Web",
]);
const metersPerWorldUnit = 1;
const EARTH_RADIUS = 6700;
const LAND_REGIONS = [
  { x: -1800, z: -900, r: 1900 },
  { x: 1400, z: -1100, r: 1600 },
  { x: -500, z: 1800, r: 1500 },
  { x: 2200, z: 1500, r: 1200 },
  { x: -2600, z: 1500, r: 1100 },
  { x: 3200, z: -900, r: 1000 },
  { x: -3300, z: -1400, r: 900 },
  { x: 2700, z: 2700, r: 850 },
  { x: -800, z: -3100, r: 950 },
];
const minExponent = -1.7;
const maxExponent = 23;

let exponent = -1.2;
let speed = 0.18;
let paused = false;

function createRoundSpriteTexture(size = 64) {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return null;
  }
  const center = size / 2;
  const radius = size * 0.45;
  const gradient = ctx.createRadialGradient(center, center, 0, center, center, radius);
  gradient.addColorStop(0.0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.55, "rgba(255,255,255,0.95)");
  gradient.addColorStop(1.0, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(center, center, radius, 0, Math.PI * 2);
  ctx.fill();
  return new THREE.CanvasTexture(canvas);
}

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

  const torso = new THREE.Mesh(
    // Single tapered body: narrower near neck, wider toward hips.
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
    shirt: 0x4f79b8,
    pants: 0x273551,
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
    color: 0x3f8f3f,
    roughness: 0.9,
    metalness: 0.0,
  });
  const earth = new THREE.Mesh(earthGeometry, earthMaterial);
  earth.rotation.x = -Math.PI / 2;
  earth.position.y = -0.14;
  group.add(earth);

  return group;
}

function createPlanetaryScale() {
  const group = new THREE.Group();
  const kmToWorld = EARTH_RADIUS / 6_371;
  const anchorZ = 0;
  const sunCenter = new THREE.Vector2(-780_000, anchorZ - 80_000);

  const innerPlanets = [
    // Keep each planet at same orbit radius, but move to new angles.
    { radiusKm: 2_440, color: 0xff2e2e, x: -38_000, z: anchorZ - 1_500, orbitAngle: 2.55 }, // Mercury red
    { radiusKm: 6_052, color: 0xff8e1a, x: -24_000, z: anchorZ + 900, orbitAngle: 2.0 },    // Venus orange
    { radiusKm: 3_390, color: 0xffdb3a, x: 24_000, z: anchorZ - 1_100, orbitAngle: 0.65 },   // Mars yellow
  ];
  for (const planet of innerPlanets) {
    const radiusFromSun = Math.hypot(planet.x - sunCenter.x, planet.z - sunCenter.y);
    const x = sunCenter.x + Math.cos(planet.orbitAngle) * radiusFromSun;
    const z = sunCenter.y + Math.sin(planet.orbitAngle) * radiusFromSun;
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(planet.radiusKm * kmToWorld, 26, 16),
      new THREE.MeshBasicMaterial({ color: planet.color }),
    );
    mesh.position.set(x, 0, z);
    group.add(mesh);
  }

  // Outer planets are present in the same scene from the start, farther right.
  const outerPlanets = [
    { radiusKm: 69_911, color: 0x31c94e, x: 140_000, z: anchorZ + 6_000, orbitAngle: 1.1 },  // Jupiter green
    { radiusKm: 58_232, color: 0x3d72ff, x: 400_000, z: anchorZ - 6_000, orbitAngle: 0.38 }, // Saturn blue
    { radiusKm: 25_362, color: 0x8e44ff, x: 620_000, z: anchorZ + 5_000, orbitAngle: -0.55 }, // Uranus purple
    { radiusKm: 24_622, color: 0xff5fb5, x: 730_000, z: anchorZ - 7_000, orbitAngle: -1.12 }, // Neptune pink
  ];
  for (const planet of outerPlanets) {
    const radiusFromSun = Math.hypot(planet.x - sunCenter.x, planet.z - sunCenter.y);
    const x = sunCenter.x + Math.cos(planet.orbitAngle) * radiusFromSun;
    const z = sunCenter.y + Math.sin(planet.orbitAngle) * radiusFromSun;
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(planet.radiusKm * kmToWorld, 28, 18),
      new THREE.MeshBasicMaterial({ color: planet.color }),
    );
    mesh.position.set(x, 0, z);
    group.add(mesh);

    // Add ring to Saturn for visual identity.
    if (planet.radiusKm === 58_232) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(planet.radiusKm * kmToWorld * 1.25, planet.radiusKm * kmToWorld * 1.9, 64),
        new THREE.MeshBasicMaterial({
          color: 0xd8d2bf,
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0.8,
        }),
      );
      // Start flat to camera, then tilt with left side dipping toward Jupiter.
      ring.rotation.set(-Math.PI / 2 + 0.26, 0.0, 0.36);
      ring.position.copy(mesh.position);
      group.add(ring);
    }
  }

  // Sun stays left and off center so it does not block Earth.
  const sun = new THREE.Mesh(
    new THREE.CircleGeometry(696_700 * kmToWorld, 64),
    new THREE.MeshBasicMaterial({ color: 0xffc06b }),
  );
  // Flat disk reads cleaner in top-down composition.
  sun.rotation.x = -Math.PI / 2;
  sun.position.set(-780_000, 0, anchorZ - 80_000);
  group.add(sun);

  return group;
}

function createSolarScale() {
  const group = new THREE.Group();

  return group;
}

function createKuiperBeltScale() {
  const group = new THREE.Group();
  // Match the Sun center in x/z so the belt is truly sun-centered.
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

    const color = new THREE.Color(rockPalette[Math.floor(Math.random() * rockPalette.length)]);
    colors[idx] = color.r;
    colors[idx + 1] = color.g;
    colors[idx + 2] = color.b;
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geom.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  group.add(
    new THREE.Points(
      geom,
      new THREE.PointsMaterial({
        vertexColors: true,
        size: 62,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.92,
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
  group.add(
    new THREE.Points(
      geom,
      new THREE.PointsMaterial({
        color: 0xd8ecff,
        size: 42,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.5,
      }),
    ),
  );
  return group;
}

function createGalacticScale() {
  const group = new THREE.Group();
  // Huge, high-in-frame galaxy: appears above Oort cloud in screen space.
  const galacticCenter = new THREE.Vector3(55_000_000, -120_000_000, -3_600_000_000);
  const galaxyRadius = 12_000_000_000;
  const coreRadius = 2_200_000_000;
  const armCount = 5;
  const starsPerArm = 16_000;
  const haloCount = 10_500;
  const brightBodyCount = 420;
  const roundSprite = createRoundSpriteTexture();
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
      const radius = coreRadius + t * (galaxyRadius - coreRadius) + (Math.random() - 0.5) * 90_000_000;
      const angle = armOffset + t * 10.0 + (Math.random() - 0.5) * 0.28;
      armPositions[armCursor] = galacticCenter.x + Math.cos(angle) * radius;
      armPositions[armCursor + 1] = galacticCenter.y + denseLayerY + (Math.random() - 0.5) * (460_000_000 + radius * 0.05);
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
        size: 2_000_000,
        sizeAttenuation: true,
        map: roundSprite,
        alphaMap: roundSprite,
        alphaTest: 0.15,
        vertexColors: true,
        transparent: true,
        opacity: 0.88,
      }),
    ),
  );

  // Sparse early bodies: visible shortly after Oort.
  const haloPositions = new Float32Array(haloCount * 3);
  const haloColors = new Float32Array(haloCount * 3);
  let haloCursor = 0;
  for (let i = 0; i < haloCount; i += 1) {
    const t = Math.pow(Math.random(), 1.15);
    const radius = t * galaxyRadius * 1.18;
    const angle = Math.random() * Math.PI * 2;
    haloPositions[haloCursor] = galacticCenter.x + Math.cos(angle) * radius;
    haloPositions[haloCursor + 1] =
      galacticCenter.y + sparseLayerY + (Math.random() - 0.5) * (380_000_000 + radius * 0.04);
    haloPositions[haloCursor + 2] = galacticCenter.z + Math.sin(angle) * radius;
    haloColors[haloCursor] = 0.55 + Math.random() * 0.2;
    haloColors[haloCursor + 1] = 0.6 + Math.random() * 0.2;
    haloColors[haloCursor + 2] = 0.72 + Math.random() * 0.2;
    haloCursor += 3;
  }

  const haloGeom = new THREE.BufferGeometry();
  haloGeom.setAttribute("position", new THREE.BufferAttribute(haloPositions, 3));
  haloGeom.setAttribute("color", new THREE.BufferAttribute(haloColors, 3));
  group.add(
    new THREE.Points(
      haloGeom,
      new THREE.PointsMaterial({
        size: 1_600_000,
        sizeAttenuation: true,
        map: roundSprite,
        alphaMap: roundSprite,
        alphaTest: 0.15,
        vertexColors: true,
        transparent: true,
        opacity: 0.24,
      }),
    ),
  );

  // Mid-density arm points appear after the sparse halo and before dense spiral.
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
    midPositions[midCursor + 1] = galacticCenter.y + midLayerY + (Math.random() - 0.5) * (320_000_000 + radius * 0.03);
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
        size: 1_800_000,
        sizeAttenuation: true,
        map: roundSprite,
        alphaMap: roundSprite,
        alphaTest: 0.15,
        vertexColors: true,
        transparent: true,
        opacity: 0.46,
      }),
    ),
  );

  // Purple tint across the full Milky Way with stronger top-layer emphasis.
  const hazeDisk = new THREE.Mesh(
    new THREE.CircleGeometry(galaxyRadius * 0.98, 120),
    new THREE.MeshBasicMaterial({
      color: 0xb58cff,
      transparent: true,
      opacity: 0.001,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    }),
  );
  hazeDisk.name = "milky-haze-base";
  hazeDisk.rotation.x = -Math.PI / 2;
  hazeDisk.position.set(galacticCenter.x, galacticCenter.y + sparseLayerY, galacticCenter.z);
  group.add(hazeDisk);

  const hazeTop = new THREE.Mesh(
    new THREE.CircleGeometry(galaxyRadius * 0.86, 120),
    new THREE.MeshBasicMaterial({
      color: 0xc7a3ff,
      transparent: true,
      opacity: 0.001,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    }),
  );
  hazeTop.name = "milky-haze-top";
  hazeTop.rotation.x = -Math.PI / 2;
  hazeTop.position.set(galacticCenter.x, galacticCenter.y + denseLayerY, galacticCenter.z);
  group.add(hazeTop);

  for (let i = 0; i < brightBodyCount; i += 1) {
    const t = Math.pow(Math.random(), 1.35);
    const radius = coreRadius + t * (galaxyRadius * 0.94 - coreRadius);
    const arm = Math.floor(Math.random() * armCount);
    const armOffset = (arm / armCount) * Math.PI * 2;
    const angle = armOffset + t * 10.0 + (Math.random() - 0.5) * 0.2;
    const body = new THREE.Mesh(
      new THREE.SphereGeometry(4_000_000 + Math.random() * 4_000_000, 10, 8),
      new THREE.MeshStandardMaterial({
        color: new THREE.Color().setHSL(
          0.02 + Math.random() * 0.62,
          0.42 + Math.random() * 0.38,
          0.54 + Math.random() * 0.26,
        ),
        roughness: 0.82,
      }),
    );
    body.position.set(
      galacticCenter.x + Math.cos(angle) * radius,
      galacticCenter.y + denseLayerY + (Math.random() - 0.5) * (420_000_000 + radius * 0.04),
      galacticCenter.z + Math.sin(angle) * radius,
    );
    group.add(body);
  }

  // Massive black hole at center, intentionally larger than Oort cloud.
  const blackHole = new THREE.Mesh(
    new THREE.SphereGeometry(70_000_000, 36, 24),
    new THREE.MeshBasicMaterial({ color: 0x030303 }),
  );
  blackHole.position.set(galacticCenter.x, galacticCenter.y + denseLayerY, galacticCenter.z);
  group.add(blackHole);

  return group;
}

function createCosmicScale() {
  const group = new THREE.Group();
  const cosmicCenter = new THREE.Vector3(-780_000, -60_000_000, -80_000);

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

function updateMilkyWayHaze() {
  const milkyWay = scaleObjects.get("Milky Way");
  if (!milkyWay) {
    return;
  }
  const baseHaze = milkyWay.getObjectByName("milky-haze-base");
  const topHaze = milkyWay.getObjectByName("milky-haze-top");
  if (!baseHaze || !topHaze || !baseHaze.material || !topHaze.material) {
    return;
  }
  // Start right after Oort begins to read in space.
  const start = 12.0;
  const end = 22.2;
  const t = THREE.MathUtils.clamp((exponent - start) / (end - start), 0, 1);
  const baseOpacity = THREE.MathUtils.lerp(0.01, 0.12, t);
  const topOpacity = THREE.MathUtils.lerp(0.004, 0.22, t * t);

  const baseMaterial = baseHaze.material;
  baseMaterial.opacity = baseOpacity;
  baseMaterial.transparent = true;
  baseMaterial.depthWrite = false;

  const topMaterial = topHaze.material;
  topMaterial.opacity = topOpacity;
  topMaterial.transparent = true;
  topMaterial.depthWrite = false;
}

const scaleDefinitions = [
  { name: "Picnic Blanket", min: -2, max: 0.6, blend: 0.42, factory: createPicnicScale },
  { name: "Park and Trees", min: 0.25, max: 2.2, blend: 0.52, factory: createParkScale },
  { name: "Neighborhood", min: 1.5, max: 4.1, blend: 0.52, factory: createNeighborhoodScale },
  { name: "Cityscape", min: 3.2, max: 5.9, blend: 0.56, factory: createCityScale },
  // Earth is the permanent base layer in the stack.
  { name: "Earth", min: -2, max: 24, blend: 0.2, factory: createEarthScale },
  { name: "Near Space", min: 5.8, max: 10.5, blend: 0.8, factory: createPlanetaryScale },
  { name: "Solar System", min: 8.6, max: 14, blend: 0.6, factory: createSolarScale },
  { name: "Kuiper Belt", min: 10.5, max: 16, blend: 0.6, factory: createKuiperBeltScale },
  { name: "Oort Cloud", min: 12, max: 18, blend: 0.6, factory: createOortCloudScale },
  { name: "Milky Way", min: 17.4, max: 22.2, blend: 1.8, factory: createGalacticScale },
  { name: "Cosmic Web", min: 22.2, max: 24, blend: 0.6, factory: createCosmicScale },
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
    const alpha = ALWAYS_ON_LAYERS.has(def.name)
      ? 1
      : smoothStep(def.min - def.blend, def.min + def.blend, exponent);
    setObjectOpacity(object, alpha);
  }
  updateMilkyWayHaze();
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
