import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Magic sandbox tools: hand-gesture spells that aren't wheel powers.
//
//   Conjure   : right hand thumbs-up, held. Summons a random object at the
//               palm with a sparkle burst. Desktop: B.
//   Time Warp : left hand thumbs-up, held. Toggles slow motion. Desktop: N.
//
// Both need the hand pose from powers.js (rig.pose), which is set each frame.
// ---------------------------------------------------------------------------

const HOLD_TIME = 0.7;      // seconds a thumbs-up must be held
const COOLDOWN = 1.2;       // seconds between uses
const SLOW_SCALE = 0.25;
const SPARKS = 48;

export function createTools({ hands, keys, getTimeScale, setTimeScale, spawn, setRewindHeld, camera, player, sfx }) {
  // ----- Sparkle particles --------------------------------------------------
  const positions = new Float32Array(SPARKS * 3);
  const velocities = Array.from({ length: SPARKS }, () => new THREE.Vector3());
  const life = new Float32Array(SPARKS);
  const sparkGeometry = new THREE.BufferGeometry();
  sparkGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const sparkMaterial = new THREE.PointsMaterial({
    color: 0xfff1a8,
    size: 0.05,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const sparks = new THREE.Points(sparkGeometry, sparkMaterial);
  sparks.frustumCulled = false;
  sparks.visible = false;
  // Added to the scene by the caller via tools.group
  const group = new THREE.Group();
  group.add(sparks);

  let burstTimer = 0;
  function burst(origin) {
    for (let i = 0; i < SPARKS; i++) {
      const dir = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.8 + 0.2, Math.random() - 0.5).normalize();
      velocities[i].copy(dir).multiplyScalar(0.8 + Math.random() * 1.6);
      positions[i * 3] = origin.x;
      positions[i * 3 + 1] = origin.y;
      positions[i * 3 + 2] = origin.z;
      life[i] = 0.6 + Math.random() * 0.4;
    }
    sparks.visible = true;
    burstTimer = 1;
  }

  function updateSparks(dt) {
    if (!sparks.visible) return;
    let alive = 0;
    for (let i = 0; i < SPARKS; i++) {
      if (life[i] <= 0) continue;
      alive++;
      life[i] -= dt;
      velocities[i].y -= 2.5 * dt; // a little gravity, so the sparks fall back
      positions[i * 3] += velocities[i].x * dt;
      positions[i * 3 + 1] += velocities[i].y * dt;
      positions[i * 3 + 2] += velocities[i].z * dt;
    }
    sparkMaterial.opacity = Math.min(1, burstTimer * 1.5);
    burstTimer = Math.max(0, burstTimer - dt);
    sparkGeometry.attributes.position.needsUpdate = true;
    if (alive === 0) sparks.visible = false;
  }

  // ----- Gesture holds --------------------------------------------------------
  const holds = hands.map(() => ({ time: 0, cooldown: 0, fired: false }));

  // Only the thumb is out; the thumb tip points up (+) or down (-) from the wrist
  function isThumbsGesture(pose, dir) {
    if (!pose) return false;
    const f = pose.fingers;
    if (!(f.thumb && !f.index && !f.middle && !f.ring && !f.pinky)) return false;
    const rise = pose.thumbTip.y - pose.wrist.y;
    return dir > 0 ? rise > 0.02 : rise < -0.02;
  }
  const isThumbsUp = (pose) => isThumbsGesture(pose, 1);
  const isThumbsDown = (pose) => isThumbsGesture(pose, -1);

  function trackHold(i, pose, dt, onFire) {
    const h = holds[i];
    h.cooldown = Math.max(0, h.cooldown - dt);
    if (isThumbsUp(pose) && h.cooldown === 0) {
      h.time += dt;
      if (h.time >= HOLD_TIME && !h.fired) {
        h.fired = true;
        h.cooldown = COOLDOWN;
        onFire(pose);
      }
    } else {
      h.time = 0;
      h.fired = false;
    }
  }

  function conjureAt(pos, dir) {
    spawn(pos, dir);
    burst(pos);
    sfx.play('conjure');
  }

  function toggleTimeWarp() {
    const next = getTimeScale() < 1 ? 1 : SLOW_SCALE;
    setTimeScale(next);
    sfx.play('timeWarp');
    burst(player.position.clone().add(new THREE.Vector3(0, 1.4, -0.6)));
  }

  // Desktop fallbacks
  let desktopB = false;
  let desktopN = false;
  let desktopRewind = false;
  let rewindHold = 0;
  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyB') desktopB = true;
    if (e.code === 'KeyN') desktopN = true;
    if (e.code === 'KeyY') desktopRewind = true;
  });
  window.addEventListener('keyup', (e) => {
    if (e.code === 'KeyY') desktopRewind = false;
  });

  function update(dt) {
    const right = hands.find((h) => h.handedness === 'right');
    const left = hands.find((h) => h.handedness === 'left');
    const rightIndex = hands.indexOf(right);
    const leftIndex = hands.indexOf(left);

    if (right && right.pose) {
      trackHold(rightIndex, right.pose, dt, (pose) => {
        // Conjure in front of the palm, drifting forward
        const dir = pose.palmFwd.clone().multiplyScalar(0.8);
        conjureAt(pose.palmCenter.clone(), dir);
      });
    }
    if (left && left.pose) {
      trackHold(leftIndex, left.pose, dt, (pose) => toggleTimeWarp());
    }

    // Rewind: hold a left thumbs-down (or Y on desktop) to run time backwards
    const thumbsDownNow = !!(left && isThumbsDown(left.pose));
    rewindHold = thumbsDownNow ? rewindHold + dt : 0;
    setRewindHeld(rewindHold > 0.5 || desktopRewind);

    // Desktop: B conjures two metres ahead, N toggles time warp
    if (desktopB) {
      desktopB = false;
      const pos = camera.getWorldPosition(new THREE.Vector3()).addScaledVector(camera.getWorldDirection(new THREE.Vector3()), 2);
      pos.y = 1.2;
      conjureAt(pos, null);
    }
    if (desktopN) {
      desktopN = false;
      toggleTimeWarp();
    }

    updateSparks(dt);
  }

  return { update, group };
}
