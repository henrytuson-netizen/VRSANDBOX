import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Doctor Octopus: giant robotic arms that copy the player's hands.
//
//   Deploy/retract : toggled by a both-hand pinch (or T on desktop).
//   Mirroring      : each arm's tip follows its hand, scaled up from the shoulder.
//   Grip           : pinch while deployed. The tip grabs the nearest object in
//                    reach (any mass), or plants on the floor if it is low.
//   Winch          : while planted, pulling your hand back toward you draws the
//                    whole player toward the plant point.
//   Lift           : while planted, pushing your hand down lifts the player.
//
// Arms are FABRIK chains of rigid links, so they bend like robot tentacles.
// ---------------------------------------------------------------------------

const UP = new THREE.Vector3(0, 1, 0);

const LINKS = 10;
const LINK_LEN = 0.8;                       // m, each link
const MAX_REACH = LINKS * LINK_LEN;         // 8 m
const MIRROR_GAIN = 5;                      // hand offset from shoulder is scaled by this
const GRAB_RANGE = 0.8;                     // m from tip to object surface
const PLANT_HEIGHT = 0.6;                   // tip below this height can plant on the floor
const LIFT_GAIN = 2.5;
const MAX_LIFT_SPEED = 6;
const WINCH_GAIN = 1.8;
const MAX_WINCH_SPEED = 7;
const GRAVITY = 9.8;
const MAX_PLAYER_HEIGHT = 60;
const RADIUS_BASE = 0.22;                   // thick at the shoulder
const RADIUS_TIP = 0.09;                    // thin at the tip
const SHOULDER_HALF_WIDTH = 0.22;
const SHOULDER_HEIGHT = 1.35;

const _t = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _h = new THREE.Vector3();
const _pull = new THREE.Vector3();

function safeNormalize(v, fallback) {
  const len = v.length();
  if (len < 1e-6) return v.copy(fallback);
  return v.divideScalar(len);
}

function bodyReach(b) {
  return (b.shape === 'sphere' ? b.r : Math.max(b.half.x, b.half.y, b.half.z));
}

// FABRIK: pull the chain's tip to `target` while keeping the base at `base`.
function solveChain(points, base, target) {
  const n = points.length;
  const dist = base.distanceTo(target);
  if (dist > MAX_REACH) {
    _dir.subVectors(target, base).normalize();
    target = _t.copy(base).addScaledVector(_dir, MAX_REACH);
  }
  for (let iter = 0; iter < 4; iter++) {
    points[n - 1].copy(target);
    for (let i = n - 2; i >= 0; i--) {
      _dir.subVectors(points[i], points[i + 1]);
      safeNormalize(_dir, UP);
      points[i].copy(points[i + 1]).addScaledVector(_dir, LINK_LEN);
    }
    points[0].copy(base);
    for (let i = 0; i < n - 1; i++) {
      _dir.subVectors(points[i + 1], points[i]);
      safeNormalize(_dir, UP);
      points[i + 1].copy(points[i]).addScaledVector(_dir, LINK_LEN);
    }
  }
}

