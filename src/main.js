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
  logarithmicDepthBuffer: true,
  powerPreference: "high-performance",
});

renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;

renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
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
/** Earth surface mesh when using realistic shaders — used to refresh globe uniforms. */
let earthSurfaceMesh = null;

const _earthCenterScratch = new THREE.Vector3();

const metersPerWorldUnit = 1;
const EARTH_RADIUS = 6700;

// Orthographic globe mapping: sphere center lies R below the north pole on the disk.
// Disk plane is y = -0.14 (earth surface mesh position); picnic stays at origin on that disk.
const EARTH_DISK_Y = -0.14;
const EARTH_SPHERE_CENTER = new THREE.Vector3(
  0,
  EARTH_DISK_Y - EARTH_RADIUS,
  0,
);

// Rotate globe sampling so the disk center (picnic at world origin) sits over
// Athens, Georgia, USA — Piedmont forest / green land on the day map, not ocean.
// (Must match real lat/lon; 30°N / −75°W is open ocean — easy to mistake for “wrong shader”.)
function createGlobeTextureQuaternion() {
  const lat = THREE.MathUtils.degToRad(33.85);
  const lon = THREE.MathUtils.degToRad(-93.36);
  const target = new THREE.Vector3(
    Math.cos(lat) * Math.cos(lon),
    Math.sin(lat),
    Math.cos(lat) * Math.sin(lon),
  ).normalize();
  return new THREE.Quaternion().setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    target,
  );
}

const GLOBE_TEX_QUAT_ROTATE = `
vec3 globeQuatRotate(vec4 q, vec3 v) {
  vec3 t = 2.0 * cross(q.xyz, v);
  return v + q.w * t + cross(q.xyz, t);
}
`;

const EARTH_TEXTURE_URLS = {
  day: "https://raw.githubusercontent.com/mrdoob/three.js/r184/examples/textures/planets/earth_day_4096.jpg",
  clouds:
    "https://raw.githubusercontent.com/mrdoob/three.js/r184/examples/textures/planets/earth_clouds_1024.png",
};

// Furthest scene content (Cosmic Web, galaxy, Oort) sits within ~this distance of
// the origin. Camera looks at origin from +Y; without (distanceWorld + margin) in
// `far`, bodies like the Kuiper belt pop in only once 5*distanceWorld exceeds their
// depth — the "choppy layer" effect.
const SCENE_RADIUS = 90_000_000_000;

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

function smoothT(t) {
  return t * t * (3 - 2 * t);
}

// ============================================================================
// Sprite + procedural texture helpers
// ============================================================================

function loadEarthTextureSet() {
  const loader = new THREE.TextureLoader();
  const loadOne = (url) =>
    new Promise((resolve, reject) => {
      loader.load(url, resolve, undefined, reject);
    });
  return Promise.all([
    loadOne(EARTH_TEXTURE_URLS.day),
    loadOne(EARTH_TEXTURE_URLS.clouds),
  ]).then(([day, clouds]) => {
    for (const t of [day, clouds]) {
      t.anisotropy = maxAniso;
      t.colorSpace = THREE.SRGBColorSpace;
    }
    day.generateMipmaps = true;
    day.minFilter = THREE.LinearMipmapLinearFilter;
    clouds.minFilter = THREE.LinearMipmapLinearFilter;
    day.wrapS = THREE.RepeatWrapping;
    clouds.wrapS = THREE.RepeatWrapping;
    return { day, clouds };
  });
}

const GLOBE_VERT = `
#include <common>
#include <logdepthbuf_pars_vertex>

uniform vec3 uSphereCenter;
uniform float uRadius;
varying vec3 vSphereDir;

void main() {
  vec4 wpos = modelMatrix * vec4(position, 1.0);
  vec2 horiz = wpos.xz - uSphereCenter.xz;
  float xz2 = dot(horiz, horiz);
  float h = sqrt(max(0.0, uRadius * uRadius - xz2));
  vec3 dir = vec3(horiz.x, h, horiz.y) / uRadius;
  vSphereDir = dir;
  gl_Position = projectionMatrix * viewMatrix * wpos;
  #include <logdepthbuf_vertex>
}
`;

