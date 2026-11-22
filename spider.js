import * as THREE from 'three';

// ---------------------------------------------------------------------------
// The Spider power: one power, several abilities, each with its own hand pose
// so they never get mixed up. While Spider is equipped, spark, shockwave and
// gather are switched off, so their gestures can't fire by accident.
//
//   Spider-Sense : always on (bullet time, see spidersense.js).
//   Web Shot     : a gun pose (thumb and index out, other fingers curled),
//                  held briefly, fires a web from that hand. LEFT or RIGHT.
//   Web Swing    : each web is a rope. Swing on one or both at once.
//                  Open a palm to let go of that hand's web.
//   Web Trap     : RIGHT fist flicked forward. A web ball pins the first
//                  object it hits for a few seconds.
// ---------------------------------------------------------------------------

const SHOT_RANGE = 25;          // m
const SHOT_HOLD = 0.2;          // s the gun pose must be held
const SWING_GRAVITY = 9.8;
const SWING_DAMP = 0.02;        // per second, a little air drag
const CONSTRAINT_PASSES = 4;    // rope solver iterations per frame
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
  // One web per hand: { side, anchor, body, length, line }
  const webs = [];
  const swingVel = new THREE.Vector3();
  const shotHold = { left: 0, right: 0 };
  const shotCooldown = { left: 0, right: 0 };
  const balls = [];
  const trapped = new Map();      // body -> seconds left
  let flickCooldown = 0;

  const ballGeometry = new THREE.SphereGeometry(0.06, 12, 8);
  const ballMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });

  function makeLine() {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color: 0xffffff }));
    line.frustumCulled = false;
    scene.add(line);
    return line;
  }

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

  function shoot(side, pose) {
    const target = aimShot(pose);
    // Replace any web already on this hand
    releaseWeb(side);
    const head = _h.copy(player.position);
    head.y += 1.6;
    const web = { side, anchor: target.anchor, body: target.body, length: Math.max(1, head.distanceTo(target.anchor)), line: makeLine() };
    webs.push(web);
  }

  function releaseWeb(side) {
    for (let i = webs.length - 1; i >= 0; i--) {
      if (webs[i].side !== side) continue;
      scene.remove(webs[i].line);
      webs.splice(i, 1);
    }
  }

  function updateSwing(dt) {
    // Gravity and drag on the body
    swingVel.y -= SWING_GRAVITY * dt;
    swingVel.multiplyScalar(Math.exp(-SWING_DAMP * dt));
    player.position.addScaledVector(swingVel, dt);

    // Keep the body on every rope: push back to each rope's length, a few passes
    for (let pass = 0; pass < CONSTRAINT_PASSES; pass++) {
      for (const web of webs) {
        if (web.body) web.anchor.copy(web.body.center);
        _h.copy(player.position);
        _h.y += 1.6;
        _a.subVectors(_h, web.anchor);
        const dist = _a.length();
        if (dist < 1e-4) continue;
        _a.divideScalar(dist);
        player.position.addScaledVector(_a, (web.length - dist) / webs.length);
      }
    }
    // Remove outward speed along each rope
    for (const web of webs) {
      _h.copy(player.position);
      _h.y += 1.6;
      _a.subVectors(_h, web.anchor).normalize();
      const outward = swingVel.dot(_a);
      if (outward > 0) swingVel.addScaledVector(_a, -outward);
    }

    if (player.position.y < 0) {
      player.position.y = 0;
      if (swingVel.y < 0) swingVel.y = 0;
    }

    // Draw each rope from the hand's side of the body to its anchor
    for (const web of webs) {
      _h.copy(player.position);
      _h.y += 1.6;
      const arr = web.line.geometry.attributes.position.array;
      arr[0] = _h.x; arr[1] = _h.y; arr[2] = _h.z;
      arr[3] = web.anchor.x; arr[4] = web.anchor.y; arr[5] = web.anchor.z;
      web.line.geometry.attributes.position.needsUpdate = true;
    }
  }

  // Called once per frame by powers.js while Spider is equipped
  function update(dt, worldDt, left, right, blocked) {
    flickCooldown = Math.max(0, flickCooldown - dt);

    // Web Shot: a gun pose held briefly fires a web from that hand
    for (const side of ['left', 'right']) {
      const pose = side === 'left' ? left : right;
      shotCooldown[side] = Math.max(0, shotCooldown[side] - dt);
      if (pose && gunPose(pose) && !blocked && shotCooldown[side] === 0) {
        shotHold[side] += dt;
        if (shotHold[side] >= SHOT_HOLD) {
          shotHold[side] = 0;
          shotCooldown[side] = 0.6;
          shoot(side, pose);
        }
      } else {
        shotHold[side] = 0;
      }

      // Open palm on that hand lets go of its web
      if (pose && openPose(pose) && webs.some((w) => w.side === side)) {
        releaseWeb(side);
      }
    }

    // Swing while any web is attached
    if (webs.length > 0) updateSwing(dt);

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
    isSwinging: () => webs.length > 0,
    reset() {
      for (const web of [...webs]) releaseWeb(web.side);
      swingVel.set(0, 0, 0);
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
