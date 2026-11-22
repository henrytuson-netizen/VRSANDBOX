import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Doctor Octopus: giant robotic arms that mirror the player's hands.
//
//   Structure : shoulder -> upper arm -> elbow -> forearm -> wrist -> claw.
//               Two-bone IK, so the wrist (and claw) sit exactly where the
//               mirrored hand is, and the elbow bends on its own.
//   Deploy    : toggled by a both-hand pinch (or T on desktop).
//   Mirroring : the wrist target is the hand's offset from the shoulder,
//               multiplied by MIRROR_GAIN, so the reach is much longer.
//   Grip      : pinch while deployed. The claw grabs the nearest object in
//               reach (any mass), or plants on the floor if it is low.
//   Winch     : while planted, pulling the hand back toward you draws the
//               player toward the plant point.
//   Lift      : while planted, pushing the hand down lifts the player.
// ---------------------------------------------------------------------------

const UP = new THREE.Vector3(0, 1, 0);

const UPPER_LEN = 4.0;            // m, shoulder -> elbow
const LOWER_LEN = 4.0;            // m, elbow -> wrist
const MAX_REACH = UPPER_LEN + LOWER_LEN - 0.05;
const MIN_REACH = 0.8;
const MIRROR_GAIN = 4;            // hand offset from shoulder is multiplied by this
const FOLLOW_RATE = 20;           // how quickly the target follows the hand (per second)
const PALM_LEN = 0.16;            // wrist to the base of the claw
const FINGERS = 3;
const FINGER_LEN_1 = 0.24;        // knuckle segment
const FINGER_LEN_2 = 0.2;         // tip segment
const FINGER_R = 0.05;
const CURL_RATE = 10;             // how fast fingers open and close
const DOWN = new THREE.Vector3(0, -1, 0);
const GRAB_RANGE = 0.9;           // m from claw tip to object surface
const PLANT_HEIGHT = 0.8;         // claw tip below this can plant on the floor
const FLOOR_CLEARANCE = 0.15;     // targets are kept above this height

const SHOULDER_HALF_WIDTH = 0.45; // arms start wide of the head
const SHOULDER_DROP = 0.45;       // shoulders sit this far below the head

const UPPER_R = 0.28;
const LOWER_R = 0.2;
const CLAW_R = 0.12;              // palm radius

const WINCH_GAIN = 0.8;
const MAX_WINCH_SPEED = 2.5;
const LIFT_GAIN = 1.0;
const MAX_LIFT_SPEED = 2.5;
const GRAVITY = 9.8;
const MAX_PLAYER_HEIGHT = 60;

const _t = new THREE.Vector3();
const _d = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _p = new THREE.Vector3();
const _pull = new THREE.Vector3();
const _h = new THREE.Vector3();
const _head = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _claw = new THREE.Vector3();
const _clawD = new THREE.Vector3();   // claw direction (kept separate: placeBetween reuses _dir)

function bodyReach(b) {
  return b.shape === 'sphere' ? b.r : Math.max(b.half.x, b.half.y, b.half.z);
}

// Places a unit-height cylinder mesh between points a and b with a given radius.
function placeBetween(mesh, a, b, radius) {
  _mid.addVectors(a, b).multiplyScalar(0.5);
  _dir.subVectors(b, a);
  const len = _dir.length();
  mesh.position.copy(_mid);
  if (len > 1e-6) mesh.quaternion.setFromUnitVectors(UP, _dir.divideScalar(len));
  mesh.scale.set(radius, Math.max(len, 1e-4), radius);
}

// Two-bone IK. Writes the elbow into E and the wrist into W.
function solveTwoBone(S, T, pole, E, W) {
  _d.subVectors(T, S);
  let d = _d.length();
  if (d < 1e-5) {
    _d.set(0, 0, -1);
    d = 1e-5;
  }
  _dir.copy(_d).divideScalar(d);
  d = THREE.MathUtils.clamp(d, MIN_REACH, MAX_REACH);

  // Elbow lies on a circle around the shoulder->wrist line; the pole picks which side
  const a = (UPPER_LEN * UPPER_LEN - LOWER_LEN * LOWER_LEN + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, UPPER_LEN * UPPER_LEN - a * a));

  _p.copy(pole).addScaledVector(_dir, -pole.dot(_dir));
  if (_p.lengthSq() < 1e-6) _p.crossVectors(_dir, UP);
  if (_p.lengthSq() < 1e-6) _p.set(1, 0, 0);
  _p.normalize();

  E.copy(S).addScaledVector(_dir, a).addScaledVector(_p, h);
  W.copy(S).addScaledVector(_dir, d);
}