function createRealisticEarthMaterial(textures, globeQuat) {
  const uniforms = {
    uSphereCenter: { value: EARTH_SPHERE_CENTER.clone() },
    uRadius: { value: EARTH_RADIUS },
    uGlobeTexQuat: {
      value: new THREE.Vector4(
        globeQuat.x,
        globeQuat.y,
        globeQuat.z,
        globeQuat.w,
      ),
    },
    uDayMap: { value: textures.day },
  };
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: GLOBE_VERT,
    fragmentShader: `
#include <common>
#include <logdepthbuf_pars_fragment>

${GLOBE_TEX_QUAT_ROTATE}

uniform sampler2D uDayMap;
uniform vec4 uGlobeTexQuat;
varying vec3 vSphereDir;

void main() {
  vec3 dir = normalize(globeQuatRotate(uGlobeTexQuat, normalize(vSphereDir)));
  float lambda = atan(dir.z, dir.x);
  float phi = asin(clamp(dir.y, -1.0, 1.0));
  // Equirectangular v: +phi is north. WebGL textures often have image north at high v
  // (Three flipY); use +phi here so the picnic cap matches NASA-style maps.
  vec2 uv = vec2(
    fract(lambda * 0.159154943 + 0.5),
    clamp(0.5 + phi * 0.318309886, 0.001, 0.999)
  );
  gl_FragColor = vec4(texture2D(uDayMap, uv).rgb, 1.0);
  #include <logdepthbuf_fragment>
}
    `,
    lights: false,
    colorSpace: THREE.SRGBColorSpace,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
}

function createRealisticEarthCloudMaterial(
  cloudTex,
  sphereCenterUniform,
  radiusUniform,
  globeQuatUniform,
) {
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uSphereCenter: sphereCenterUniform,
      uRadius: radiusUniform,
      uGlobeTexQuat: globeQuatUniform,
      uCloudMap: { value: cloudTex },
    },
    vertexShader: GLOBE_VERT,
    fragmentShader: `
#include <common>
#include <logdepthbuf_pars_fragment>

${GLOBE_TEX_QUAT_ROTATE}

uniform sampler2D uCloudMap;
uniform vec4 uGlobeTexQuat;
varying vec3 vSphereDir;

void main() {
  vec3 dir = normalize(globeQuatRotate(uGlobeTexQuat, normalize(vSphereDir)));
  float lambda = atan(dir.z, dir.x);
  float phi = asin(clamp(dir.y, -1.0, 1.0));
  vec2 uv = vec2(
    fract(lambda * 0.159154943 + 0.5),
    clamp(0.5 + phi * 0.318309886, 0.001, 0.999)
  );
  vec4 samp = texture2D(uCloudMap, uv);
  float a = max(samp.a, max(samp.r, max(samp.g, samp.b))) * 0.58;
  if (a < 0.03) discard;
  gl_FragColor = vec4(mix(vec3(1.0), samp.rgb, 0.35), a);
  #include <logdepthbuf_fragment>
}
    `,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -4,
    lights: false,
  });
  mat.colorSpace = THREE.SRGBColorSpace;
  return mat;
}

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

