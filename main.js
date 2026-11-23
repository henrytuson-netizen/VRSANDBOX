import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { createPowers } from './powers.js';
import { createTools } from './tools.js';
import { createCommandMenu } from './menu.js';
import { createAmbience } from './ambience.js';
import { createSpiderSense } from './spidersense.js';
import { createEnemies } from './enemies.js';
import { cityBlocks } from './city.js';
import { createSound } from './sound.js';
import { createCalibration } from './calibrate.js';
import { TUNING } from './powers.js';
import { loadSettings, saveSettings, isComfortMode, COMFORT_PRESET, DEFAULT_SETTINGS } from './settings.js';
import { createComfort } from './comfort.js';

// ---------------------------------------------------------------------------
// Renderer + XR
// ---------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
document.body.appendChild(renderer.domElement);

// VRButton in three r160 already requests hand-tracking as an optional feature.
document.body.appendChild(VRButton.createButton(renderer));

// ---------------------------------------------------------------------------
// Scene, camera, player rig
// The camera and all XR input objects live under `player`, so moving or
// turning the player moves the whole user (headset, hands, controllers).
// ---------------------------------------------------------------------------
const BACKGROUND = 0x1d2026;

const scene = new THREE.Scene();
scene.background = new THREE.Color(BACKGROUND);
scene.fog = new THREE.Fog(BACKGROUND, 25, 140);

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 250);
camera.position.set(0, 1.6, 0); // desktop eye height; XR overrides this with the headset pose

const player = new THREE.Group();
scene.add(player);
player.add(camera);

const hemi = new THREE.HemisphereLight(0xffffff, 0x404050, 1.4);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffffff, 1.2);
sun.position.set(3, 6, 2);
scene.add(sun);

// ---------------------------------------------------------------------------
// Unity-style default grid texture (procedural, no downloads).
// ---------------------------------------------------------------------------
function makeGridTexture(repeat = 1) {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#c7c7c7';
  ctx.fillRect(0, 0, size, size);

  ctx.strokeStyle = '#b4b4b4';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(size / 2, 0); ctx.lineTo(size / 2, size);
  ctx.moveTo(0, size / 2); ctx.lineTo(size, size / 2);
  ctx.stroke();

  ctx.strokeStyle = '#8c8c8c';
  ctx.lineWidth = 4;
  ctx.strokeRect(0, 0, size, size);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  texture.repeat.set(repeat, repeat);
  return texture;
}

const objectGridTexture = makeGridTexture(1);

// ---------------------------------------------------------------------------
// Infinite floor (follows the player, snapped to whole metres)
// ---------------------------------------------------------------------------
const FLOOR_SIZE = 600; // even, so tile seams land on whole metres

const floorTexture = makeGridTexture(FLOOR_SIZE);
const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(FLOOR_SIZE, FLOOR_SIZE),
  new THREE.MeshStandardMaterial({ map: floorTexture, roughness: 0.9, metalness: 0 })
);
floor.rotation.x = -Math.PI / 2;
scene.add(floor);

function updateFloor() {
  floor.position.set(Math.round(player.position.x), 0, Math.round(player.position.z));
}

// ---------------------------------------------------------------------------
// Physics constants
// ---------------------------------------------------------------------------
const GRAVITY = 9.8;
const AIR_DRAG = 0.05;          // per second, exponential
const RESTITUTION = 0.3;        // bounciness between bodies
const RESTITUTION_GROUND = 0.35;
const FRICTION = 0.4;           // Coulomb friction coefficient between bodies
const GROUND_FRICTION = 6;      // per second, exponential, on the floor
const PHYSICS_STEP = 1 / 120;   // fixed sub-step for stability
const MAX_STEPS_PER_FRAME = 8;
const SLOP = 0.001;             // allowed penetration before correction
const CORRECTION = 0.8;         // fraction of penetration corrected per step

const TRAIL_POINTS = 40;
const TRAIL_LIFE = 0.45;        // seconds
const TRAIL_MIN_SPEED = 0.8;    // m/s before a trail starts drawing

const trailVertexShader = /* glsl */ `
  attribute float alpha;
  varying float vAlpha;
  void main() {
    vAlpha = alpha;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const trailFragmentShader = /* glsl */ `
  uniform vec3 uColor;
  varying float vAlpha;
  void main() {
    gl_FragColor = vec4(uColor, vAlpha);
  }
