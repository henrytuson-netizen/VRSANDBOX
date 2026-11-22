import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';

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
// Fog hides the edge of the floor and gives the grid an endless horizon.
scene.fog = new THREE.Fog(BACKGROUND, 25, 140);

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 250);
camera.position.set(0, 1.6, 0); // desktop eye height; XR overrides this with the headset pose

const player = new THREE.Group();
scene.add(player);
player.add(camera);

scene.add(new THREE.HemisphereLight(0xffffff, 0x404050, 1.4));
const sun = new THREE.DirectionalLight(0xffffff, 1.2);
sun.position.set(3, 6, 2);
scene.add(sun);

// ---------------------------------------------------------------------------
// Unity-style default grid texture (procedural, no downloads).
// Light grey tile with a darker seam line on every edge, so tiling produces
// a grid line at each tile boundary.
// ---------------------------------------------------------------------------
function makeGridTexture(repeat = 1) {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#c7c7c7';
  ctx.fillRect(0, 0, size, size);

  // Faint half-tile guides, like Unity's default grid
  ctx.strokeStyle = '#b4b4b4';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(size / 2, 0); ctx.lineTo(size / 2, size);
  ctx.moveTo(0, size / 2); ctx.lineTo(size, size / 2);
  ctx.stroke();

  // Seam border: 2px on each side of the edge, so 4px where tiles meet
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

// Shared texture for every object (one tile per UV unit, as in Unity)
const objectGridTexture = makeGridTexture(1);

// ---------------------------------------------------------------------------
// Infinite floor
// A large plane that follows the player, snapped to whole metres. With one
// texture tile per metre and an even plane size, the grid lines stay fixed in
// world space while the plane moves underneath. Fog fades the edge out.
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
// Test objects
// Geometry is normalised so the origin sits at the bottom-centre of each
// object, which makes floor contact simple (position.y === 0 means resting).
// ---------------------------------------------------------------------------
const objects = [];

function makeObject({ geometry, color, x, z, scale = 1, isStatic = false }) {
  geometry.computeBoundingBox();
  const bb = geometry.boundingBox;
  geometry.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  const height = (geometry.boundingBox.max.y - geometry.boundingBox.min.y) * scale;
  const material = new THREE.MeshStandardMaterial({
    color,
    map: objectGridTexture,
    roughness: 0.5,
    metalness: 0.1,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.scale.setScalar(scale);
  mesh.position.set(x, 0, z);
  mesh.userData = {
    home: mesh.position.clone(),
    isStatic,
    held: false,
    vel: new THREE.Vector3(),
    center: new THREE.Vector3(0, height / 2, 0), // local-space centre for proximity grabs
    radius: geometry.boundingSphere.radius * scale,
  };

  scene.add(mesh);
  objects.push(mesh);
  return mesh;
}

// Dynamic test objects, in a row in front of the start position
makeObject({ geometry: new THREE.BoxGeometry(0.3, 0.3, 0.3), color: 0xff6b6b, x: -1.2, z: -1.5 });
makeObject({ geometry: new THREE.SphereGeometry(0.18, 32, 16), color: 0x4dabf7, x: -0.6, z: -1.5 });
makeObject({ geometry: new THREE.CylinderGeometry(0.15, 0.15, 0.4, 32), color: 0xffd43b, x: 0, z: -1.5 });
makeObject({ geometry: new THREE.ConeGeometry(0.18, 0.4, 32), color: 0x69db7c, x: 0.6, z: -1.5 });
makeObject({ geometry: new THREE.TorusGeometry(0.15, 0.05, 16, 48).rotateX(Math.PI / 2), color: 0xda77f2, x: 1.2, z: -1.5 });
makeObject({ geometry: new THREE.OctahedronGeometry(0.2), color: 0xffa94d, x: -0.4, z: -2.4 });
makeObject({ geometry: new THREE.BoxGeometry(0.2, 0.2, 0.2), color: 0x3bc9db, x: 0.4, z: -2.4 });

// Static scale references
makeObject({ geometry: new THREE.BoxGeometry(1, 1, 1), color: 0x9aa0a6, x: 2.2, z: -2.2, isStatic: true });
makeObject({ geometry: new THREE.BoxGeometry(0.3, 2, 0.3), color: 0x6c757d, x: -2.4, z: -2.6, isStatic: true });

const dynamicObjects = objects.filter((o) => !o.userData.isStatic);

function resetObjects() {
  for (const obj of objects) {
    if (obj.userData.held) continue;
    obj.position.copy(obj.userData.home);
    obj.userData.vel.set(0, 0, 0);
  }
}

// ---------------------------------------------------------------------------
// Physics-lite: gravity, floor bounce, friction
// ---------------------------------------------------------------------------
const GRAVITY = 9.8;

function updatePhysics(dt) {
  if (dt <= 0) return;
  for (const obj of dynamicObjects) {
    const u = obj.userData;
    if (u.held) continue;

    u.vel.y -= GRAVITY * dt;
    obj.position.addScaledVector(u.vel, dt);

    if (obj.position.y < 0) {
      obj.position.y = 0;
      if (u.vel.y < -0.3) {
        u.vel.y *= -0.35; // bounce
      } else {
        u.vel.y = 0;
      }
      const friction = Math.exp(-6 * dt);
      u.vel.x *= friction;
      u.vel.z *= friction;
    }
  }
}

// ---------------------------------------------------------------------------
// Controllers, grips, hands
// ---------------------------------------------------------------------------
const rayGeometry = new THREE.BufferGeometry().setFromPoints([
  new THREE.Vector3(0, 0, 0),
  new THREE.Vector3(0, 0, -1.5),
]);

// Bone chains per finger (wrist is prepended at runtime)
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
// Palm cross-links between metacarpals
BONE_SEGMENTS.push(
  ['index-finger-metacarpal', 'middle-finger-metacarpal'],
  ['middle-finger-metacarpal', 'ring-finger-metacarpal'],
  ['ring-finger-metacarpal', 'pinky-finger-metacarpal']
);

const jointGeometry = new THREE.SphereGeometry(1, 12, 8);
const tmpWorld = new THREE.Vector3();
const tmpB = new THREE.Vector3();

const hands = [0, 1].map((i) => {
  const color = i === 0 ? 0x4fc3ff : 0xff8a4f;

  const controller = renderer.xr.getController(i);
  const grip = renderer.xr.getControllerGrip(i);
  const hand = renderer.xr.getHand(i);

  // Pointing ray (lines can't use the grid texture)
  const ray = new THREE.Line(
    rayGeometry,
    new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.6 })
  );
  controller.add(ray);

  // Simple controller body
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(0.018, 0.018, 0.12, 12),
    new THREE.MeshStandardMaterial({ color: 0xffffff, map: objectGridTexture, roughness: 0.6 })
  );
  body.rotation.x = Math.PI / 2;
  grip.add(body);

  // Input objects live under the player so they move with locomotion
  player.add(controller, grip, hand);

  return {
    index: i,
    color,
    controller,
    grip,
    hand,
    held: null,
    prev: new THREE.Vector3(),
    vel: new THREE.Vector3(),
    hasPrev: false,
    built: false,
    lines: null,
    positions: null,
  };
});