function createCloudLayer(
  cloudTex,
  sphereCenterUniform,
  radiusUniform,
  globeQuatUniform,
) {
  const wrapper = new THREE.Group();
  wrapper.name = "earth-clouds";
  wrapper.rotation.x = -Math.PI / 2;
  // Clear separation from the surface in world Y (reduces z-fighting with log depth).
  wrapper.position.y = 22;

  const disk = new THREE.Mesh(
    new THREE.CircleGeometry(EARTH_RADIUS * 0.998, 192),
    createRealisticEarthCloudMaterial(
      cloudTex,
      sphereCenterUniform,
      radiusUniform,
      globeQuatUniform,
    ),
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
// Picnic scale
// ============================================================================

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

function createEarthScale(earthMaps) {
  const group = new THREE.Group();

  if (earthMaps) {
    const globeQuat = createGlobeTextureQuaternion();
    const earthMat = createRealisticEarthMaterial(earthMaps, globeQuat);
    const earth = new THREE.Mesh(
      new THREE.CircleGeometry(EARTH_RADIUS, 384),
      earthMat,
    );
    earth.rotation.x = -Math.PI / 2;
    earth.position.y = EARTH_DISK_Y;
    earth.name = "earth-surface";
    group.add(earth);
    group.add(
      createCloudLayer(
        earthMaps.clouds,
        earthMat.uniforms.uSphereCenter,
        earthMat.uniforms.uRadius,
        earthMat.uniforms.uGlobeTexQuat,
      ),
    );
  } else {
    const earth = new THREE.Mesh(
      new THREE.CircleGeometry(EARTH_RADIUS, 256),
      new THREE.MeshLambertMaterial({ color: 0x143a6b }),
    );
    earth.rotation.x = -Math.PI / 2;
    earth.position.y = EARTH_DISK_Y;
    earth.name = "earth-surface";
    group.add(earth);
  }

  group.add(createAtmosphereRing());
  return group;
}

function createSunWithGlowGroup(sunRadiusWorld, x, z) {
  const g = new THREE.Group();
  g.name = "sun-scale-root";
  g.position.set(x, 0, z);

  // Single disk with limb-only opacity in the fragment shader — no oversized
  // corona geometry (avoids yellow wash); uses log-depth chunks with the renderer.
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
#include <common>
#include <logdepthbuf_pars_vertex>

uniform float uCoreR;
varying float vNormR;
void main() {
  vNormR = length(position.xy) / uCoreR;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}
    `,
    fragmentShader: `
#include <common>
#include <logdepthbuf_pars_fragment>

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
  #include <logdepthbuf_fragment>
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
  group.add(createSunWithGlowGroup(sunRadiusWorld, -780_000, anchorZ - 80_000));

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

function setupScene(earthMaps) {
  // Every factory is added directly to the scene at full opacity. There is
  // no layer-fade orchestration, no per-frame opacity updates, and no name
  // map — once setupScene returns, the scene graph is complete.
  scene.add(createPicnicScale());

  const earth = createEarthScale(earthMaps);
  scene.add(earth);
  // Cache the cloud disk so animate() can spin it without re-traversing.
  cloudDisk = earth.getObjectByName("earth-clouds-disk");
  earthSurfaceMesh = earth.getObjectByName("earth-surface");

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
  // Match logarithmic depth buffer with custom ShaderMaterials (Earth, clouds, sun).
  // Tight near/far still clip—add slack on far and a gentler near scale so less cuts off.
  camera.near = Math.max(1e-6, distanceWorld / 1_000_000);
  camera.far = Math.max(
    100_000,
    distanceWorld + SCENE_RADIUS * 3.25,
    SCENE_RADIUS * 3.25,
    Math.hypot(distanceWorld, SCENE_RADIUS * 2.8) + SCENE_RADIUS * 0.5,
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

  if (earthSurfaceMesh?.material?.uniforms?.uSphereCenter) {
    earthSurfaceMesh.updateWorldMatrix(true, false);
    earthSurfaceMesh.getWorldPosition(_earthCenterScratch);
    earthSurfaceMesh.material.uniforms.uSphereCenter.value.set(
      _earthCenterScratch.x,
      _earthCenterScratch.y - EARTH_RADIUS,
      _earthCenterScratch.z,
    );
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

loadEarthTextureSet()
  .then((maps) => {
    setupScene(maps);
    updateCamera();
    animate();
  })
  .catch((err) => {
    console.warn(
      "Earth textures failed to load; using fallback ocean disk.",
      err,
    );
    setupScene(null);
    updateCamera();
    animate();
  });
