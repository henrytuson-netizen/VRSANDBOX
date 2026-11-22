import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

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
// Scene, camera, lights
// ---------------------------------------------------------------------------
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0d12);

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 200);
camera.position.set(0, 1.6, 1);

// Desktop preview controls (ignored while in VR)
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.8, -2);
controls.update();

scene.add(new THREE.HemisphereLight(0xbfd8ff, 0x202030, 1.2));
const sun = new THREE.DirectionalLight(0xffffff, 1.5);
sun.position.set(3, 6, 2);
scene.add(sun);

// ---------------------------------------------------------------------------
// Floor + grid (1 m cells)
// ---------------------------------------------------------------------------
const FLOOR_SIZE = 40;

const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(FLOOR_SIZE, FLOOR_SIZE),
  new THREE.MeshBasicMaterial({ color: 0x10141c })
);
floor.rotation.x = -Math.PI / 2;
floor.position.y = -0.002;
scene.add(floor);

const grid = new THREE.GridHelper(FLOOR_SIZE, FLOOR_SIZE, 0x3ddc97, 0x1f5a45);
scene.add(grid);

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
  const material = new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.1 });
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
makeObject({ geometry: new THREE.BoxGeometry(1, 1, 1), color: 0x495057, x: 2.2, z: -2.2, isStatic: true });
makeObject({ geometry: new THREE.BoxGeometry(0.3, 2, 0.3), color: 0x343a40, x: -2.4, z: -2.6, isStatic: true });

const dynamicObjects = objects.filter((o) => !o.userData.isStatic);

function resetObjects() {
  for (const obj of objects) {
    if (obj.userData.held) continue;
    obj.position.copy(obj.userData.home);
    obj.userData.vel.set(0, 0, 0);
  }
}

addEventListener('keydown', (e) => {
  if (e.key === 'r' || e.key === 'R') resetObjects();
});

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

const rigs = [0, 1].map((i) => {
  const color = i === 0 ? 0x4fc3ff : 0xff8a4f;

  const controller = renderer.xr.getController(i);
  const grip = renderer.xr.getControllerGrip(i);
  const hand = renderer.xr.getHand(i);

  // Pointing ray
  const ray = new THREE.Line(
    rayGeometry,
    new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.6 })
  );
  controller.add(ray);

  // Simple controller body
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(0.018, 0.018, 0.12, 12),
    new THREE.MeshStandardMaterial({ color: 0x222831, roughness: 0.6 })
  );
  body.rotation.x = Math.PI / 2;
  grip.add(body);

  scene.add(controller, grip, hand);

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
function buildHandVisuals(rig) {
  const joints = rig.hand.joints;
  if (!joints || Object.keys(joints).length === 0) return;

  const material = new THREE.MeshStandardMaterial({
    color: rig.color,
    emissive: rig.color,
    emissiveIntensity: 0.3,
    roughness: 0.4,
  });

  for (const name of Object.keys(joints)) {
    const r = name === 'wrist' ? 0.012 : name.endsWith('tip') ? 0.007 : 0.009;
    const marker = new THREE.Mesh(jointGeometry, material);
    marker.scale.setScalar(r);
    joints[name].add(marker); // child inherits joint visibility from three.js
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

function grab(rig) {
  if (rig.held) return;

  let target = null;

  // 1. Ray hit
  setRayFromController(rig.controller);
  const hit = raycaster.intersectObjects(objects, false)[0];
  if (hit && !hit.object.userData.isStatic) {
    target = hit.object;
  }

  // 2. Proximity fallback (useful for hands)
  if (!target) {
    rig.controller.getWorldPosition(tmpWorld);
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

  rig.held = target;
  target.userData.held = true;
  target.userData.vel.set(0, 0, 0);
  rig.controller.attach(target); // keeps world transform
}

function release(rig) {
  const obj = rig.held;
  if (!obj) return;

  rig.held = null;
  scene.attach(obj); // back to scene, keeps world transform
  obj.userData.held = false;

  // Throw with the hand's recent velocity (clamped)
  obj.userData.vel.copy(rig.vel);
  if (obj.userData.vel.length() > 8) obj.userData.vel.setLength(8);
}

rigs.forEach((rig) => {
  rig.controller.addEventListener('selectstart', () => grab(rig));
  rig.controller.addEventListener('selectend', () => release(rig));
});

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------
const clock = new THREE.Clock();

function animate() {
  const dt = Math.min(clock.getDelta(), 0.05);

  if (!renderer.xr.isPresenting) controls.update();

  for (const rig of rigs) {
    // Track hand velocity for throwing
    rig.controller.getWorldPosition(tmpWorld);
    if (rig.hasPrev && dt > 0) {
      tmpB.copy(tmpWorld).sub(rig.prev).divideScalar(dt);
      rig.vel.lerp(tmpB, 0.5);
    }
    rig.prev.copy(tmpWorld);
    rig.hasPrev = true;

    if (!rig.built) buildHandVisuals(rig);
    if (rig.built) updateHandBones(rig);
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