// Adds sphere markers to each hand joint (joints are created by three.js on
// hand-tracking connect) and a LineSegments for bones.
function buildHandVisuals(hand) {
  const joints = hand.hand.joints;
  if (!joints || Object.keys(joints).length === 0) return;

  const material = new THREE.MeshStandardMaterial({
    color: hand.color,
    map: objectGridTexture,
    emissive: hand.color,
    emissiveIntensity: 0.25,
    roughness: 0.4,
  });

  for (const name of Object.keys(joints)) {
    const r = name === 'wrist' ? 0.012 : name.endsWith('tip') ? 0.007 : 0.009;
    const marker = new THREE.Mesh(jointGeometry, material);
    marker.scale.setScalar(r);
    joints[name].add(marker); // child inherits joint visibility from three.js
  }

  hand.positions = new Float32Array(BONE_SEGMENTS.length * 6);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(hand.positions, 3));
  hand.lines = new THREE.LineSegments(
    geometry,
    new THREE.LineBasicMaterial({ color: hand.color, transparent: true, opacity: 0.8 })
  );
  hand.lines.frustumCulled = false;
  scene.add(hand.lines);

  hand.built = true;
}

function updateHandBones(hand) {
  const joints = hand.hand.joints;
  const wrist = joints && joints.wrist;
  if (!wrist || !hand.lines) return;

  hand.lines.visible = wrist.visible;
  if (!wrist.visible) return;

  const pos = hand.positions;
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
  hand.lines.geometry.attributes.position.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// Grabbing: controller trigger / hand pinch (both fire select events)
// ---------------------------------------------------------------------------
const raycaster = new THREE.Raycaster();
raycaster.far = 3;
const rayDir = new THREE.Vector3();

// Aim the raycaster along the controller's -Z axis (same as the pointing ray).
// Raycaster.setFromXRController isn't available in three r160, so do it by hand.
function setRayFromController(controller) {
  controller.updateWorldMatrix(true, false);
  raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
  rayDir.set(0, 0, -1).transformDirection(controller.matrixWorld);
  raycaster.ray.direction.copy(rayDir);
}

function grab(hand) {
  if (hand.held) return;

  let target = null;

  // 1. Ray hit
  setRayFromController(hand.controller);
  const hit = raycaster.intersectObjects(objects, false)[0];
  if (hit && !hit.object.userData.isStatic) {
    target = hit.object;
  }

  // 2. Proximity fallback (useful for hands)
  if (!target) {
    hand.controller.getWorldPosition(tmpWorld);
    let best = 0.15;
    for (const obj of dynamicObjects) {
      tmpB.copy(obj.userData.center);
      obj.localToWorld(tmpB);
      const d = tmpB.distanceTo(tmpWorld);
      if (d < best) {
        best = d;
        target = obj;
      }
    }
  }

  if (!target) return;

  hand.held = target;
  target.userData.held = true;
  target.userData.vel.set(0, 0, 0);
  hand.controller.attach(target); // keeps world transform
}

function release(hand) {
  const obj = hand.held;
  if (!obj) return;

  hand.held = null;
  scene.attach(obj); // back to scene, keeps world transform
  obj.userData.held = false;

  // Throw with the hand's recent velocity (clamped)
  obj.userData.vel.copy(hand.vel);
  if (obj.userData.vel.length() > 8) obj.userData.vel.setLength(8);
}

hands.forEach((hand) => {
  hand.controller.addEventListener('selectstart', () => grab(hand));
  hand.controller.addEventListener('selectend', () => release(hand));
});

// ---------------------------------------------------------------------------
// Movement
//   Desktop: WASD / arrows to walk (Shift to run), Q/E to turn,
//            left-drag to look, R to reset objects.
//   VR:      left stick to walk (relative to head yaw), right stick to turn.
// ---------------------------------------------------------------------------
const WALK_SPEED = 2.5;
const RUN_SPEED = 5;
const DESKTOP_TURN_SPEED = 1.7; // rad/s
const STICK_TURN_SPEED = 1.7;   // rad/s, smooth turn
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
  return Math.sign(v) * (Math.abs(v) - DEADZONE) / (1 - DEADZONE);
}

