import * as THREE from 'three';

// ---------------------------------------------------------------------------
// The Spider power: one power, several abilities, each with its own hand pose
// so they never get mixed up. While Spider is equipped, spark, shockwave and
// gather are switched off, so their gestures can't fire by accident.
//
//   Spider-Sense : always on (bullet time, see spidersense.js).
//   Web Shot     : RIGHT gun pose (thumb and index out, other fingers curled),
//                  held for a moment. A web line goes to whatever it aims at.
//   Web Swing    : while attached, you swing like a pendulum. Open your LEFT
//                  palm to let go.
//   Web Trap     : RIGHT fist flicked forward. A web ball pins the first
//                  object it hits for a few seconds.
// ---------------------------------------------------------------------------

const SHOT_RANGE = 25;          // m
const SHOT_HOLD = 0.2;          // s the gun pose must be held
const SWING_GRAVITY = 9.8;
const SWING_DAMP = 0.02;        // per second, a little air drag
const BALL_SPEED = 16;          // m/s
const BALL_LIFE = 1.5;          // s
const TRAP_TIME = 6;            // s a pinned object stays stuck
const TRAP_FLICK = 2.6;         // m/s relative to the body

const _h = new THREE.Vector3();
const _a = new THREE.Vector3();
const _d = new THREE.Vector3();
const _v = new THREE.Vector3();

function gunPose(p) {
  const f = p.fingers;
  return f.thumb && f.index && !f.middle && !f.ring && !f.pinky;
}
function fistPose(p) {
  const f = p.fingers;
  return !f.index && !f.middle && !f.ring && !f.pinky;
}
function openPose(p) {
  const f = p.fingers;
  return f.index && f.middle && f.ring && f.pinky;
}