`;


// ---------------------------------------------------------------------------
// Bodies
//   Dynamic test objects: { mesh, shape, mass, invMass, vel, state, ... }
//     state 'free'  : simulated (gravity, collisions)
//     state 'zoom'  : kinematic, flying into a hand
//     state 'held'  : kinematic, parented to a controller
//   Kinematic colliders (hands): { kin: true, shape: 'sphere', center, vel, ... }
//
// Shapes are axis-aligned and ignore rotation: spheres or boxes.
// ---------------------------------------------------------------------------
const bodies = [];
const kinematics = [];

let nextBodyId = 0;   // never reused, so rewind snapshots stay valid when bullets are removed
const staticBodies = [];   // fixed colliders such as buildings: never move, but push things

function makeBody({ geometry, color, x, z, shape, mass = 1, bounce = 0.3, friction = 0.4, isStatic = false }) {
  geometry.computeBoundingBox();
  const bb = geometry.boundingBox;
  geometry.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  const size = new THREE.Vector3();
  geometry.boundingBox.getSize(size);
  const localCenter = new THREE.Vector3(0, size.y / 2, 0);
  const localHalf = size.clone().multiplyScalar(0.5);

  const material = new THREE.MeshStandardMaterial({
    color,
    map: objectGridTexture,
    roughness: 0.5,
    metalness: 0.1,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(x, 0, z);
  scene.add(mesh);

  const body = {
    mesh,
    shape,                                     // 'sphere' | 'box'
    localR: Math.max(localHalf.x, localHalf.y, localHalf.z), // sphere radius
    localHalf,
    localCenter,
    center: new THREE.Vector3(),              // world, refreshed each step
    r: 0,                                     // world radius (sphere)
    half: new THREE.Vector3(),                // world half extents (box)
    mass,
    bounce,                                    // 0 = dead, 1 = perfectly bouncy
    friction,                                  // how grippy the surface is
    invMass: isStatic ? 0 : 1 / mass,
    vel: new THREE.Vector3(),
    state: isStatic ? 'static' : 'free',
    isStatic,
    home: mesh.position.clone(),
    color,
    hand: null,
    zoom: null,
    trail: isStatic ? null : createTrail(color),
    id: nextBodyId++,                        // stable id for rewind snapshots
  };
  bodies.push(body);
  if (isStatic) staticBodies.push(body);
  return body;
}

// Dynamic test objects, in a row in front of the start position
makeBody({ geometry: new THREE.BoxGeometry(0.3, 0.3, 0.3), color: 0xff6b6b, x: -1.2, z: -1.5, shape: 'box', mass: 1 });
makeBody({ geometry: new THREE.SphereGeometry(0.18, 32, 16), color: 0x4dabf7, x: -0.6, z: -1.5, shape: 'sphere', mass: 1 });
makeBody({ geometry: new THREE.CylinderGeometry(0.15, 0.15, 0.4, 32), color: 0xffd43b, x: 0, z: -1.5, shape: 'box', mass: 1.5 });
makeBody({ geometry: new THREE.ConeGeometry(0.18, 0.4, 32), color: 0x69db7c, x: 0.6, z: -1.5, shape: 'box', mass: 1 });
makeBody({ geometry: new THREE.TorusGeometry(0.15, 0.05, 16, 48).rotateX(Math.PI / 2), color: 0xda77f2, x: 1.2, z: -1.5, shape: 'box', mass: 0.8 });
makeBody({ geometry: new THREE.OctahedronGeometry(0.2), color: 0xffa94d, x: -0.4, z: -2.4, shape: 'sphere', mass: 1 });
makeBody({ geometry: new THREE.BoxGeometry(0.2, 0.2, 0.2), color: 0x3bc9db, x: 0.4, z: -2.4, shape: 'box', mass: 0.5 });

// Reference blocks: heavy, so they barely budge when hit
makeBody({ geometry: new THREE.BoxGeometry(1, 1, 1), color: 0x9aa0a6, x: 2.2, z: -2.2, shape: 'box', mass: 30 });
makeBody({ geometry: new THREE.BoxGeometry(0.3, 2, 0.3), color: 0x6c757d, x: -2.4, z: -2.6, shape: 'box', mass: 8 });

// The test city: static blocks you can web onto and swing between
for (const bld of cityBlocks()) {
  makeBody({
    geometry: new THREE.BoxGeometry(bld.w, bld.h, bld.d),
    color: bld.color,
    x: bld.x,
    z: bld.z,
    shape: 'box',
    isStatic: true,
  });
}

// Extremely heavy: hands can't lift these, Doctor Octopus can
makeBody({ geometry: new THREE.BoxGeometry(1.2, 0.8, 1.2), color: 0x2b2d31, x: -3.4, z: -3.2, shape: 'box', mass: 400 });
makeBody({ geometry: new THREE.SphereGeometry(0.5, 32, 16), color: 0x5c5f66, x: 3.6, z: -3.4, shape: 'sphere', mass: 2000 });

// Hands can only lift objects up to this mass (kg-ish); tentacles ignore it
const HAND_MAX_MASS = 40;

const meshes = bodies.map((b) => b.mesh);

// Refresh a dynamic body's world-space collider from its mesh
const _worldCenterTmp = new THREE.Vector3();
function refreshBody(b) {
  const s = b.mesh.scale.x;
  b.mesh.updateWorldMatrix(true, false);
  b.center.copy(b.localCenter);
  b.mesh.localToWorld(b.center);
  b.r = b.localR * s;
  b.half.copy(b.localHalf).multiplyScalar(s);
}

// ---------------------------------------------------------------------------
// Collision detection (sphere/sphere, box/box, sphere/box)
// Normal points from A to B. Returns penetration depth (0 if none).
// ---------------------------------------------------------------------------
const _n = new THREE.Vector3();
const _d = new THREE.Vector3();
const _q = new THREE.Vector3();

// Sphere (center c, radius r) against box b. Writes normal box->sphere into _n.
function sphereVsBox(c, r, b) {
  _q.set(
    THREE.MathUtils.clamp(c.x, b.center.x - b.half.x, b.center.x + b.half.x),
    THREE.MathUtils.clamp(c.y, b.center.y - b.half.y, b.center.y + b.half.y),
    THREE.MathUtils.clamp(c.z, b.center.z - b.half.z, b.center.z + b.half.z)
  );
  _d.subVectors(c, _q);
  const dist = _d.length();

  if (dist > 1e-6) {
    if (dist >= r) return 0;
    _n.copy(_d).divideScalar(dist);
    return r - dist;
  }

  // Sphere centre inside the box: push out along the shallowest axis
  const px = b.half.x - Math.abs(c.x - b.center.x);
  const py = b.half.y - Math.abs(c.y - b.center.y);
  const pz = b.half.z - Math.abs(c.z - b.center.z);
  if (px <= py && px <= pz) {
    _n.set(Math.sign(c.x - b.center.x) || 1, 0, 0);
    return px + r;
  }
  if (py <= pz) {
    _n.set(0, Math.sign(c.y - b.center.y) || 1, 0);
    return py + r;
  }
  _n.set(0, 0, Math.sign(c.z - b.center.z) || 1);
  return pz + r;
}

// Returns penetration depth; on contact, _n holds the normal from a to b.
function contact(a, b) {
  if (a.shape === 'sphere' && b.shape === 'sphere') {
    _n.subVectors(b.center, a.center);
    const dist = _n.length();
    const rs = a.r + b.r;
    if (dist >= rs) return 0;
    if (dist < 1e-6) _n.set(0, 1, 0);
    else _n.divideScalar(dist);
    return rs - dist;
  }

  if (a.shape === 'box' && b.shape === 'box') {
    const dx = b.center.x - a.center.x;
    const dy = b.center.y - a.center.y;
    const dz = b.center.z - a.center.z;
    const ox = a.half.x + b.half.x - Math.abs(dx);
    if (ox <= 0) return 0;
    const oy = a.half.y + b.half.y - Math.abs(dy);
    if (oy <= 0) return 0;
    const oz = a.half.z + b.half.z - Math.abs(dz);
    if (oz <= 0) return 0;
    if (ox <= oy && ox <= oz) { _n.set(Math.sign(dx) || 1, 0, 0); return ox; }
    if (oy <= oz) { _n.set(0, Math.sign(dy) || 1, 0); return oy; }
    _n.set(0, 0, Math.sign(dz) || 1);
    return oz;
  }

  if (a.shape === 'sphere' && b.shape === 'box') {
    const depth = sphereVsBox(a.center, a.r, b); // _n: box -> sphere
    _n.negate();                                 // now a -> b
    return depth;
  }

  // a box, b sphere
  const depth = sphereVsBox(b.center, b.r, a);   // _n: box(a) -> sphere(b) = a -> b
  return depth;
}

// ---------------------------------------------------------------------------
// Impulse resolution between two bodies
// ---------------------------------------------------------------------------
const _rel = new THREE.Vector3();
const _tan = new THREE.Vector3();

function resolvePair(a, b) {
  if (a.bullet && b.bullet) return;   // bullets pass through each other
  const invSum = a.invMass + b.invMass;
  if (invSum === 0) return;

  const depth = contact(a, b);
  if (depth <= 0) return;

  const n = _n;

  // Positional correction (only moves non-kinematic bodies, via invMass)
  const corr = (Math.max(depth - SLOP, 0) * CORRECTION) / invSum;
  if (a.invMass > 0) {
    a.mesh.position.addScaledVector(n, -corr * a.invMass);
    a.center.addScaledVector(n, -corr * a.invMass);
  }
  if (b.invMass > 0) {
    b.mesh.position.addScaledVector(n, corr * b.invMass);
    b.center.addScaledVector(n, corr * b.invMass);
  }

  // Relative velocity along the normal (B relative to A)
  _rel.subVectors(b.vel, a.vel);
  const vn = _rel.dot(n);
  if (vn >= 0) return; // already separating
  if (-vn > 2) sfx.play('impact', -vn);

  // Normal impulse
  const e = (a.bounce !== undefined && b.bounce !== undefined) ? (a.bounce + b.bounce) / 2 : RESTITUTION;
  const j = (-(1 + e) * vn) / invSum;
  a.vel.addScaledVector(n, -j * a.invMass);
  b.vel.addScaledVector(n, j * b.invMass);

  // Friction impulse along the tangent
  _tan.copy(_rel).addScaledVector(n, -vn);
  const tLen = _tan.length();
  if (tLen > 1e-6) {
    _tan.divideScalar(tLen);
    const mu = (a.friction !== undefined && b.friction !== undefined) ? Math.sqrt(a.friction * b.friction) : FRICTION;
    const jt = Math.min(tLen / invSum, mu * j);
    a.vel.addScaledVector(_tan, jt * a.invMass);
    b.vel.addScaledVector(_tan, -jt * b.invMass);
  }
}

// ---------------------------------------------------------------------------
// Physics step
// ---------------------------------------------------------------------------
let activeList = [];

function physicsStep(h) {
  // 1. Integrate free bodies
  for (const b of bodies) {
    if (b.state !== 'free') continue;
    if (!b.noGravity) b.vel.y -= GRAVITY * h;
    b.vel.multiplyScalar(Math.exp(-AIR_DRAG * h));
    b.mesh.position.addScaledVector(b.vel, h);
  }

  // 2. Refresh colliders
  for (const b of bodies) refreshBody(b);

  // 3. Collisions (two passes for stacks)
  for (let iter = 0; iter < 2; iter++) {
    for (let i = 0; i < activeList.length; i++) {
      for (let j = i + 1; j < activeList.length; j++) {
        resolvePair(activeList[i], activeList[j]);
      }
    }
  }

  // Fixed colliders (buildings): only moving bodies are pushed by them
  for (let i = 0; i < activeList.length; i++) {
    const a = activeList[i];
    if (a.invMass === 0) continue;
    for (const s of staticBodies) resolvePair(a, s);
  }

  // 4. Floor
  for (const b of bodies) {
    if (b.state !== 'free') continue;
    const extentY = b.shape === 'sphere' ? b.r : b.half.y;
    const minY = b.center.y - extentY;
    if (minY < 0) {
      b.mesh.position.y -= minY;
      b.center.y -= minY;
      if (b.vel.y < -0.5) b.vel.y *= -(b.bounce * 0.9 + 0.05);
      else b.vel.y = 0;
      const f = Math.exp(-GROUND_FRICTION * h);
      b.vel.x *= f;
      b.vel.z *= f;
      if (b.vel.lengthSq() < 0.0004) b.vel.set(0, 0, 0); // settle
    }
  }
}

function stepPhysics(dt, accumulator) {
  let acc = accumulator + dt;
  let steps = 0;
  while (acc >= PHYSICS_STEP && steps < MAX_STEPS_PER_FRAME) {
    physicsStep(PHYSICS_STEP);
    acc -= PHYSICS_STEP;
    steps++;
  }
  if (steps === MAX_STEPS_PER_FRAME) acc = 0;
  return acc;
}

// ---------------------------------------------------------------------------
// Trails
// Ribbon with per-vertex alpha that fades toward the tail, drawn additively.
// ---------------------------------------------------------------------------
function createTrail(color) {
  const segs = TRAIL_POINTS - 1;
  const positions = new Float32Array(segs * 6 * 3);
  const alphas = new Float32Array(segs * 6);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('alpha', new THREE.BufferAttribute(alphas, 1));
  const material = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(color).lerp(new THREE.Color(0xffffff), 0.5) } },
    vertexShader: trailVertexShader,
    fragmentShader: trailFragmentShader,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.visible = false;
  scene.add(mesh);
  return { mesh, geometry, positions, alphas, points: [] };
}

const _trailDir = new THREE.Vector3();
const _trailMid = new THREE.Vector3();
const _trailSide = new THREE.Vector3();
const _camPos = new THREE.Vector3();

function updateTrail(b, now, moving) {
  const tr = b.trail;
  if (moving) {
    tr.points.push({ p: b.center.clone(), t: now });
    if (tr.points.length > TRAIL_POINTS) tr.points.shift();
  }
  while (tr.points.length && now - tr.points[0].t > TRAIL_LIFE) tr.points.shift();

  const pts = tr.points;
  if (pts.length < 2) {
    tr.mesh.visible = false;
    return;
  }

  const baseWidth = Math.max(0.02, (b.shape === 'sphere' ? b.r : Math.min(b.half.x, b.half.y, b.half.z)) * 0.7);
  const fade = (p) => Math.max(0, 1 - (now - p.t) / TRAIL_LIFE);

  let v = 0;
  const pos = tr.positions;
  const alp = tr.alphas;
  const put = (x, y, z, a) => {
    pos[v * 3] = x; pos[v * 3 + 1] = y; pos[v * 3 + 2] = z;
    alp[v] = a;
    v++;
  };

  for (let i = 0; i < pts.length - 1; i++) {
    const A = pts[i];
    const B = pts[i + 1];
    const fa = fade(A);
    const fb = fade(B);
    const wa = baseWidth * fa;
    const wb = baseWidth * fb;
    const aa = fa * 0.9;
    const ab = fb * 0.9;

    // Billboard the ribbon toward the camera
    _trailDir.subVectors(B.p, A.p);
    _trailMid.addVectors(A.p, B.p).multiplyScalar(0.5);
    _trailSide.subVectors(_camPos, _trailMid).cross(_trailDir);
    if (_trailSide.lengthSq() < 1e-8) _trailSide.set(0, 1, 0).cross(_trailDir);
    _trailSide.normalize();

    const a1 = { x: A.p.x + _trailSide.x * wa, y: A.p.y + _trailSide.y * wa, z: A.p.z + _trailSide.z * wa };
    const a2 = { x: A.p.x - _trailSide.x * wa, y: A.p.y - _trailSide.y * wa, z: A.p.z - _trailSide.z * wa };
    const b1 = { x: B.p.x + _trailSide.x * wb, y: B.p.y + _trailSide.y * wb, z: B.p.z + _trailSide.z * wb };
    const b2 = { x: B.p.x - _trailSide.x * wb, y: B.p.y - _trailSide.y * wb, z: B.p.z - _trailSide.z * wb };

    put(a1.x, a1.y, a1.z, aa);
    put(a2.x, a2.y, a2.z, aa);
    put(b1.x, b1.y, b1.z, ab);
    put(a2.x, a2.y, a2.z, aa);
    put(b2.x, b2.y, b2.z, ab);
    put(b1.x, b1.y, b1.z, ab);
  }

  tr.geometry.setDrawRange(0, v);
  tr.geometry.attributes.position.needsUpdate = true;
  tr.geometry.attributes.alpha.needsUpdate = true;
  tr.mesh.visible = true;
}

// ---------------------------------------------------------------------------
// Controllers, grips, hands
// ---------------------------------------------------------------------------
const rayGeometry = new THREE.BufferGeometry().setFromPoints([
  new THREE.Vector3(0, 0, 0),
  new THREE.Vector3(0, 0, -1.5),
]);

const FINGER_CHAINS = [
  ['thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip'],
  ['index-finger-metacarpal', 'index-finger-phalanx-proximal', 'index-finger-phalanx-intermediate', 'index-finger-phalanx-distal', 'index-finger-tip'],
  ['middle-finger-metacarpal', 'middle-finger-phalanx-proximal', 'middle-finger-phalanx-intermediate', 'middle-finger-phalanx-distal', 'middle-finger-tip'],
  ['ring-finger-metacarpal', 'ring-finger-phalanx-proximal', 'ring-finger-phalanx-intermediate', 'ring-finger-phalanx-distal', 'ring-finger-tip'],
  ['pinky-finger-metacarpal', 'pinky-finger-phalanx-proximal', 'pinky-finger-phalanx-intermediate', 'pinky-finger-phalanx-distal', 'pinky-finger-tip'],
];

const BONE_SEGMENTS = [];
for (const chain of FINGER_CHAINS) {
  const full = ['wrist', ...chain];
  for (let i = 0; i < full.length - 1; i++) BONE_SEGMENTS.push([full[i], full[i + 1]]);
}
BONE_SEGMENTS.push(
  ['index-finger-metacarpal', 'middle-finger-metacarpal'],
  ['middle-finger-metacarpal', 'ring-finger-metacarpal'],
  ['ring-finger-metacarpal', 'pinky-finger-metacarpal']
);

const jointGeometry = new THREE.SphereGeometry(1, 12, 8);
const tmpWorld = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const _anchor = new THREE.Vector3();
const _anchorTip = new THREE.Vector3();
const _target = new THREE.Vector3();
const _offset = new THREE.Vector3();

const hands = [0, 1].map((i) => {
  const color = i === 0 ? 0x4fc3ff : 0xff8a4f;

  const controller = renderer.xr.getController(i);
  const grip = renderer.xr.getControllerGrip(i);
  const hand = renderer.xr.getHand(i);

  const ray = new THREE.Line(
    rayGeometry,
    new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.6 })
  );
  controller.add(ray);

  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(0.018, 0.018, 0.12, 12),
    new THREE.MeshStandardMaterial({ color: 0xffffff, map: objectGridTexture, roughness: 0.6 })
  );
  body.rotation.x = Math.PI / 2;
  grip.add(body);

  player.add(controller, grip, hand);

  const rig = {
    index: i,
    color,
    controller,
    grip,
    hand,
    connected: false,
    handedness: null,     // 'left' | 'right', from the XR input source
    selectDown: false,    // controller trigger / pinch (set by select events)
    pinching: false,      // hand pinch with hysteresis (set by powers.js)
    pose: null,           // hand pose, set by powers.js
    held: null,           // body currently zooming or held by this hand
    prevPos: new THREE.Vector3(),
    vel: new THREE.Vector3(),
    hasPrev: false,
    built: false,
    lines: null,
    positions: null,
    kinJoints: new Map(),
    kinController: { kin: true, shape: 'sphere', r: 0.04, center: new THREE.Vector3(), vel: new THREE.Vector3(), prev: new THREE.Vector3(), invMass: 0, active: false, hasPrev: false },
  };

  controller.addEventListener('connected', (e) => {
    rig.connected = true;
    rig.handedness = (e.data && e.data.handedness) || null;
  });
  controller.addEventListener('disconnected', () => { rig.connected = false; });
  controller.addEventListener('selectstart', () => {
    rig.selectDown = true;
    onGrabStart(rig);
  });
  controller.addEventListener('selectend', () => {
    rig.selectDown = false;
    onGrabEnd(rig);
  });

  return rig;
});

// Joint markers, bone lines, and kinematic physics colliders for the hand.
function buildHandVisuals(rig) {
  const joints = rig.hand.joints;
  if (!joints || Object.keys(joints).length === 0) return;

  const material = new THREE.MeshStandardMaterial({
    color: rig.color,
    map: objectGridTexture,
    emissive: rig.color,
    emissiveIntensity: 0.25,
    roughness: 0.4,
  });

  for (const name of Object.keys(joints)) {
    const r = name === 'wrist' ? 0.012 : name.endsWith('tip') ? 0.007 : 0.009;
    const marker = new THREE.Mesh(jointGeometry, material);
    marker.scale.setScalar(r);
    joints[name].add(marker);

    rig.kinJoints.set(name, {
      kin: true, shape: 'sphere', r: r * 1.1,
      center: new THREE.Vector3(), vel: new THREE.Vector3(), prev: new THREE.Vector3(),
      invMass: 0, active: false, hasPrev: false,
    });
  }

  rig.positions = new Float32Array(BONE_SEGMENTS.length * 6);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(rig.positions, 3));
  rig.lines = new THREE.LineSegments(
    geometry,
    new THREE.LineBasicMaterial({ color: rig.color, transparent: true, opacity: 0.8 })
  );
  rig.lines.frustumCulled = false;
  scene.add(rig.lines);

  rig.built = true;
}

function updateHandBones(rig) {
  const joints = rig.hand.joints;
  const wrist = joints && joints.wrist;
  if (!wrist || !rig.lines) return;

  rig.lines.visible = wrist.visible;
  if (!wrist.visible) return;

  const pos = rig.positions;
  for (let s = 0; s < BONE_SEGMENTS.length; s++) {
    const [a, b] = BONE_SEGMENTS[s];
    const ja = joints[a];
    const jb = joints[b];
    const o = s * 6;
    if (ja) {
      ja.getWorldPosition(tmpWorld);
      pos[o] = tmpWorld.x; pos[o + 1] = tmpWorld.y; pos[o + 2] = tmpWorld.z;
    }
    if (jb) {
      jb.getWorldPosition(tmpWorld);
      pos[o + 3] = tmpWorld.x; pos[o + 4] = tmpWorld.y; pos[o + 5] = tmpWorld.z;
    }
  }
  rig.lines.geometry.attributes.position.needsUpdate = true;
}

// Update kinematic colliders for a hand from its tracked joints (or controller).
function updateHandColliders(rig, dt) {
  const joints = rig.hand.joints;
  const tracked = !!(joints && joints.wrist && joints.wrist.visible);

  for (const [name, kb] of rig.kinJoints) {
    const joint = joints[name];
    const on = tracked && joint && joint.visible;
    kb.active = on;
    if (!on) { kb.hasPrev = false; continue; }
    joint.getWorldPosition(kb.center);
    if (kb.hasPrev && dt > 0) {
      kb.vel.copy(kb.center).sub(kb.prev).divideScalar(dt);
    } else {
      kb.vel.set(0, 0, 0);
    }
    kb.prev.copy(kb.center);
    kb.hasPrev = true;
  }

  // Controller collider when no hand is tracked
  const kc = rig.kinController;
  kc.active = !tracked && rig.connected && renderer.xr.isPresenting;
  if (kc.active) {
    rig.controller.getWorldPosition(kc.center);
    if (kc.hasPrev && dt > 0) kc.vel.copy(kc.center).sub(kc.prev).divideScalar(dt);
    else kc.vel.set(0, 0, 0);
    kc.prev.copy(kc.center);
    kc.hasPrev = true;
  } else {
    kc.hasPrev = false;
  }
}

// Pinch point: midpoint of index and thumb tips, or a point in front of the controller
function getAnchor(rig, out) {
  const joints = rig.hand.joints;
  const index = joints && joints['index-finger-tip'];
  const thumb = joints && joints['thumb-tip'];
  if (index && thumb && index.visible && thumb.visible) {
    index.getWorldPosition(out);
    thumb.getWorldPosition(_anchorTip);
    return out.add(_anchorTip).multiplyScalar(0.5);
  }
  rig.controller.getWorldPosition(out);
  rig.controller.updateWorldMatrix(true, false);
  _offset.set(0, 0, -1).transformDirection(rig.controller.matrixWorld).multiplyScalar(0.05);
  return out.add(_offset);
}

// ---------------------------------------------------------------------------
// Grabbing: pick a body, zoom it into the hand, then hold it
// ---------------------------------------------------------------------------
const raycaster = new THREE.Raycaster();
raycaster.far = 3;
const rayDir = new THREE.Vector3();

function setRayFromController(controller) {
  controller.updateWorldMatrix(true, false);
  raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
  rayDir.set(0, 0, -1).transformDirection(controller.matrixWorld);
  raycaster.ray.direction.copy(rayDir);
}

const ZOOM_DURATION = 0.32; // seconds

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function onGrabStart(rig) {
  if (rig.held) return;
  if (powers.blocksGrab()) return; // wheel open or a power is using the hands

  let target = null;

  // 1. Ray hit
  setRayFromController(rig.controller);
  const hit = raycaster.intersectObjects(meshes, false)[0];
  if (hit) {
    target = bodies.find((b) => b.mesh === hit.object) || null;
  }
  if (target && (target.mass > HAND_MAX_MASS || target.isStatic)) target = null;

  // 2. Proximity fallback (useful for hands)
  if (!target) {
    rig.controller.getWorldPosition(tmpWorld);
    let best = 0.15;
    for (const b of bodies) {
      if (b.mass > HAND_MAX_MASS || b.isStatic) continue;
      refreshBody(b);
      const d = b.center.distanceTo(tmpWorld);
      if (d < best) {
        best = d;
        target = b;
      }
    }
  }

  if (!target || target.state !== 'free') return;

  rig.held = target;
  target.state = 'zoom';
  target.hand = rig;
  target.invMass = 0;
  target.zoom = { t: 0, start: target.mesh.position.clone() };
}

// Frame update for a body flying into the hand
function updateZoom(rig, dt) {
  const b = rig.held;
  const z = b.zoom;
  z.t = Math.min(1, z.t + dt / ZOOM_DURATION);
  const e = easeInOutCubic(z.t);

  getAnchor(rig, _anchor);
  // Mesh origin is at the bottom; put the object's centre on the anchor
  _offset.copy(b.localCenter).multiplyScalar(b.mesh.scale.x);
  _target.copy(_anchor).sub(_offset);

  // Lerp with a small arc so it reads as a zoom, not a slide
  const prev = b.mesh.position.clone();
  b.mesh.position.lerpVectors(z.start, _target, e);
  b.mesh.position.y += Math.sin(Math.PI * e) * 0.12 * (1 - e);

  // Kinematic velocity for collisions
  if (dt > 0) b.vel.copy(b.mesh.position).sub(prev).divideScalar(dt);

  if (z.t >= 1) {
    rig.controller.attach(b.mesh); // keeps world transform: centre sits on the pinch
    b.state = 'held';
    b.zoom = null;
  }
}

function onGrabEnd(rig) {
  const b = rig.held;
  if (!b) return;

  rig.held = null;
  if (b.state === 'held') {
    scene.attach(b.mesh); // keep world transform
  }
  b.state = 'free';
  b.hand = null;
  b.zoom = null;
  b.invMass = 1 / b.mass;

  // Throw with the hand's recent velocity (clamped). Stamp it so spider-sense ignores your own throws.
  b.releasedAt = performance.now() / 1000;
  b.vel.copy(rig.vel);
  if (b.vel.length() > 8) b.vel.setLength(8);
}

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------
function resetObjects() {
  powers.reset();
  for (const rig of hands) {
    if (rig.held) {
      if (rig.held.state === 'held') scene.attach(rig.held.mesh);
      rig.held.state = 'free';
      rig.held.hand = null;
      rig.held.zoom = null;
      rig.held.invMass = 1 / rig.held.mass;
      rig.held = null;
    }
  }
  for (const b of bodies) {
    if (b.isStatic) continue;   // buildings stay where they are
    b.state = 'free';
    b.invMass = 1 / b.mass;
    b.mesh.position.copy(b.home);
    b.vel.set(0, 0, 0);
    if (b.trail) b.trail.points.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Movement
//   Desktop: WASD / arrows walk (Shift run), Q/E turn, drag to look, R reset.
//   VR:      left stick walk relative to head yaw, right stick smooth turn.
// ---------------------------------------------------------------------------
const WALK_SPEED = 2.5;
const RUN_SPEED = 5;
const DESKTOP_TURN_SPEED = 1.7; // rad/s
const STICK_TURN_SPEED = 1.7;   // rad/s
const DEADZONE = 0.15;

const keys = new Set();
let pitch = 0;
let dragging = false;
let lastX = 0;
let lastY = 0;

addEventListener('keydown', (e) => {
  keys.add(e.code);
  if (e.code === 'KeyR') resetObjects();
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());

renderer.domElement.addEventListener('pointerdown', (e) => {
  dragging = true;
  lastX = e.clientX;
  lastY = e.clientY;
});
addEventListener('pointerup', () => { dragging = false; });
addEventListener('pointermove', (e) => {
  if (!dragging || renderer.xr.isPresenting) return;
  player.rotation.y -= (e.clientX - lastX) * 0.0045;
  pitch = THREE.MathUtils.clamp(pitch - (e.clientY - lastY) * 0.0045, -1.4, 1.4);
  camera.rotation.x = pitch;
  lastX = e.clientX;
  lastY = e.clientY;
});

function applyDeadzone(v) {
  if (Math.abs(v) < DEADZONE) return 0;
  return (Math.sign(v) * (Math.abs(v) - DEADZONE)) / (1 - DEADZONE);
}

function readXRSticks() {
  const sticks = { left: { x: 0, y: 0 }, right: { x: 0, y: 0 } };
  const session = renderer.xr.getSession();
  if (!session) return sticks;

  for (const source of session.inputSources) {
    const gp = source.gamepad;
    if (!gp || !source.handedness) continue;
    const a = gp.axes;
    const x = a.length >= 4 ? a[2] : a[0] || 0;
    const y = a.length >= 4 ? a[3] : a[1] || 0;
    if (source.handedness === 'left') sticks.left = { x, y };
    if (source.handedness === 'right') sticks.right = { x, y };
  }
  return sticks;
}

const moveForward = new THREE.Vector3();
const moveRight = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const moveDelta = new THREE.Vector3();

function updateHeadingVectors() {
  camera.updateWorldMatrix(true, false);
  camera.getWorldDirection(moveForward);
  moveForward.y = 0;
  if (moveForward.lengthSq() < 1e-6) moveForward.set(0, 0, -1);
  moveForward.normalize();
  moveRight.crossVectors(moveForward, UP).normalize();
}

// ---------------------------------------------------------------------------
// Arm swing locomotion (VR)
// Each hand's speed along the head's forward direction drives walking.
// Swinging the arms back and forth gives a steady walk; standing still stops.
// ---------------------------------------------------------------------------
const ARM_SWING_GAIN = 1.4;      // m/s of walking per m/s of average forward hand speed
const ARM_SWING_DEADZONE = 0.6;  // ignore hand jitter and small movements (m/s)
const ARM_SWING_MAX = 6.0;       // m/s cap, a fast swing runs
const ARM_SWING_RESPONSE = 10;   // smoothing (higher = snappier)
let armSpeed = 0;
let snapLatched = false;   // snap turn: one step per push of the stick

function updateArmSwing(dt) {
  let sum = 0;
  for (const rig of hands) {
    // Magnitude, so both forward and back swings count
    sum += Math.abs(rig.vel.dot(moveForward));
  }
  const avg = sum / hands.length;
  const target = THREE.MathUtils.clamp((avg - ARM_SWING_DEADZONE) * ARM_SWING_GAIN, 0, ARM_SWING_MAX);
  armSpeed += (target - armSpeed) * (1 - Math.exp(-ARM_SWING_RESPONSE * dt));
  return armSpeed;
}

function updateMovement(dt) {
  if (dt <= 0) return;
  updateHeadingVectors();

  let strafe = 0;
  let forward = 0;
  let turn = 0;
  let speed = WALK_SPEED;

  if (renderer.xr.isPresenting) {
    const { left, right } = readXRSticks();
    strafe = applyDeadzone(left.x);
    forward = -applyDeadzone(left.y);
    turn = applyDeadzone(right.x);
  } else {
    if (keys.has('KeyW') || keys.has('ArrowUp')) forward += 1;
    if (keys.has('KeyS') || keys.has('ArrowDown')) forward -= 1;
    if (keys.has('KeyD') || keys.has('ArrowRight')) strafe += 1;
    if (keys.has('KeyA') || keys.has('ArrowLeft')) strafe -= 1;
    if (keys.has('KeyE')) turn += 1;
    if (keys.has('KeyQ')) turn -= 1;
    if (keys.has('ShiftLeft') || keys.has('ShiftRight')) speed = RUN_SPEED;
  }

  const mag = Math.hypot(strafe, forward);
  if (mag > 1) {
    strafe /= mag;
    forward /= mag;
  }

  // Snap turn: one 30-degree step per push of the stick, instead of smooth turning
  if (settings.snapTurn && renderer.xr.isPresenting) {
    if (Math.abs(turn) > 0.6 && !snapLatched) {
      player.rotation.y -= Math.sign(turn) * (Math.PI / 6);
      snapLatched = true;
    } else if (Math.abs(turn) < 0.3) {
      snapLatched = false;
    }
    turn = 0;
  }

  if (turn !== 0) {
    player.rotation.y -= turn * (renderer.xr.isPresenting ? STICK_TURN_SPEED : DESKTOP_TURN_SPEED) * dt;
  }

  const swing = renderer.xr.isPresenting ? updateArmSwing(dt) : 0;

  if (strafe !== 0 || forward !== 0) {
    moveDelta.set(0, 0, 0)
      .addScaledVector(moveForward, forward)
      .addScaledVector(moveRight, strafe);
    player.position.addScaledVector(moveDelta, speed * dt);
  }

  if (swing > 0) {
    player.position.addScaledVector(moveForward, swing * dt);
  }
}

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Hand gesture: clap both hands together to reset the objects
// Wrists close together and moving toward each other quickly.
// ---------------------------------------------------------------------------
const CLAP_DISTANCE = 0.08;   // m between wrists
const CLAP_APPROACH = 1.8;    // m/s closing speed
const CLAP_COOLDOWN = 1.0;    // s
const _wristA = new THREE.Vector3();
const _wristB = new THREE.Vector3();
const _sep = new THREE.Vector3();
let clapCooldown = 0;

function wristPosition(rig, out) {
  const wrist = rig.hand.joints && rig.hand.joints.wrist;
  if (!wrist || !wrist.visible) return false;
  wrist.getWorldPosition(out);
  return true;
}

function checkClapReset(dt) {
  clapCooldown = Math.max(0, clapCooldown - dt);
  if (clapCooldown > 0) return;

  const [a, b] = hands;
  if (!wristPosition(a, _wristA) || !wristPosition(b, _wristB)) return;

  _sep.subVectors(_wristA, _wristB);
  const d = _sep.length();
  if (d > CLAP_DISTANCE || d < 1e-6) return;

  // Positive when the hands are closing on each other
  const closing = -a.vel.clone().sub(b.vel).dot(_sep) / d;
  if (closing < CLAP_APPROACH) return;

  resetObjects();
  clapCooldown = CLAP_COOLDOWN;
}

// Superpowers, power wheel, and gesture spells (see powers.js)
// Synthesised sound effects (see sound.js)
const sfx = createSound();

// Comfort settings, saved in this browser (see settings.js)
const settings = loadSettings();
const comfort = createComfort({ camera, player, settings });

// Gesture calibration: sets the thresholds from your own hands (see calibrate.js)
const calibration = createCalibration({ hands, tuning: TUNING, sfx });

const powers = createPowers({
  sfx,
  scene,
  camera,
  player,
  bodies,
  hands,
  keys,
  renderer,
  gridTexture: objectGridTexture,
  cancelHandGrab: (rig) => onGrabEnd(rig),
});

// Test hook for automated checks (read-only use)

const MAX_HAND_SPEED = 10; // m/s; faster than this is treated as a tracking jump

// Time control: 1 = normal, lower = slow motion
let timeScale = 1;
function setTimeScale(v) {
  timeScale = THREE.MathUtils.clamp(v, 0.1, 1);
}
function getTimeScale() {
  return timeScale;
}

// Spawnable objects: shape, size, mass and surface, picked at random
const SPAWN_PRESETS = [
  { name: 'Wooden crate', make: () => new THREE.BoxGeometry(0.4, 0.4, 0.4), shape: 'box', mass: 2, bounce: 0.2, friction: 0.6 },
  { name: 'Rubber ball', make: () => new THREE.SphereGeometry(0.2, 32, 16), shape: 'sphere', mass: 0.5, bounce: 0.85, friction: 0.7 },
  { name: 'Metal block', make: () => new THREE.BoxGeometry(0.3, 0.3, 0.3), shape: 'box', mass: 6, bounce: 0.15, friction: 0.25 },
  { name: 'Plank', make: () => new THREE.BoxGeometry(1.4, 0.1, 0.4), shape: 'box', mass: 1.5, bounce: 0.25, friction: 0.5 },
  { name: 'Ice cube', make: () => new THREE.BoxGeometry(0.25, 0.25, 0.25), shape: 'box', mass: 0.8, bounce: 0.1, friction: 0.05 },
];
const SPAWN_COLORS = [0xc68b59, 0xe03131, 0x868e96, 0xa0522d, 0x9bd9ff];
let spawnCount = 0;

// Drops a random preset at (x, y, z) with a small push along `dir`
function spawnObject(x, y, z, dir) {
  const preset = SPAWN_PRESETS[spawnCount % SPAWN_PRESETS.length];
  const color = SPAWN_COLORS[spawnCount % SPAWN_COLORS.length];
  spawnCount++;
  const body = makeBody({
    geometry: preset.make(),
    color,
    x,
    z,
    shape: preset.shape,
    mass: preset.mass,
    bounce: preset.bounce,
    friction: preset.friction,
  });
  body.mesh.position.y = Math.max(y, 0);
  body.home.copy(body.mesh.position);
  if (dir) body.vel.copy(dir);
  meshes.push(body.mesh);
  return body;
}

const tools = createTools({
  sfx,
  hands,
  keys,
  getTimeScale,
  setTimeScale,
  spawn: (pos, dir) => spawnObject(pos.x, pos.y, pos.z, dir),
  setRewindHeld,
  camera,
  player,
});
scene.add(tools.group);

// Spider-Sense bullet time (see spidersense.js)
const spiderSense = createSpiderSense({
  bodies,
  camera,
  isEnabled: () => settings.bulletTime && !!powers.equipped && powers.equipped.id === 'spider',
  tintEnabled: () => settings.redTint,
});

// Bullets are short-lived physics bodies, so Spider-Sense can see them coming
function fireBullet(origin, vel, radius = 0.05) {
  const b = makeBody({
    geometry: new THREE.SphereGeometry(radius, 8, 6),
    color: 0xffd43b,
    x: origin.x,
    z: origin.z,
    shape: 'sphere',
    mass: 0.05,
    bounce: 0.1,
    friction: 0.1,
  });
  b.mesh.position.copy(origin);
  b.vel.copy(vel);
  b.bullet = true;
  b.noGravity = true;        // bullets fly straight, like fast bullets
  b.expires = elapsed + 4;   // world seconds
  return b;
}

// Removes spent bullets from the world
function cleanupBullets() {
  for (let i = bodies.length - 1; i >= 0; i--) {
    const b = bodies[i];
    if (!b.bullet || !(b.dead || elapsed > b.expires)) continue;
    scene.remove(b.mesh);
    scene.remove(b.trail.mesh);
    b.trail.geometry.dispose();
    b.mesh.geometry.dispose();
    bodies.splice(i, 1);
  }
}

// Enemies with guns (see enemies.js)
const enemies = createEnemies({
  scene,
  player,
  camera,
  bodies,
  hands,
  sfx,
  gridTexture: objectGridTexture,
  fireBullet,
});

// Living world: motes, hand wakes and floor ripples, always moving (see ambience.js)
const ambience = createAmbience({ scene, player, hands, hemi });

// Hand command menu (see menu.js)
function conjureAhead() {
  const fwd = camera.getWorldDirection(new THREE.Vector3());
  fwd.y = 0;
  fwd.normalize();
  const p = camera.getWorldPosition(new THREE.Vector3()).addScaledVector(fwd, 1.5);
  spawnObject(p.x, 1.2, p.z, null);
}
const menu = createCommandMenu({
  sfx,
  scene,
  camera,
  hands,
  keys,
  commands: [
    { label: 'Conjure', color: 0xffe066, run: conjureAhead },
    { label: 'Time Warp', color: 0x74c0fc, run: () => setTimeScale(getTimeScale() < 1 ? 1 : 0.25) },
    { label: 'Reset', color: 0xff8787, run: () => resetObjects() },
    { label: 'Rewind', color: 0x9775fa, run: () => requestRewind(2.5) },
    { label: 'Gunman', color: 0xc92a2a, run: () => enemies.spawn('gunman') },
    { label: 'Sniper', color: 0x1864ab, run: () => enemies.spawn('sniper') },
    { label: 'Brute', color: 0x2b8a3e, run: () => enemies.spawn('brute') },
    { label: 'Clear foes', color: 0x868e96, run: () => enemies.clear() },
    { label: 'Calibrate', color: 0x20c997, run: () => calibration.start() },
    {
      label: isComfortMode(settings) ? 'Comfort: ON' : 'Comfort: OFF',
      color: 0x94d82d,
      run: () => {
        const on = !isComfortMode(settings);
        Object.assign(settings, on ? COMFORT_PRESET : DEFAULT_SETTINGS);
        saveSettings(settings);
        menu.setLabel(9, on ? 'Comfort: ON' : 'Comfort: OFF', 0x94d82d);
      },
    },
  ],
});

const clock = new THREE.Clock();
let elapsed = 0;
let physicsAccumulator = 0;

// ---------------------------------------------------------------------------
// Rewind: snapshots of every object and the player, replayed backwards
// ---------------------------------------------------------------------------
const HISTORY_SECONDS = 10;
const SNAPSHOT_INTERVAL = 1 / 30;
const REWIND_SPEED = 2;          // seconds of history replayed per real second
const history = [];              // { player: Vector3, bodies: [{ id, pos }] }
let snapshotTimer = 0;
let rewindCursor = 0;
let rewindWasActive = false;
let rewindHeld = false;          // held by a gesture or the Y key
let rewindTimer = 0;             // seconds requested by the menu

function setRewindHeld(v) {
  rewindHeld = v;
}
function requestRewind(seconds) {
  rewindTimer = Math.max(rewindTimer, seconds);
}

function takeSnapshot() {
  history.push({
    player: player.position.clone(),
    bodies: bodies.map((b) => ({ id: b.id, pos: b.mesh.position.clone() })),
  });
  const max = Math.round(HISTORY_SECONDS / SNAPSHOT_INTERVAL);
  if (history.length > max) history.shift();
}

function restoreSnapshot(snap) {
  player.position.copy(snap.player);
  for (const s of snap.bodies) {
    const b = bodies.find((x) => x.id === s.id);
    if (!b || b.isStatic) continue;
    b.mesh.position.copy(s.pos);
    b.vel.set(0, 0, 0);
    b.state = 'free';
    b.invMass = 1 / b.mass;
    b.hand = null;
    b.zoom = null;
  }
}

// Steps time backwards by one frame's worth of history. Returns true while rewinding.
function updateRewind(dt) {
  const active = rewindHeld || rewindTimer > 0;
  if (active && !rewindWasActive) sfx.play('rewind');
  rewindWasActive = active;
  if (rewindTimer > 0) rewindTimer = Math.max(0, rewindTimer - dt);
  if (!active) {
    rewindCursor = 0;
    return false;
  }
  // Let go of anything held, so the rewound world isn't fought over
  for (const h of hands) onGrabEnd(h);
  rewindCursor += dt * REWIND_SPEED;
  while (rewindCursor >= SNAPSHOT_INTERVAL && history.length > 1) {
    rewindCursor -= SNAPSHOT_INTERVAL;
    history.pop();
  }
  if (history.length > 0) restoreSnapshot(history[history.length - 1]);
  return true;
}

// Two clocks. `dt` is real time: you, your hands, gestures, powers and the menu
// always use it. `worldDt` is scaled: objects, physics, motes and rewind use it,
// so slow motion and time warp only change the world around you.
function animate() {
  const dt = Math.min(clock.getDelta(), 0.05);
  const worldDt = dt * timeScale * spiderSense.update(dt);
  elapsed += worldDt;

  updateMovement(dt);
  updateFloor();

  // Hands: velocity, visuals, colliders, grab zoom and held velocity
  for (const rig of hands) {
    rig.controller.getWorldPosition(tmpWorld);
    if (rig.hasPrev && dt > 0) {
      tmpB.copy(tmpWorld).sub(rig.prevPos).divideScalar(dt);
      // A hand that appears, vanishes or re-acquires far away is a jump, not a swing
      if (tmpB.length() > MAX_HAND_SPEED) {
        rig.vel.set(0, 0, 0);
      } else {
        rig.vel.lerp(tmpB, 0.5);
      }
    } else {
      rig.vel.set(0, 0, 0);
    }
    rig.prevPos.copy(tmpWorld);
    rig.hasPrev = true;

    if (!rig.built) buildHandVisuals(rig);
    if (rig.built) {
      updateHandBones(rig);
      updateHandColliders(rig, dt);
    }

    if (rig.held) {
      if (rig.held.state === 'zoom') updateZoom(rig, dt);
      if (rig.held.state === 'held') rig.held.vel.copy(rig.vel);
    }
  }

  cleanupBullets();
  enemies.update(worldDt);
  powers.update(dt, worldDt);
  calibration.update(dt);
  comfort.update(dt);
  tools.update(dt);
  menu.update(dt);
  ambience.update(worldDt, elapsed);
  checkClapReset(dt);

  // Build the list of colliders for this frame
  activeList = bodies.filter((b) => !b.isStatic);
  for (const rig of hands) {
    for (const kb of rig.kinJoints.values()) if (kb.active) activeList.push(kb);
    if (rig.kinController.active) activeList.push(rig.kinController);
  }

  if (updateRewind(worldDt)) {
    physicsAccumulator = 0;
  } else {
    snapshotTimer += worldDt;
    if (snapshotTimer >= SNAPSHOT_INTERVAL) {
      snapshotTimer = 0;
      takeSnapshot();
    }
    physicsAccumulator = stepPhysics(worldDt, physicsAccumulator);
  }

  // Trails
  camera.getWorldPosition(_camPos);
  for (const b of bodies) {
    if (!b.trail) continue;
    const moving = b.state === 'zoom' || b.vel.length() > TRAIL_MIN_SPEED;
    updateTrail(b, elapsed, moving);
  }

  renderer.render(scene, camera);
}

renderer.setAnimationLoop(animate);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// Test hook for automated checks (read-only use)
window.__sandbox = { player, bodies, camera, spiderSense, powers, enemies, TUNING, calibration, settings, hands };