// Reads thumbsticks from the XR session. Left = move, right = turn.
// Quest/most controllers expose sticks on axes[2]/[3]; fall back to [0]/[1].
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

// Compute forward/right from the head's yaw (flattened to the ground plane)
function updateHeadingVectors() {
  camera.updateWorldMatrix(true, false);
  camera.getWorldDirection(moveForward);
  moveForward.y = 0;
  if (moveForward.lengthSq() < 1e-6) moveForward.set(0, 0, -1);
  moveForward.normalize();
  moveRight.crossVectors(moveForward, UP).normalize();
}

function updateMovement(dt) {
  if (dt <= 0) return;

  let strafe = 0;   // -1 left .. +1 right
  let forward = 0;  // -1 back  .. +1 forward
  let turn = 0;     // -1 left  .. +1 right
  let speed = WALK_SPEED;

  if (renderer.xr.isPresenting) {
    const { left, right } = readXRSticks();
    strafe = applyDeadzone(left.x);
    forward = -applyDeadzone(left.y); // pushing the stick forward gives negative y
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

  // Normalise diagonals so they aren't faster
  const mag = Math.hypot(strafe, forward);
  if (mag > 1) {
    strafe /= mag;
    forward /= mag;
  }

  if (turn !== 0) {
    player.rotation.y -= turn * (renderer.xr.isPresenting ? STICK_TURN_SPEED : DESKTOP_TURN_SPEED) * dt;
  }

  if (strafe !== 0 || forward !== 0) {
    updateHeadingVectors();
    moveDelta.set(0, 0, 0)
      .addScaledVector(moveForward, forward)
      .addScaledVector(moveRight, strafe);
    player.position.addScaledVector(moveDelta, speed * dt);
  }
}

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------
const clock = new THREE.Clock();

function animate() {
  const dt = Math.min(clock.getDelta(), 0.05);

  updateMovement(dt);
  updateFloor();

  for (const hand of hands) {
    // Track hand velocity for throwing (world space)
    hand.controller.getWorldPosition(tmpWorld);
    if (hand.hasPrev && dt > 0) {
      tmpB.copy(tmpWorld).sub(hand.prev).divideScalar(dt);
      hand.vel.lerp(tmpB, 0.5);
    }
    hand.prev.copy(tmpWorld);
    hand.hasPrev = true;

    if (!hand.built) buildHandVisuals(hand);
    if (hand.built) updateHandBones(hand);
  }

  updatePhysics(dt);
  renderer.render(scene, camera);
}

renderer.setAnimationLoop(animate);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
