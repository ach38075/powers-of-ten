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
renderer.toneMappingExposure = 1.28;
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

// Single omnidirectional ambient — identical illumination everywhere (Earth disk uses
// unlit day texture; picnic / trees use Lambert & Standard with no directional key).
const ambient = new THREE.AmbientLight(0xf4f7ff, 1.88);
scene.add(ambient);

// Fullscreen fade in front of the camera while passing through the cloud deck
// (avoids global fog, which would wash out the cosmos).
const cloudFadeGeom = new THREE.PlaneGeometry(1, 1);
const cloudFadeMat = new THREE.MeshBasicMaterial({
  color: 0xf2f7fc,
  transparent: true,
  opacity: 0,
  depthTest: false,
  depthWrite: false,
  toneMapped: false,
});
const cloudFadeQuad = new THREE.Mesh(cloudFadeGeom, cloudFadeMat);
cloudFadeQuad.name = "cloud-penetration-fade";
cloudFadeQuad.renderOrder = 32767;
camera.add(cloudFadeQuad);
scene.add(camera);

function refreshCloudFadeQuadSize() {
  const dist = 2.15;
  const vFovRad = THREE.MathUtils.degToRad(camera.fov);
  const planeH = 2 * Math.tan(vFovRad / 2) * dist;
  const planeW = planeH * camera.aspect;
  cloudFadeQuad.scale.set(planeW * 1.15, planeH * 1.15, 1);
  cloudFadeQuad.position.z = -dist;
}
refreshCloudFadeQuadSize();

// ============================================================================
// Constants + state
// ============================================================================

// Direct reference for animated scene content; populated in setupScene().
let cloudDisk = null;
/** Populated by createSunWithGlowGroup — limb shader time uniform */
let sunGlowTimeUniform = null;
/** Earth surface mesh when using realistic shaders — used to refresh globe uniforms. */
let earthSurfaceMesh = null;
/** Picnic trees / towers / bushes / houses — visibility tied to zoom in animate(). */
let picnicSurroundGroup = null;

const _earthCenterScratch = new THREE.Vector3();

// Show surrounding props once the camera has pulled back enough (10^x m).
const PICNIC_SURROUND_REVEAL_START = -10;
const PICNIC_SURROUND_REVEAL_END = 1.15;

const metersPerWorldUnit = 1;
const EARTH_RADIUS = 6700;

// Orthographic globe mapping: sphere center lies R below the north pole on the disk.
// Disk plane is y = -0.14 (earth surface mesh position); picnic stays at origin on that disk.
const EARTH_DISK_Y = -0.14;
/** Cloud deck group Y (world); must match createCloudLayer wrapper.position.y. */
const CLOUD_DISK_WORLD_Y = 70;
/** Descending from space: opacity clears by this height above the deck (m). */
const CLOUD_FADE_SPAN_ABOVE = 100;
/**
 * Below-deck fade uses log10(camera Y): camera moves as 10^exponent, so a linear-Y ramp
 * only spans a tiny exponent window (instant pop). Fade from ~this height (m) up to the deck.
 */
const CLOUD_FADE_NEAR_GROUND_Y = 40;
const EARTH_SPHERE_CENTER = new THREE.Vector3(
  0,
  EARTH_DISK_Y - EARTH_RADIUS,
  0,
);