export function createOctopus({ scene, player, bodies, gridTexture }) {
  const armMaterial = new THREE.MeshStandardMaterial({
    color: 0x3a3f4b,
    map: gridTexture,
    metalness: 0.85,
    roughness: 0.35,
  });
  const jointMaterial = new THREE.MeshStandardMaterial({
    color: 0xff8a2b,
    emissive: 0xff6a00,
    emissiveIntensity: 0.8,
    map: gridTexture,
    roughness: 0.3,
  });
  const linkGeometry = new THREE.CylinderGeometry(1, 1, 1, 14, 1);
  const jointGeometry = new THREE.SphereGeometry(1, 14, 10);

  let deployed = false;
  let vy = 0;

  function makeArm(side) {
    const root = new THREE.Group();
    root.visible = false;
    scene.add(root);

    const links = [];
    for (let i = 0; i < LINKS; i++) {
      const m = new THREE.Mesh(linkGeometry, armMaterial);
      root.add(m);
      links.push(m);
    }
    const joints = [];
    for (let i = 0; i <= LINKS; i++) {
      const m = new THREE.Mesh(jointGeometry, jointMaterial);
      root.add(m);
      joints.push(m);
    }

    return {
      side,                                    // -1 left, +1 right
      root,
      links,
      joints,
      points: Array.from({ length: LINKS + 1 }, () => new THREE.Vector3()),
      shoulder: new THREE.Vector3(),
      target: new THREE.Vector3(),
      tip: new THREE.Vector3(),
      handVel: new THREE.Vector3(),
      handPrev: new THREE.Vector3(),
      hasPrev: false,
      gripPrev: false,
      grabbed: null,
      anchor: null,
      initialised: false,
    };
  }

  const arms = [makeArm(-1), makeArm(1)];

  function setDeployed(value) {
    if (value === deployed) return;
    deployed = value;
    for (const arm of arms) {
      if (!deployed) {
        releaseArm(arm);
        arm.anchor = null;
      } else {
        // Don't grab on the same pinch that deployed us
        arm.gripPrev = true;
      }
    }
  }

  function isDeployed() {
    return deployed;
  }

  function grab(arm, b) {
    arm.grabbed = b;
    b.state = 'tentacle';
    b.invMass = 0;
    b.vel.set(0, 0, 0);
  }

  function releaseArm(arm) {
    const b = arm.grabbed;
    if (!b) return;
    b.state = 'free';
    b.invMass = 1 / b.mass;
    b.vel.copy(arm.handVel);
    if (b.vel.length() > 12) b.vel.setLength(12);
    arm.grabbed = null;
  }

  // Nearest free object within reach of the tip, any mass
  function findGrab(tip) {
    let best = null;
    let bestD = GRAB_RANGE;
    for (const b of bodies) {
      if (b.state !== 'free') continue;
      const d = b.center.distanceTo(tip) - bodyReach(b);
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    return best;
  }

  function updateArm(arm, dt, input) {
    arm.root.visible = deployed;
    if (!deployed) {
      releaseArm(arm);
      arm.anchor = null;
      arm.hasPrev = false;
      return;
    }

    // Shoulder sits on the player's torso, in world space
    player.updateWorldMatrix(true, false);
    arm.shoulder.set(arm.side * SHOULDER_HALF_WIDTH, SHOULDER_HEIGHT, 0);
    player.localToWorld(arm.shoulder);

    // Hand velocity and mirrored target
    const hasHand = !!(input && input.pos);
    if (hasHand) {
      if (arm.hasPrev && dt > 0) {
        arm.handVel.copy(input.vel);
      }
      arm.handPrev.copy(input.pos);
      arm.hasPrev = true;
      _t.subVectors(input.pos, arm.shoulder).multiplyScalar(MIRROR_GAIN);
      arm.target.copy(arm.shoulder).add(_t);
    } else {
      // No hand: rest the arm out in front of the player
      arm.handVel.set(0, 0, 0);
      arm.hasPrev = false;
      _dir.set(0, 0, -1).transformDirection(player.matrixWorld);
      arm.target.copy(arm.shoulder).addScaledVector(_dir, 2).add(_t.set(0, -0.6, 0));
    }

    if (arm.anchor) arm.target.copy(arm.anchor);

    // Pose the chain
    if (!arm.initialised) {
      arm.points.forEach((p) => p.copy(arm.shoulder));
      arm.initialised = true;
    }
    solveChain(arm.points, arm.shoulder, arm.target);
    arm.tip.copy(arm.points[LINKS]);

    // Grip: rising edge grabs or plants, falling edge lets go
    const grip = !!(input && input.grip);
    if (grip && !arm.gripPrev) {
      if (!arm.grabbed && !arm.anchor) {
        const b = findGrab(arm.tip);
        if (b) {
          grab(arm, b);
        } else if (arm.tip.y < PLANT_HEIGHT) {
          arm.anchor = arm.tip.clone();
          arm.anchor.y = 0.05;
        }
      }
    } else if (!grip && arm.gripPrev) {
      releaseArm(arm);
      arm.anchor = null;
    }
    arm.gripPrev = grip;

    // Held object follows the tip
    if (arm.grabbed) {
      const b = arm.grabbed;
      const s = b.mesh.scale.x;
      const newBase = _t.copy(arm.tip).sub(_mid.copy(b.localCenter).multiplyScalar(s));
      b.mesh.position.copy(newBase);
      b.vel.copy(arm.handVel);
    }

    renderArm(arm);
  }

  function renderArm(arm) {
    const pts = arm.points;
    for (let i = 0; i < LINKS; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const r = THREE.MathUtils.lerp(RADIUS_BASE, RADIUS_TIP, i / (LINKS - 1));
      _dir.subVectors(b, a);
      const len = _dir.length();
      const link = arm.links[i];
      link.position.copy(_mid.addVectors(a, b).multiplyScalar(0.5));
      if (len > 1e-6) link.quaternion.setFromUnitVectors(UP, _dir.divideScalar(len));
      link.scale.set(r, len, r);
    }
    for (let i = 0; i <= LINKS; i++) {
      const r = THREE.MathUtils.lerp(RADIUS_BASE, RADIUS_TIP, Math.min(i, LINKS - 1) / (LINKS - 1));
      const joint = arm.joints[i];
      joint.position.copy(pts[i]);
      const gripBoost = i === LINKS && arm.gripPrev ? 1.6 : 1;
      joint.scale.setScalar(r * 1.25 * gripBoost);
    }
  }

  // Winch and lift from planted arms
  function applyPlantedMotion(dt) {
    let pull = 0;
    let lift = 0;
    _pull.set(0, 0, 0);
    let planted = 0;

    for (const arm of arms) {
      if (!arm.anchor || !deployed) continue;
      planted++;
      // Horizontal direction from the body toward the plant point
      _h.subVectors(arm.anchor, arm.shoulder);
      _h.y = 0;
      if (_h.lengthSq() > 0.04) {
        _h.normalize();
        // Hand moving back toward the body = pulling yourself forward
        pull += Math.max(0, -arm.handVel.dot(_h));
        _pull.add(_h);
      }
      // Hand moving down while planted = pushing off the floor
      lift += Math.max(0, -arm.handVel.y);
    }
    if (planted === 0) return;

    if (pull > 0 && _pull.lengthSq() > 1e-6) {
      _pull.normalize();
      const step = Math.min(MAX_WINCH_SPEED, pull * WINCH_GAIN) * dt;
      player.position.addScaledVector(_pull, step);
    }
    if (lift > 0) {
      vy = Math.max(vy, Math.min(MAX_LIFT_SPEED, lift * LIFT_GAIN));
    }
  }

  // Inputs: { left: { pos, vel, grip }, right: { pos, vel, grip } }
  function update(dt, time, inputs) {
    for (const arm of arms) {
      const input = arm.side === -1 ? inputs.left : inputs.right;
      updateArm(arm, dt, input);
    }
    applyPlantedMotion(dt);
  }

  // Gravity and lift for the player. Called every frame.
  function updatePlayer(dt, flying) {
    if (flying) {
      vy = 0;
      return;
    }
    vy -= GRAVITY * dt;
    player.position.y += vy * dt;
    if (player.position.y <= 0) {
      player.position.y = 0;
      vy = 0;
    } else if (player.position.y > MAX_PLAYER_HEIGHT) {
      player.position.y = MAX_PLAYER_HEIGHT;
      vy = 0;
    }
  }

  function reset() {
    for (const arm of arms) {
      releaseArm(arm);
      arm.anchor = null;
      arm.gripPrev = false;
    }
    vy = 0;
  }

  return { update, updatePlayer, setDeployed, isDeployed, reset };
}