export function createSpider({ scene, player, camera, bodies }) {
  let attached = null;            // { anchor: Vector3, body: body|null, length }
  let swingVel = new THREE.Vector3();
  let shotHold = 0;
  let shotCooldown = 0;
  const balls = [];
  const trapped = new Map();      // body -> seconds left
  let flickCooldown = 0;

  // Web line from the right hand to the anchor
  const lineGeometry = new THREE.BufferGeometry();
  lineGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
  const line = new THREE.Line(lineGeometry, new THREE.LineBasicMaterial({ color: 0xffffff }));
  line.visible = false;
  line.frustumCulled = false;
  scene.add(line);

  const ballGeometry = new THREE.SphereGeometry(0.06, 12, 8);
  const ballMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });

  function aimShot(pose) {
    // Nearest body along the index finger, otherwise a point far out along it
    let best = null;
    let bestT = SHOT_RANGE;
    for (const b of bodies) {
      if (b.state !== 'free') continue;
      _d.subVectors(b.center, pose.idxTip);
      const t = _d.dot(pose.indexDir);
      if (t < 0.3 || t > bestT) continue;
      _a.copy(pose.idxTip).addScaledVector(pose.indexDir, t);
      const reach = (b.shape === 'sphere' ? b.r : Math.max(b.half.x, b.half.y, b.half.z));
      if (_a.distanceTo(b.center) < reach + 0.15) {
        bestT = t;
        best = b;
      }
    }
    if (best) return { anchor: best.center.clone(), body: best };
    return { anchor: pose.idxTip.clone().addScaledVector(pose.indexDir, SHOT_RANGE * 0.6), body: null };
  }

  function beginSwing(target) {
    attached = { anchor: target.anchor, body: target.body };
    const head = _h.copy(player.position);
    head.y += 1.6;
    attached.length = Math.max(1, head.distanceTo(attached.anchor));
    swingVel.set(0, 0, 0);
  }

  function endSwing() {
    if (!attached) return;
    // Keep the swing's momentum when you let go
    attached = null;
    line.visible = false;
  }

  function updateSwing(dt) {
    const head = _h.copy(player.position);
    head.y += 1.6;
    if (attached.body) attached.anchor.copy(attached.body.center);
    const L = attached.length;
    // Gravity along the swing, then a constraint that keeps you on the rope
    swingVel.y -= SWING_GRAVITY * dt;
    swingVel.multiplyScalar(Math.exp(-SWING_DAMP * dt));
    player.position.addScaledVector(swingVel, dt);

    head.copy(player.position).add(_d.set(0, 1.6, 0));
    _a.subVectors(head, attached.anchor);
    const dist = _a.length();
    if (dist > 1e-4) {
      _a.divideScalar(dist);
      // Pull back onto the rope, removing outward speed
      player.position.addScaledVector(_a, L - dist);
      const outward = swingVel.dot(_a);
      if (outward > 0) swingVel.addScaledVector(_a, -outward);
    }
    if (player.position.y < 0) {
      player.position.y = 0;
      if (swingVel.y < 0) swingVel.y = 0;
    }
    line.geometry.attributes.position.array[0] = head.x;
    line.geometry.attributes.position.array[1] = head.y;
    line.geometry.attributes.position.array[2] = head.z;
    line.geometry.attributes.position.array[3] = attached.anchor.x;
    line.geometry.attributes.position.array[4] = attached.anchor.y;
    line.geometry.attributes.position.array[5] = attached.anchor.z;
    line.geometry.attributes.position.needsUpdate = true;
  }

  // Called once per frame by powers.js while Spider is equipped
  function update(dt, worldDt, left, right, blocked) {
    shotCooldown = Math.max(0, shotCooldown - dt);
    flickCooldown = Math.max(0, flickCooldown - dt);

    // Web Shot: gun pose held briefly, nothing blocking it
    if (right && gunPose(right) && !blocked && !attached && shotCooldown === 0) {
      shotHold += dt;
      if (shotHold >= SHOT_HOLD) {
        shotHold = 0;
        shotCooldown = 0.6;
        beginSwing(aimShot(right));
        line.visible = true;
      }
    } else {
      shotHold = 0;
    }

    // Web Swing: release with the left open palm
    if (attached) {
      if (left && openPose(left)) {
        endSwing();
      } else {
        updateSwing(dt);
      }
    }

    // Web Trap: right fist flicked forward throws a web ball
    if (right && fistPose(right) && flickCooldown === 0 && !blocked) {
      const flick = _v.copy(right.wristVel).dot(right.palmFwd);
      if (flick > TRAP_FLICK) {
        const mesh = new THREE.Mesh(ballGeometry, ballMaterial);
        mesh.position.copy(right.palmCenter);
        scene.add(mesh);
        balls.push({ mesh, vel: right.palmFwd.clone().multiplyScalar(BALL_SPEED), life: BALL_LIFE });
        flickCooldown = 0.8;
      }
    }

    // Balls fly and pin the first free object they touch
    for (let i = balls.length - 1; i >= 0; i--) {
      const ball = balls[i];
      ball.life -= worldDt;
      ball.mesh.position.addScaledVector(ball.vel, worldDt);
      let hit = null;
      for (const b of bodies) {
        if (b.state !== 'free') continue;
        const reach = (b.shape === 'sphere' ? b.r : Math.max(b.half.x, b.half.y, b.half.z)) + 0.06;
        if (b.center.distanceTo(ball.mesh.position) < reach) {
          hit = b;
          break;
        }
      }
      if (hit) {
        hit.state = 'web';
        hit.invMass = 0;
        hit.vel.set(0, 0, 0);
        trapped.set(hit, TRAP_TIME);
      }
      if (hit || ball.life <= 0) {
        scene.remove(ball.mesh);
        balls.splice(i, 1);
      }
    }

    // Trapped objects are released when the web wears out
    for (const [b, left] of trapped) {
      const next = left - worldDt;
      if (next <= 0 || b.state !== 'web') {
        if (b.state === 'web') {
          b.state = 'free';
          b.invMass = 1 / b.mass;
        }
        trapped.delete(b);
      } else {
        trapped.set(b, next);
      }
    }
  }

  return {
    update,
    isSwinging: () => !!attached,
    reset() {
      if (attached) endSwing();
      for (const ball of balls) scene.remove(ball.mesh);
      balls.length = 0;
      for (const [b] of trapped) {
        if (b.state === 'web') {
          b.state = 'free';
          b.invMass = 1 / b.mass;
        }
      }
      trapped.clear();
    },
  };
}