export function createOctopus({ scene, camera, player, bodies, gridTexture }) {
  const metal = new THREE.MeshStandardMaterial({
    color: 0x3a3f4b,
    map: gridTexture,
    metalness: 0.85,
    roughness: 0.35,
  });
  const glow = new THREE.MeshStandardMaterial({
    color: 0xff8a2b,
    emissive: 0xff6a00,
    emissiveIntensity: 0.8,
    map: gridTexture,
    roughness: 0.3,
  });
  const cylinderGeometry = new THREE.CylinderGeometry(1, 1, 1, 16, 1);
  const sphereGeometry = new THREE.SphereGeometry(1, 16, 12);

  let deployed = false;
  let vy = 0;

  function makeArm(side) {
    const root = new THREE.Group();
    root.visible = false;
    scene.add(root);

    const upper = new THREE.Mesh(cylinderGeometry, metal);
    const lower = new THREE.Mesh(cylinderGeometry, metal);
    const claw = new THREE.Mesh(sphereGeometry, glow);
    const jShoulder = new THREE.Mesh(sphereGeometry, glow);
    const jElbow = new THREE.Mesh(sphereGeometry, glow);
    const jWrist = new THREE.Mesh(sphereGeometry, glow);
    root.add(upper, lower, claw, jShoulder, jElbow, jWrist);

    // Procedural three-finger claw: each finger is two segments
    const fingers = [];
    for (let i = 0; i < FINGERS; i++) {
      const seg1 = new THREE.Mesh(cylinderGeometry, metal);
      const seg2 = new THREE.Mesh(cylinderGeometry, metal);
      const tip = new THREE.Mesh(sphereGeometry, glow);
      root.add(seg1, seg2, tip);
      fingers.push({ seg1, seg2, tip });
    }

    return {
      side,                              // -1 left, +1 right
      root, upper, lower, claw, jShoulder, jElbow, jWrist,
      shoulder: new THREE.Vector3(),
      elbow: new THREE.Vector3(),
      wrist: new THREE.Vector3(),
      clawTip: new THREE.Vector3(),
      clawDir: new THREE.Vector3(0, 0, -1),   // where the claw points: the hand's fingers
      fingers,
      curl: 0,                                // 0 open .. 1 closed around something
      curlTarget: 0,
      plantAmt: 0,                            // 0 hand direction .. 1 pointing down at the floor
      target: new THREE.Vector3(),
      smooth: new THREE.Vector3(),
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
        arm.initialised = false;
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

  // Nearest free object within reach of the claw tip, any mass
  function findGrab(point) {
    let best = null;
    let bestD = GRAB_RANGE;
    for (const b of bodies) {
      if (b.state !== 'free') continue;
      const d = b.center.distanceTo(point) - bodyReach(b);
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

    // Shoulder: below the head, out to this side
    arm.shoulder.copy(_head)
      .addScaledVector(UP, -SHOULDER_DROP)
      .addScaledVector(_right, arm.side * SHOULDER_HALF_WIDTH);

    // Target: the hand's offset from the shoulder, scaled up
    const hasHand = !!(input && input.pos);
    if (hasHand) {
      if (arm.hasPrev && dt > 0) arm.handVel.copy(input.vel);
      arm.handPrev.copy(input.pos);
      arm.hasPrev = true;
      _t.subVectors(input.pos, arm.shoulder).multiplyScalar(MIRROR_GAIN);
      arm.target.copy(arm.shoulder).add(_t);
    } else {
      // No hand: the arm hangs relaxed, out and slightly forward
      arm.handVel.set(0, 0, 0);
      arm.hasPrev = false;
      arm.target.copy(arm.shoulder)
        .addScaledVector(_right, arm.side * 0.2)
        .addScaledVector(_fwd, 0.6)
        .addScaledVector(UP, -1.2);
    }
    arm.target.y = Math.max(arm.target.y, FLOOR_CLEARANCE);

    // Follow the target smoothly (the wrist still tracks the hand closely)
    if (!arm.initialised) {
      arm.smooth.copy(arm.target);
      arm.initialised = true;
    }
    arm.smooth.lerp(arm.target, 1 - Math.exp(-FOLLOW_RATE * dt));
    if (arm.anchor) arm.smooth.copy(arm.anchor);

    // Elbow hangs down and back, like a robot arm
    _pole.copy(_right).multiplyScalar(arm.side * 0.5).addScaledVector(UP, -1.0).addScaledVector(_fwd, -0.1);
    solveTwoBone(arm.shoulder, arm.smooth, _pole, arm.elbow, arm.wrist);

    // Claw points where the hand points (fingers direction), smoothly
    if (input && input.dir && input.dir.lengthSq() > 1e-6) {
      arm.clawDir.lerp(input.dir, 1 - Math.exp(-FOLLOW_RATE * dt));
    } else {
      _claw.subVectors(arm.wrist, arm.elbow);
      if (_claw.lengthSq() < 1e-6) _claw.copy(UP);
      arm.clawDir.lerp(_claw.normalize(), 1 - Math.exp(-FOLLOW_RATE * dt));
    }
    if (arm.clawDir.lengthSq() < 1e-6) arm.clawDir.set(0, 0, -1);
    arm.clawDir.normalize();
    arm.clawTip.copy(arm.wrist).addScaledVector(arm.clawDir, PALM_LEN + 0.2);

    // Grip: rising edge grabs or plants, falling edge lets go
    const grip = !!(input && input.grip);
    if (grip && !arm.gripPrev) {
      if (!arm.grabbed && !arm.anchor) {
        const b = findGrab(arm.clawTip);
        if (b) {
          grab(arm, b);
        } else if (arm.clawTip.y < PLANT_HEIGHT) {
          arm.anchor = arm.clawTip.clone();
          arm.anchor.y = FLOOR_CLEARANCE;
        }
      }
    } else if (!grip && arm.gripPrev) {
      releaseArm(arm);
      arm.anchor = null;
    }
    arm.gripPrev = grip;

    // Held object follows the claw
    if (arm.grabbed) {
      const b = arm.grabbed;
      const s = b.mesh.scale.x;
      _t.copy(arm.clawTip).sub(_mid.copy(b.localCenter).multiplyScalar(s));
      b.mesh.position.copy(_t);
      b.vel.copy(arm.handVel);
    }

    // Procedural grab pose targets
    if (arm.anchor) {
      arm.curlTarget = 0.35;                     // splay to plant on the floor
    } else if (arm.grabbed) {
      arm.curlTarget = 0.85;                     // hug the object
    } else {
      arm.curlTarget = grip ? 0.6 : 0.0;         // close while pinching, otherwise open
    }
    arm.curl += (arm.curlTarget - arm.curl) * (1 - Math.exp(-CURL_RATE * dt));
    arm.plantAmt += ((arm.anchor ? 1 : 0) - arm.plantAmt) * (1 - Math.exp(-CURL_RATE * dt));

    renderArm(arm);
  }

  // Procedural grab poses: fingers curl inward around the object, or splay down to plant
  function renderClaw(arm) {
    const d = _clawD.copy(arm.clawDir).lerp(DOWN, arm.plantAmt).normalize();
    const palmEnd = _t.copy(arm.wrist).addScaledVector(arm.clawDir, PALM_LEN);
    arm.claw.position.copy(palmEnd);
    arm.claw.scale.setScalar(CLAW_R * (arm.curl * 0.2 + 1));

    // Basis perpendicular to the claw direction, to spread the fingers around
    _pole.crossVectors(d, UP);
    if (_pole.lengthSq() < 1e-4) _pole.crossVectors(d, _right);
    _pole.normalize();
    _p.crossVectors(d, _pole).normalize();

    const roll = 0.3;
    for (let i = 0; i < FINGERS; i++) {
      const phi = (i / FINGERS) * Math.PI * 2 + roll;
      // Outward spread direction for this finger
      _h.copy(_pole).multiplyScalar(Math.cos(phi)).addScaledVector(_p, Math.sin(phi));
      // Bend angles: open fingers fan slightly out, closed fingers curl inward
      const t1 = THREE.MathUtils.lerp(-0.2, 1.0, arm.curl);
      const t2 = t1 + THREE.MathUtils.lerp(0.0, 0.9, arm.curl);
      _mid.copy(d).multiplyScalar(Math.cos(t1)).addScaledVector(_h, -Math.sin(t1)).normalize();
      const knuckle = _claw.copy(palmEnd).addScaledVector(_mid, FINGER_LEN_1);
      const f = arm.fingers[i];
      placeBetween(f.seg1, palmEnd, knuckle, FINGER_R);

      _dir.copy(d).multiplyScalar(Math.cos(t2)).addScaledVector(_h, -Math.sin(t2)).normalize();
      const fingerTip = _pull.copy(knuckle).addScaledVector(_dir, FINGER_LEN_2);
      placeBetween(f.seg2, knuckle, fingerTip, FINGER_R * 0.9);
      f.tip.position.copy(fingerTip);
      f.tip.scale.setScalar(FINGER_R * 1.3);
    }
  }

  function renderArm(arm) {
    arm.jShoulder.position.copy(arm.shoulder);
    arm.jShoulder.scale.setScalar(UPPER_R * 1.1);
    placeBetween(arm.upper, arm.shoulder, arm.elbow, UPPER_R);

    arm.jElbow.position.copy(arm.elbow);
    arm.jElbow.scale.setScalar(UPPER_R * 0.9);
    placeBetween(arm.lower, arm.elbow, arm.wrist, LOWER_R);

    arm.jWrist.position.copy(arm.wrist);
    arm.jWrist.scale.setScalar(LOWER_R * 0.7);
    renderClaw(arm);
  }

  // Winch and lift from planted arms
  function applyPlantedMotion(dt) {
    let pull = 0;
    let lift = 0;
    let planted = 0;
    _pull.set(0, 0, 0);

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

  function computeHeadFrame() {
    camera.getWorldPosition(_head);
    camera.getWorldDirection(_fwd);
    _fwd.y = 0;
    if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, -1);
    _fwd.normalize();
    _right.crossVectors(_fwd, UP).normalize();
  }

  // Inputs: { left: { pos, vel, grip, dir }, right: { pos, vel, grip, dir } }
  function update(dt, time, inputs) {
    computeHeadFrame();
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
      arm.initialised = false;
    }
    vy = 0;
  }

  return { update, updatePlayer, setDeployed, isDeployed, reset };
}