// Rotate globe sampling so the disk center (picnic + park + city at world origin)
// sits over this lat/lon on the day map (EPSG-style: +N, +E; west longitudes negative).
// Tweaking `lat` / `lon` moves the whole picnic scene on Earth. Examples:
//   Ireland (lush / bright green on many Blue-Marble-style maps): ~53.2°N, 8.0°W
//   Willamette Valley, OR: ~44.9°N, 123.0°W
//   Central NZ (South Island): ~43.8°S ⇒ use negative lat in `Math.sin` / `cos` below.
function createGlobeTextureQuaternion() {
  const lat = THREE.MathUtils.degToRad(53.2);
  const lon = THREE.MathUtils.degToRad(-8.0);
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

/** Initial zoom when the page loads (tight on the blanket). */
const DEFAULT_EXPONENT = -1.2;
/**
 * Tour return altitude: ~10^0.3 m ≈ 2 m camera height so the full picnic
 * blanket fits in a 60° vertical FOV; DEFAULT_EXPONENT is too close for that.
 */
const TOUR_RETURN_EXPONENT = 0.3;
/** Overview landmark (~10^10.65 m) — Enter tour zoom-out stops here; manual zoom shares this ceiling. */
const OVERVIEW_EXPONENT = 10.65;
const maxExponent = OVERVIEW_EXPONENT;
const OVERVIEW_TOUR_OUT_SECONDS = 24;
const OVERVIEW_TOUR_IN_SECONDS = 20;

let exponent = DEFAULT_EXPONENT;
let speed = 0.18;
let direction = 1;
let paused = true;

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
  vec3 c = texture2D(uDayMap, uv).rgb;

  // Display curve on the day texture only: lift dark/baked albedo (ocean, shade)
  // for a more even read on the disk; UVs and mapping unchanged.
  float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float shadow = 1.0 - smoothstep(0.05, 0.4, luma);
  c *= 1.0 + 0.22 * shadow;
  c += vec3(0.014, 0.017, 0.022) * shadow * shadow;
  c = pow(clamp(c, 0.0, 1.0), vec3(0.96));

  gl_FragColor = vec4(c, 1.0);
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
  wrapper.position.y = CLOUD_DISK_WORLD_Y;

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

/**
 * Large urban park (~124 m fenced lawn) around the picnic, then city blocks outside
 * the fence. Spacing is in meters (1 world unit ≈ 1 m).
 */
function createPicnicSurroundings() {
  const group = new THREE.Group();
  group.name = "picnic-surround";

  const dummy = new THREE.Object3D();
  let seed = 582_913;
  const rnd = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 0xffffffff;
  };

  /** Picnic blanket clearance (m). Blanket mesh is 2.2 × 1.4 (±1.1, ±0.7); pad
   * past that so scaled tree trunks / crowns do not read on the blanket. */
  const excludeHalfX = 1.22;
  const excludeHalfZ = 1.00;
  /** Half-size of fenced lawn (full width ≈ ~15.5 m vs original ~124 m). */
  const FENCE_HALF = 7.75;
  /** Fence posts roughly every this many meters along perimeter. */
  const FENCE_POST_SPACING = 2.45;
  // === City grid: axis-aligned blocks around the park ===
  // Park sits at world origin. Outside the fence: a grass strip, then a
  // perimeter ring road, then a square grid of grass lots in 4 quadrants.
  // Major avenues continue along ±x / ±z; narrow streets sit between lots.
  // Sized so streets read as paths, not freeway -- each lot is much wider
  // than the road around it so the city blends with the park instead of
  // floating in asphalt.
  const STRIP_W = 1.5;
  const RING_ROAD_W = 1.4;
  const BLOCK_W = 7.2;
  const STREET_W = 1.0;
  const RINGS = 3;
  const RING_ROAD_INNER = FENCE_HALF + STRIP_W;
  const RING_ROAD_OUTER = RING_ROAD_INNER + RING_ROAD_W;
  const BLOCK_PITCH = BLOCK_W + STREET_W;
  const ASPHALT_Y = 0.006;
  const LAWN_Y = 0.014;
  const lotAxisCenter = (n) =>
    RING_ROAD_OUTER + STREET_W / 2 + n * BLOCK_PITCH + BLOCK_W / 2;
  // City extent ends flush with the outer block edge -- no trailing
  // half-street outside the last ring (cuts the asphalt frame down a lot).
  const CITY_HALF = lotAxisCenter(RINGS - 1) + BLOCK_W / 2;

  /** One descriptor per sidewalk lot: lot center + ring index (0=closest to park). */
  const cityBlocks = [];
  for (let qi = 0; qi < RINGS; qi += 1) {
    for (let qj = 0; qj < RINGS; qj += 1) {
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          cityBlocks.push({
            cx: sx * lotAxisCenter(qi),
            cz: sz * lotAxisCenter(qj),
            ring: Math.max(qi, qj),
          });
        }
      }
    }
  }

  function inPicnicExclusion(x, z) {
    return Math.abs(x) < excludeHalfX && Math.abs(z) < excludeHalfZ;
  }

  /** Uniform point on the lawn, not on the blanket. */
  function sampleParkLawn() {
    const inset = 1.0;
    const lim = FENCE_HALF - inset;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const x = (rnd() * 2 - 1) * lim;
      const z = (rnd() * 2 - 1) * lim;
      if (inPicnicExclusion(x, z)) continue;
      return { x, z };
    }
    return { x: lim * 0.6, z: lim * 0.35 };
  }

  /** Post i of n around a square from (-H,-H) to (H,H), CCW from bottom edge. */
  function fencePostXZ(index, count, H) {
    const side = 2 * H;
    let u = (index / count) * (8 * H);
    if (u < side) {
      return { x: -H + u, z: -H };
    }
    u -= side;
    if (u < side) {
      return { x: H, z: -H + u };
    }
    u -= side;
    if (u < side) {
      return { x: H - u, z: H };
    }
    u -= side;
    return { x: -H, z: H - u };
  }

  const fencePostCount = Math.max(
    48,
    Math.round((8 * FENCE_HALF) / FENCE_POST_SPACING),
  );
  const postGeom = new THREE.BoxGeometry(0.15, 1.08, 0.15);
  postGeom.translate(0, 0.54, 0);
  const postMat = new THREE.MeshStandardMaterial({
    color: 0x6d5c48,
    roughness: 0.62,
    metalness: 0.06,
    emissive: 0x2a2218,
    emissiveIntensity: 0.1,
  });
  const fencePosts = new THREE.InstancedMesh(postGeom, postMat, fencePostCount);
  fencePosts.frustumCulled = false;
  for (let i = 0; i < fencePostCount; i += 1) {
    const { x, z } = fencePostXZ(i, fencePostCount, FENCE_HALF);
    dummy.rotation.set(0, rnd() * 0.06 - 0.03, 0);
    dummy.scale.setScalar(0.9 + rnd() * 0.14);
    dummy.position.set(x, 0, z);
    dummy.updateMatrix();
    fencePosts.setMatrixAt(i, dummy.matrix);
  }
  fencePosts.instanceMatrix.needsUpdate = true;
  group.add(fencePosts);

  const railGeom = new THREE.BoxGeometry(1, 1, 1);
  const railMat = new THREE.MeshStandardMaterial({
    color: 0x8f826e,
    roughness: 0.5,
    metalness: 0.07,
    emissive: 0x3a3228,
    emissiveIntensity: 0.09,
  });
  const railY = 0.84;
  const railT = 0.078;
  const railW = 0.17;
  const sideLen = 2 * FENCE_HALF;
  const addRail = (sx, sy, sz, px, py, pz) => {
    const m = new THREE.Mesh(railGeom, railMat);
    m.scale.set(sx, sy, sz);
    m.position.set(px, py, pz);
    group.add(m);
  };
  addRail(sideLen + railW, railT, railW, 0, railY, -FENCE_HALF);
  addRail(sideLen + railW, railT, railW, 0, railY, FENCE_HALF);
  addRail(railW, railT, sideLen + railW, -FENCE_HALF, railY, 0);
  addRail(railW, railT, sideLen + railW, FENCE_HALF, railY, 0);
  addRail(sideLen + railW, railT, railW, 0, railY - 0.34, -FENCE_HALF);
  addRail(sideLen + railW, railT, railW, 0, railY - 0.34, FENCE_HALF);
  addRail(railW, railT, sideLen + railW, -FENCE_HALF, railY - 0.34, 0);
  addRail(railW, railT, sideLen + railW, FENCE_HALF, railY - 0.34, 0);

  // === Roads ===
  // Warm gravel rather than highway-black so the streets read as a small
  // village, not a downtown grid. Drawn as explicit strips (ring road +
  // streets between blocks + 4 axis avenues) so the visible asphalt is just
  // the road network -- everything else is lawn.
  const roadGeom = new THREE.BoxGeometry(1, 0.005, 1);
  const roadMat = new THREE.MeshLambertMaterial({
    color: 0x4f463a,
    emissive: 0x231d14,
    emissiveIntensity: 0.28,
  });
  const addRoadStrip = (x0, z0, x1, z1) => {
    const w = x1 - x0;
    const d = z1 - z0;
    if (w <= 0 || d <= 0) return;
    const m = new THREE.Mesh(roadGeom, roadMat);
    m.scale.set(w, 1, d);
    m.position.set((x0 + x1) / 2, ASPHALT_Y, (z0 + z1) / 2);
    group.add(m);
  };

  // Ring road around the park (4 strips forming a square donut).
  addRoadStrip(-RING_ROAD_OUTER, RING_ROAD_INNER, RING_ROAD_OUTER, RING_ROAD_OUTER);
  addRoadStrip(-RING_ROAD_OUTER, -RING_ROAD_OUTER, RING_ROAD_OUTER, -RING_ROAD_INNER);
  addRoadStrip(-RING_ROAD_OUTER, -RING_ROAD_INNER, -RING_ROAD_INNER, RING_ROAD_INNER);
  addRoadStrip(RING_ROAD_INNER, -RING_ROAD_INNER, RING_ROAD_OUTER, RING_ROAD_INNER);

  // Streets between block columns (and the half-street next to the ring road).
  // Each entry is one street center on the +axis side; reflected to -axis.
  const streetSegs = [
    { c: RING_ROAD_OUTER + STREET_W / 4, halfW: STREET_W / 4 },
  ];
  for (let n = 0; n < RINGS - 1; n += 1) {
    streetSegs.push({
      c: lotAxisCenter(n) + BLOCK_W / 2 + STREET_W / 2,
      halfW: STREET_W / 2,
    });
  }

  for (const sign of [-1, 1]) {
    for (const seg of streetSegs) {
      const sCenter = sign * seg.c;
      // Vertical street (constant x, runs both +z and -z halves).
      addRoadStrip(
        sCenter - seg.halfW,
        RING_ROAD_INNER,
        sCenter + seg.halfW,
        CITY_HALF,
      );
      addRoadStrip(
        sCenter - seg.halfW,
        -CITY_HALF,
        sCenter + seg.halfW,
        -RING_ROAD_INNER,
      );
      // Horizontal street (constant z).
      addRoadStrip(
        RING_ROAD_INNER,
        sCenter - seg.halfW,
        CITY_HALF,
        sCenter + seg.halfW,
      );
      addRoadStrip(
        -CITY_HALF,
        sCenter - seg.halfW,
        -RING_ROAD_INNER,
        sCenter + seg.halfW,
      );
    }
  }
  // Major avenues continuing along the ±x and ±z axes between quadrants.
  addRoadStrip(-CITY_HALF, -STREET_W / 2, -RING_ROAD_OUTER, STREET_W / 2);
  addRoadStrip(RING_ROAD_OUTER, -STREET_W / 2, CITY_HALF, STREET_W / 2);
  addRoadStrip(-STREET_W / 2, -CITY_HALF, STREET_W / 2, -RING_ROAD_OUTER);
  addRoadStrip(-STREET_W / 2, RING_ROAD_OUTER, STREET_W / 2, CITY_HALF);

  // === Lawn lots (one grass square per lot — buildings/houses sit on these) ===
  const lawnGeom = new THREE.BoxGeometry(BLOCK_W, 0.006, BLOCK_W);
  const lawnMat = new THREE.MeshLambertMaterial({
    color: 0x6cae5c,
    emissive: 0x244c1c,
    emissiveIntensity: 0.32,
  });
  const lawns = new THREE.InstancedMesh(
    lawnGeom,
    lawnMat,
    cityBlocks.length,
  );
  lawns.frustumCulled = false;
  for (let i = 0; i < cityBlocks.length; i += 1) {
    const { cx, cz } = cityBlocks[i];
    dummy.rotation.set(0, 0, 0);
    dummy.scale.setScalar(1);
    dummy.position.set(cx, LAWN_Y, cz);
    dummy.updateMatrix();
    lawns.setMatrixAt(i, dummy.matrix);
  }
  lawns.instanceMatrix.needsUpdate = true;
  group.add(lawns);

  // Street trees at the four corners of every sidewalk lot.
  const streetTrees = [];
  for (const block of cityBlocks) {
    const cornerInset = 0.45;
    const ex = BLOCK_W / 2 - cornerInset;
    streetTrees.push(
      { x: block.cx - ex, z: block.cz - ex },
      { x: block.cx + ex, z: block.cz - ex },
      { x: block.cx - ex, z: block.cz + ex },
      { x: block.cx + ex, z: block.cz + ex },
    );
  }

  // Trees outside the built-up square — sparse scatter in a wide belt (same
  // count as before: target is derived from a fixed reference extent, not the
  // wider sample box, so widening does not add instances).
  const outerTreeRefHalf = CITY_HALF + 18;
  const outerTreeTarget = Math.max(
    72,
    Math.round((8 * outerTreeRefHalf) / 2.8),
  );
  const OUTER_TREE_INNER = CITY_HALF + 1.2;
  const OUTER_TREE_OUTER = CITY_HALF + 46;
  const outerCityTrees = [];
  for (
    let attempt = 0;
    outerCityTrees.length < outerTreeTarget && attempt < 40_000;
    attempt += 1
  ) {
    const x = (rnd() * 2 - 1) * OUTER_TREE_OUTER;
    const z = (rnd() * 2 - 1) * OUTER_TREE_OUTER;
    const cheb = Math.max(Math.abs(x), Math.abs(z));
    if (cheb < OUTER_TREE_INNER) continue;
    const jx = (rnd() - 0.5) * 1.75;
    const jz = (rnd() - 0.5) * 1.75;
    const nx = x + jx;
    const nz = z + jz;
    if (Math.max(Math.abs(nx), Math.abs(nz)) < OUTER_TREE_INNER) continue;
    if (Math.max(Math.abs(nx), Math.abs(nz)) > OUTER_TREE_OUTER + 1.4) continue;
    outerCityTrees.push({ x: nx, z: nz });
  }

  const cityTreePositions = streetTrees.concat(outerCityTrees);
  const trunkH = 0.86;
  const crownH = 1.22;
  const treeCountPark = 20;
  const treeCountCity = cityTreePositions.length;
  const treeCount = treeCountPark + treeCountCity;
  const trunkGeom = new THREE.CylinderGeometry(0.1, 0.125, trunkH, 7);
  const crownGeom = new THREE.ConeGeometry(0.55, crownH, 8);
  const trunkMat = new THREE.MeshLambertMaterial({
    color: 0x7a5a42,
    emissive: 0x3a2820,
    emissiveIntensity: 0.22,
  });
  const treeCrownMat = new THREE.MeshLambertMaterial({
    color: 0x4da668,
    emissive: 0x1e5030,
    emissiveIntensity: 0.28,
  });
  const treeTrunks = new THREE.InstancedMesh(trunkGeom, trunkMat, treeCount);
  const treeCrowns = new THREE.InstancedMesh(
    crownGeom,
    treeCrownMat,
    treeCount,
  );
  treeTrunks.frustumCulled = false;
  treeCrowns.frustumCulled = false;

  for (let i = 0; i < treeCount; i += 1) {
    const cityIdx = i - treeCountPark;
    const isCity = cityIdx >= 0;
    const pos = isCity ? cityTreePositions[cityIdx] : sampleParkLawn();
    const { x, z } = pos;
    const isStreetLotTree = isCity && cityIdx < streetTrees.length;
    const s = isCity
      ? isStreetLotTree
        ? 0.7 + rnd() * 0.3
        : 1.02 + rnd() * 0.72
      : 1.05 + rnd() * 1.12;
    const baseY = isCity ? (isStreetLotTree ? LAWN_Y : 0) : 0;
    const ry = rnd() * Math.PI * 2;
    dummy.rotation.set(0, ry, 0);
    dummy.scale.setScalar(s);
    dummy.position.set(x, baseY + trunkH * 0.5 * s, z);
    dummy.updateMatrix();
    treeTrunks.setMatrixAt(i, dummy.matrix);
    dummy.position.set(x, baseY + (trunkH + crownH * 0.5) * s, z);
    dummy.updateMatrix();
    treeCrowns.setMatrixAt(i, dummy.matrix);
  }
  treeTrunks.instanceMatrix.needsUpdate = true;
  treeCrowns.instanceMatrix.needsUpdate = true;
  group.add(treeTrunks, treeCrowns);

  // === Commercial buildings on inner rings (closest to the park) ===
  // Each lot picks a random site plan (one big building, two side-by-side, or
  // 3-4 small ones on a 2x2 sub-grid). Per-building rotation, footprint, and
  // position jitter keep adjacent blocks from looking stamped.
  const COMMERCIAL_PALETTE = [
    0xff8a72, 0xffd166, 0x7ec4cf, 0xa3e4a8, 0xb8a4dc, 0xffb482, 0xffd1dc,
    0x90c8e8, 0xff9bb3, 0xb6e388, 0xf6c453, 0xfcb1a6, 0xa9e0d4,
  ];
  const pickCommercialColor = () =>
    COMMERCIAL_PALETTE[Math.floor(rnd() * COMMERCIAL_PALETTE.length)];
  const lotInset = 0.85;
  const lotSide = BLOCK_W - 2 * lotInset;
  const subSide = lotSide / 2;
  const subOff = subSide / 2;
  const buildingCells = [];
  for (const block of cityBlocks) {
    if (block.ring > 1) continue;
    const plan = rnd();
    if (plan < 0.22) {
      buildingCells.push({
        x: block.cx + (rnd() - 0.5) * 0.5,
        z: block.cz + (rnd() - 0.5) * 0.5,
        w: lotSide * (0.55 + rnd() * 0.18),
        d: lotSide * (0.55 + rnd() * 0.18),
        ry: (rnd() - 0.5) * 0.36,
        ring: block.ring,
        colorHex: pickCommercialColor(),
      });
    } else if (plan < 0.5) {
      const alongX = rnd() < 0.5;
      for (const s of [-1, 1]) {
        buildingCells.push({
          x: block.cx + (alongX ? s * subOff : (rnd() - 0.5) * 0.6),
          z: block.cz + (alongX ? (rnd() - 0.5) * 0.6 : s * subOff),
          w: (alongX ? subSide : lotSide * 0.5) * (0.7 + rnd() * 0.2),
          d: (alongX ? lotSide * 0.5 : subSide) * (0.7 + rnd() * 0.2),
          ry: (rnd() - 0.5) * 0.32,
          ring: block.ring,
          colorHex: pickCommercialColor(),
        });
      }
    } else {
      const dropRate = plan < 0.78 ? 0.28 : 0.05;
      for (const si of [-1, 1]) {
        for (const sj of [-1, 1]) {
          if (rnd() < dropRate) continue;
          buildingCells.push({
            x: block.cx + si * subOff + (rnd() - 0.5) * 0.4,
            z: block.cz + sj * subOff + (rnd() - 0.5) * 0.4,
            w: subSide * (0.62 + rnd() * 0.32),
            d: subSide * (0.62 + rnd() * 0.32),
            ry: (rnd() - 0.5) * 0.36,
            ring: block.ring,
            colorHex: pickCommercialColor(),
          });
        }
      }
    }
  }

  const buildingCount = buildingCells.length;
  const buildingGeom = new THREE.BoxGeometry(1, 1, 1);
  const buildingMat = new THREE.MeshLambertMaterial({
    color: 0xffffff,
    vertexColors: true,
    emissive: 0x4a4a52,
    emissiveIntensity: 0.45,
  });
  const towerCrownMat = new THREE.MeshLambertMaterial({
    color: 0xffffff,
    vertexColors: true,
    emissive: 0x787880,
    emissiveIntensity: 0.55,
  });
  const buildings = new THREE.InstancedMesh(
    buildingGeom,
    buildingMat,
    buildingCount,
  );
  const buildingCrowns = new THREE.InstancedMesh(
    buildingGeom,
    towerCrownMat,
    buildingCount,
  );
  buildings.frustumCulled = false;
  buildingCrowns.frustumCulled = false;
  const bColor = new THREE.Color();
  const crownTint = new THREE.Color();
  const tmpWhite = new THREE.Color(1, 1, 1);

  for (let i = 0; i < buildingCount; i += 1) {
    const cell = buildingCells[i];
    const bx = cell.w;
    const bz = cell.d;
    const bh = cell.ring === 0 ? 1.8 + rnd() * 2.4 : 1.2 + rnd() * 1.4;

    dummy.rotation.set(0, cell.ry, 0);
    dummy.scale.set(bx, bh, bz);
    dummy.position.set(cell.x, LAWN_Y + bh / 2, cell.z);
    dummy.updateMatrix();
    buildings.setMatrixAt(i, dummy.matrix);

    bColor.setHex(cell.colorHex);
    buildings.setColorAt(i, bColor);

    const topCrownH = Math.min(0.34, 0.085 + rnd() * 0.14 + bh * 0.04);
    const crownScale = 0.86 + rnd() * 0.08;
    dummy.rotation.set(0, cell.ry, 0);
    dummy.scale.set(bx * crownScale, topCrownH, bz * crownScale);
    dummy.position.set(cell.x, LAWN_Y + bh - topCrownH * 0.5, cell.z);
    dummy.updateMatrix();
    buildingCrowns.setMatrixAt(i, dummy.matrix);

    crownTint.copy(bColor).lerp(tmpWhite, 0.5).multiplyScalar(1.12);
    crownTint.r = Math.min(1, crownTint.r);
    crownTint.g = Math.min(1, crownTint.g);
    crownTint.b = Math.min(1, crownTint.b);
    buildingCrowns.setColorAt(i, crownTint);
  }
  buildings.instanceMatrix.needsUpdate = true;
  buildingCrowns.instanceMatrix.needsUpdate = true;
  if (buildings.instanceColor) {
    buildings.instanceColor.needsUpdate = true;
  }
  if (buildingCrowns.instanceColor) {
    buildingCrowns.instanceColor.needsUpdate = true;
  }
  group.add(buildings, buildingCrowns);

  const bushCount = 6;
  const bushGeom = new THREE.IcosahedronGeometry(0.24, 0);
  const bushMat = new THREE.MeshLambertMaterial({
    color: 0x228b22,
  });
  const bushes = new THREE.InstancedMesh(bushGeom, bushMat, bushCount);
  bushes.frustumCulled = false;
  const bushColor = new THREE.Color();

  for (let i = 0; i < bushCount; i += 1) {
    const { x, z } = sampleParkLawn();
    const sx = 0.95 + rnd() * 1.15;
    const sy = 0.55 + rnd() * 0.5;
    const sz = 0.95 + rnd() * 1.15;
    const ry = rnd() * Math.PI * 2;
    dummy.rotation.set(0, ry, rnd() * 0.18 - 0.09);
    dummy.scale.set(sx, sy, sz);
    dummy.position.set(x, 0.24 * sy, z);
    dummy.updateMatrix();
    bushes.setMatrixAt(i, dummy.matrix);

    // const g = 0.22 + rnd() * 0.18;
    // bushColor.setRGB(0.12 + g * 0.35, 0.42 + g * 0.35, 0.14 + g * 0.12);
    // bushes.setColorAt(i, bushColor);
  }
  bushes.instanceMatrix.needsUpdate = true;
  if (bushes.instanceColor) {
    bushes.instanceColor.needsUpdate = true;
  }
  group.add(bushes);

  const benchCount = 0;
  const benchSeatMat = new THREE.MeshStandardMaterial({
    color: 0x9c8b6e,
    roughness: 0.55,
    metalness: 0.04,
    emissive: 0x4a4034,
    emissiveIntensity: 0.11,
  });
  const benchBackMat = new THREE.MeshStandardMaterial({
    color: 0x8a7a60,
    roughness: 0.56,
    metalness: 0.04,
    emissive: 0x3e362c,
    emissiveIntensity: 0.1,
  });
  const benchGeom = new THREE.BoxGeometry(1, 1, 1);
  const benchSeats = new THREE.InstancedMesh(
    benchGeom,
    benchSeatMat,
    benchCount,
  );
  const benchBacks = new THREE.InstancedMesh(
    benchGeom,
    benchBackMat,
    benchCount,
  );
  benchSeats.frustumCulled = false;
  benchBacks.frustumCulled = false;
  const benchInset = 0.875;
  const spanHalf = FENCE_HALF - benchInset - 1.375;
  const cols = 8;
  const xAlong = (k) => -spanHalf + (k / (cols - 1)) * (2 * spanHalf);
  let benchIdx = 0;
  const placeBenchRow = (xFn, zFn, ry) => {
    for (let k = 0; k < cols; k += 1) {
      const bx = xFn(k);
      const bz = zFn(k);
      const seatY = 0.46;
      const forwardX = Math.sin(ry);
      const forwardZ = Math.cos(ry);
      dummy.rotation.set(0, ry, 0);
      dummy.scale.set(1.88, 0.065, 0.54);
      dummy.position.set(bx, seatY, bz);
      dummy.updateMatrix();
      benchSeats.setMatrixAt(benchIdx, dummy.matrix);
      const backY = seatY + 0.21;
      const bd = 0.27;
      dummy.scale.set(1.88, 0.42, 0.065);
      dummy.position.set(bx - forwardX * bd, backY, bz - forwardZ * bd);
      dummy.updateMatrix();
      benchBacks.setMatrixAt(benchIdx, dummy.matrix);
      benchIdx += 1;
    }
  };
  placeBenchRow(
    (k) => xAlong(k),
    () => -FENCE_HALF + benchInset,
    Math.PI,
  );
  placeBenchRow(
    (k) => xAlong(k),
    () => FENCE_HALF - benchInset,
    0,
  );
  placeBenchRow(
    () => -FENCE_HALF + benchInset,
    (k) => xAlong(k),
    -Math.PI / 2,
  );
  placeBenchRow(
    () => FENCE_HALF - benchInset,
    (k) => xAlong(k),
    Math.PI / 2,
  );
  benchSeats.instanceMatrix.needsUpdate = true;
  benchBacks.instanceMatrix.needsUpdate = true;
  group.add(benchSeats, benchBacks);

  // === Small houses on the outer ring (peaked roofs, bright pastel walls) ===
  // Brighter pastels + warmer roof palette so they read as cottages from above.
  const HOUSE_PALETTE = [
    0xfff3c4, 0xffe18a, 0xffb3a3, 0xc6e6ff, 0xe5cdf5, 0xc6e8a8, 0xffeab0,
    0xffd9bf, 0xffd1dc, 0xd6ecff, 0xfff0a8, 0xdaf0c8, 0xffc8a8, 0xc4f0d4,
  ];
  const ROOF_PALETTE = [
    0xd87056, 0x7a96ad, 0x68987c, 0xc25040, 0xa67060, 0x8a7a98, 0x5d758f,
    0xb86a52, 0xa45848, 0x6e8a72,
  ];
  const houseCells = [];
  for (const block of cityBlocks) {
    if (block.ring < 2) continue;
    const plan = rnd();
    if (plan < 0.18) {
      // Single bigger house centered on the lot.
      houseCells.push({
        x: block.cx + (rnd() - 0.5) * 0.5,
        z: block.cz + (rnd() - 0.5) * 0.5,
        w: lotSide * (0.5 + rnd() * 0.16),
        d: lotSide * (0.5 + rnd() * 0.16),
        ry: (rnd() - 0.5) * 0.4,
        wallHex: HOUSE_PALETTE[Math.floor(rnd() * HOUSE_PALETTE.length)],
        roofHex: ROOF_PALETTE[Math.floor(rnd() * ROOF_PALETTE.length)],
      });
    } else if (plan < 0.42) {
      // Two side-by-side houses.
      const alongX = rnd() < 0.5;
      for (const s of [-1, 1]) {
        houseCells.push({
          x: block.cx + (alongX ? s * subOff : (rnd() - 0.5) * 0.5),
          z: block.cz + (alongX ? (rnd() - 0.5) * 0.5 : s * subOff),
          w: subSide * (0.74 + rnd() * 0.18),
          d: subSide * (0.74 + rnd() * 0.18),
          ry: (rnd() - 0.5) * 0.4,
          wallHex: HOUSE_PALETTE[Math.floor(rnd() * HOUSE_PALETTE.length)],
          roofHex: ROOF_PALETTE[Math.floor(rnd() * ROOF_PALETTE.length)],
        });
      }
    } else {
      // Three or four small cottages.
      const dropRate = plan < 0.72 ? 0.32 : 0.08;
      for (const si of [-1, 1]) {
        for (const sj of [-1, 1]) {
          if (rnd() < dropRate) continue;
          houseCells.push({
            x: block.cx + si * subOff + (rnd() - 0.5) * 0.45,
            z: block.cz + sj * subOff + (rnd() - 0.5) * 0.45,
            w: subSide * (0.62 + rnd() * 0.3),
            d: subSide * (0.62 + rnd() * 0.3),
            ry: (rnd() - 0.5) * 0.45,
            wallHex: HOUSE_PALETTE[Math.floor(rnd() * HOUSE_PALETTE.length)],
            roofHex: ROOF_PALETTE[Math.floor(rnd() * ROOF_PALETTE.length)],
          });
        }
      }
    }
  }

  const houseCount = houseCells.length;
  const houseBoxGeom = new THREE.BoxGeometry(1, 1, 1);
  // Square pyramid (4-sided cone with side faces aligned to x/z axes after
  // a 45° yaw): unit-cube base when scaled by (w, h, d).
  const houseRoofGeom = new THREE.ConeGeometry(Math.SQRT1_2, 1, 4);
  houseRoofGeom.rotateY(Math.PI / 4);
  const houseBodyMat = new THREE.MeshLambertMaterial({
    color: 0xffffff,
    vertexColors: true,
    emissive: 0x6a584a,
    emissiveIntensity: 0.4,
  });
  const houseRoofMat = new THREE.MeshLambertMaterial({
    color: 0xffffff,
    vertexColors: true,
    emissive: 0x4a3428,
    emissiveIntensity: 0.42,
  });
  const houseTrimMat = new THREE.MeshLambertMaterial({
    color: 0xfff5e0,
    emissive: 0xc8b894,
    emissiveIntensity: 0.5,
  });
  const houseBodies = new THREE.InstancedMesh(
    houseBoxGeom,
    houseBodyMat,
    houseCount,
  );
  const houseRoofs = new THREE.InstancedMesh(
    houseRoofGeom,
    houseRoofMat,
    houseCount,
  );
  const houseTrims = new THREE.InstancedMesh(
    houseBoxGeom,
    houseTrimMat,
    houseCount,
  );
  houseBodies.frustumCulled = false;
  houseRoofs.frustumCulled = false;
  houseTrims.frustumCulled = false;
  const wallCol = new THREE.Color();
  const roofCol = new THREE.Color();

  for (let i = 0; i < houseCount; i += 1) {
    const cell = houseCells[i];
    const w = cell.w;
    const d = cell.d;
    const bodyH = 0.7 + rnd() * 0.6;
    const roofH = 0.4 + rnd() * 0.4;
    const trimH = 0.05;

    dummy.rotation.set(0, cell.ry, 0);
    dummy.scale.set(w, bodyH, d);
    dummy.position.set(cell.x, LAWN_Y + bodyH / 2, cell.z);
    dummy.updateMatrix();
    houseBodies.setMatrixAt(i, dummy.matrix);

    dummy.scale.set(w * 1.04, trimH, d * 1.04);
    dummy.position.set(cell.x, LAWN_Y + bodyH + trimH / 2, cell.z);
    dummy.updateMatrix();
    houseTrims.setMatrixAt(i, dummy.matrix);

    dummy.scale.set(w * 1.06, roofH, d * 1.06);
    dummy.position.set(cell.x, LAWN_Y + bodyH + trimH + roofH / 2, cell.z);
    dummy.updateMatrix();
    houseRoofs.setMatrixAt(i, dummy.matrix);

    wallCol.setHex(cell.wallHex);
    houseBodies.setColorAt(i, wallCol);
    roofCol.setHex(cell.roofHex);
    houseRoofs.setColorAt(i, roofCol);
  }
  houseBodies.instanceMatrix.needsUpdate = true;
  houseRoofs.instanceMatrix.needsUpdate = true;
  houseTrims.instanceMatrix.needsUpdate = true;
  if (houseBodies.instanceColor) {
    houseBodies.instanceColor.needsUpdate = true;
  }
  if (houseRoofs.instanceColor) {
    houseRoofs.instanceColor.needsUpdate = true;
  }
  group.add(houseBodies, houseTrims, houseRoofs);

  // === Yard greenery on commercial+residential lots (homier feel) ===
  // Random bush sprinkles inside each lot. Some overlap with buildings is
  // intentional -- reads as foundation plantings / front-yard shrubs.
  const yardBushPositions = [];
  for (const block of cityBlocks) {
    if (block.ring < 1) continue; // skip the small "downtown" core
    const cnt = block.ring === 2
      ? 3 + Math.floor(rnd() * 3)
      : 1 + Math.floor(rnd() * 2);
    for (let n = 0; n < cnt; n += 1) {
      const ox = (rnd() - 0.5) * (BLOCK_W - 0.6);
      const oz = (rnd() - 0.5) * (BLOCK_W - 0.6);
      yardBushPositions.push({ x: block.cx + ox, z: block.cz + oz });
    }
  }
  const yardBushCount = yardBushPositions.length;
  if (yardBushCount > 0) {
    const yardBushGeom = new THREE.IcosahedronGeometry(0.18, 0);
    const yardBushMat = new THREE.MeshLambertMaterial({
      color: 0xffffff,
      vertexColors: true,
      emissive: 0x224a1a,
      emissiveIntensity: 0.34,
    });
    const yardBushes = new THREE.InstancedMesh(
      yardBushGeom,
      yardBushMat,
      yardBushCount,
    );
    yardBushes.frustumCulled = false;
    const ybColor = new THREE.Color();
    for (let i = 0; i < yardBushCount; i += 1) {
      const p = yardBushPositions[i];
      const sx = 0.7 + rnd() * 0.6;
      const sy = 0.5 + rnd() * 0.4;
      const sz = 0.7 + rnd() * 0.6;
      dummy.rotation.set(0, rnd() * Math.PI * 2, rnd() * 0.18 - 0.09);
      dummy.scale.set(sx, sy, sz);
      dummy.position.set(p.x, LAWN_Y + 0.18 * sy, p.z);
      dummy.updateMatrix();
      yardBushes.setMatrixAt(i, dummy.matrix);
      const t = 0.18 + rnd() * 0.32;
      ybColor.setRGB(0.18 + t * 0.4, 0.42 + t * 0.45, 0.18 + t * 0.32);
      yardBushes.setColorAt(i, ybColor);
    }
    yardBushes.instanceMatrix.needsUpdate = true;
    if (yardBushes.instanceColor) {
      yardBushes.instanceColor.needsUpdate = true;
    }
    group.add(yardBushes);
  }

  return group;
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
  for (let ix = -5; ix <= 5; ix += 1) {
    for (let iz = -3; iz <= 3; iz += 1) {
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

  const surround = createPicnicSurroundings();
  picnicSurroundGroup = surround;
  group.add(surround);

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
  // Earth / picnic sit near y≈0; camera is on +Y looking toward origin. The
  // spiral used large negative Y, so arm stars and bright spheres sat past
  // Earth along −Y and depth-tested behind the globe. Lift all Y samples so
  // the dense arm plane (worst-case downward noise) clears +y with margin.
  const armSpreadHalf = 0.5 * (460_000_000 + galaxyRadius * 0.05);
  const armPlaneY = galacticCenter.y + denseLayerY;
  const galacticYLift = -(armPlaneY - armSpreadHalf) + 85_000_000;

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
        (Math.random() - 0.5) * (460_000_000 + radius * 0.05) +
        galacticYLift;
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
      (Math.random() - 0.5) * (380_000_000 + radius * 0.04) +
      galacticYLift;
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
      (Math.random() - 0.5) * (320_000_000 + radius * 0.03) +
      galacticYLift;
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
        (Math.random() - 0.5) * (420_000_000 + radius * 0.04) +
        galacticYLift,
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
    galacticCenter.y + denseLayerY + galacticYLift,
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
  camera.position.set(0, distanceWorld + 0.5, 0);
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

function updateCloudPenetrationFade() {
  const deckExp = Math.log10(CLOUD_DISK_WORLD_Y);

  const belowExp = Math.log10(CLOUD_FADE_NEAR_GROUND_Y);
  const aboveExp = Math.log10(CLOUD_DISK_WORLD_Y + CLOUD_FADE_SPAN_ABOVE);

  const fadeIn = THREE.MathUtils.smoothstep(exponent, belowExp, deckExp);

  const fadeOut = 1 - THREE.MathUtils.smoothstep(exponent, deckExp, aboveExp);

  const k = THREE.MathUtils.clamp(fadeIn * fadeOut, 0, 1);

  cloudFadeMat.opacity = THREE.MathUtils.smootherstep(k, 0, 1) * 0.9;
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

if (picnicSurroundGroup) {
  const t = THREE.MathUtils.smoothstep(
    exponent,
    PICNIC_SURROUND_REVEAL_START,
    PICNIC_SURROUND_REVEAL_END,
  );

  picnicSurroundGroup.visible = t > 0.01;
  picnicSurroundGroup.scale.setScalar(THREE.MathUtils.lerp(0.001, 1.0, t));
}

  updateCamera();
  updateCloudPenetrationFade();

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
  refreshCloudFadeQuadSize();
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
