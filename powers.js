import * as THREE from 'three';
import { createOctopus } from './octopus.js';
import { createSpider } from './spider.js';

// ---------------------------------------------------------------------------
// Superpowers + wizard gesture spells, driven by hand tracking.
//
//   Power wheel : turn your LEFT palm up to open it. Point your RIGHT index
//                 at a slice, pinch to equip. Slots without a power are
//                 reserved for future ones.
//   Use a power : pinch with BOTH hands (hold to keep it active).
//                   Doctor Octopus -> tentacles from each hand grab objects
//                   Superfly       -> fly toward where your right index points
//   Spells      : Spark   - point with right index and flick forward
//                 Push    - open palm, shove forward quickly (shockwave)
//                 Gather  - left fist held pulls nearby objects to your hand
//
// Desktop fallback (no headset): keys 1-8 equip a slot, hold Space to use it
// (tentacles fire forward from the camera, Superfly flies where you look).
// ---------------------------------------------------------------------------

const UP = new THREE.Vector3(0, 1, 0);
const WHEEL_SLOTS = 8;
const WHEEL_STEP = (Math.PI * 2) / WHEEL_SLOTS;

// Each power: id, name, colour. Add new powers here and they appear on the wheel.
export const POWERS = [
  { id: 'octopus', name: 'Doctor Octopus', color: 0x8e44ad },
  { id: 'superfly', name: 'Superfly', color: 0x2e86de },
  { id: 'spider', name: 'Spider', color: 0xe03131 },
];

const CURL_RATIO = 1.6;          // tip-to-wrist / metacarpal-to-wrist; above = extended
const PINCH_ON = 0.03;           // metres, thumb-index tip distance
const PINCH_OFF = 0.045;
const PALM_UP = 0.8;             // palm normal y above this = palm up
const WHEEL_HOLD = 0.5;          // seconds the palm must stay up before the wheel opens
const WHEEL_CLOSE_DELAY = 0.3;             // palm normal y above this = palm up
const TENTACLE_REACH = 3.2;      // metres
const TENTACLE_GRAB_RANGE = 0.35;
const FLY_SPEED = 7;             // m/s
const SPARK_SPEED = 14;          // m/s
const SPARK_TRIGGER = 1.8;       // m/s flick speed
const PUSH_TRIGGER = 2.4;       // m/s thrust relative to the body
const PUSH_HOLD = 0.12;          // seconds the thrust must last
const PUSH_COOLDOWN = 1.2;
const PUSH_RANGE = 2.5;
const PUSH_CONE = Math.cos(THREE.MathUtils.degToRad(35));
const PUSH_STRENGTH = 6;
const GATHER_RANGE = 3;

function makePose() {
  return {
    wrist: new THREE.Vector3(),
    prevWrist: new THREE.Vector3(),
    wristVel: new THREE.Vector3(),
    midMeta: new THREE.Vector3(),
    idxMeta: new THREE.Vector3(),
    pinkyMeta: new THREE.Vector3(),
    idxTip: new THREE.Vector3(),
    prevIdxTip: new THREE.Vector3(),
    idxVel: new THREE.Vector3(),
    thumbTip: new THREE.Vector3(),
    palmCenter: new THREE.Vector3(),
    palmFwd: new THREE.Vector3(),
    palmFacing: new THREE.Vector3(),
    indexDir: new THREE.Vector3(),
    fingers: { index: false, middle: false, ring: false, pinky: false, thumb: false },
    hasPrev: false,
  };
}

const _s1 = new THREE.Vector3();
const _s2 = new THREE.Vector3();
const _s3 = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();

function jointPos(rig, name, out) {
  const j = rig.hand.joints && rig.hand.joints[name];
  if (!j || !j.visible) return false;
  j.getWorldPosition(out);
  return true;
}

// Reads a hand's pose from the tracked joints. Returns null if not tracked.
function readPose(rig, dt) {
  const J = rig.hand.joints;
  if (!J || !J.wrist || !J.wrist.visible) {
    rig.pose = null;
    return null;
  }
  const p = rig.pose || (rig.pose = makePose());

  const ok =
    jointPos(rig, 'wrist', p.wrist) &&
    jointPos(rig, 'middle-finger-metacarpal', p.midMeta) &&
    jointPos(rig, 'index-finger-metacarpal', p.idxMeta) &&
    jointPos(rig, 'pinky-finger-metacarpal', p.pinkyMeta) &&
    jointPos(rig, 'index-finger-tip', p.idxTip) &&
    jointPos(rig, 'thumb-tip', p.thumbTip);
  if (!ok) {
    rig.pose = null;
    return null;
  }

  // Velocities (finite differences)
  if (p.hasPrev && dt > 0) {
    p.wristVel.copy(p.wrist).sub(p.prevWrist).divideScalar(dt);
    p.idxVel.copy(p.idxTip).sub(p.prevIdxTip).divideScalar(dt);
  } else {
    p.wristVel.set(0, 0, 0);
    p.idxVel.set(0, 0, 0);
  }
  p.prevWrist.copy(p.wrist);
  p.prevIdxTip.copy(p.idxTip);
  p.hasPrev = true;

  p.palmCenter.addVectors(p.wrist, p.midMeta).multiplyScalar(0.5);
  p.palmFwd.subVectors(p.midMeta, p.wrist).normalize();

  // Palm normal: fingers x thumb-side. The sign depends on which hand it is.
  _s1.subVectors(p.idxMeta, p.pinkyMeta);
  p.palmFacing.crossVectors(p.palmFwd, _s1).normalize();
  if (rig.handedness === 'right') p.palmFacing.negate();

  p.indexDir.subVectors(p.idxTip, p.idxMeta).normalize();

  // Finger extension: tip further from the wrist than the knuckle, by a margin
  const extended = (name) => {
    if (!jointPos(rig, `${name}-finger-metacarpal`, _s2) || !jointPos(rig, `${name}-finger-tip`, _s3)) return false;
    return _s3.distanceTo(p.wrist) > CURL_RATIO * _s2.distanceTo(p.wrist);
  };
  p.fingers.index = extended('index');
  p.fingers.middle = extended('middle');
  p.fingers.ring = extended('ring');
  p.fingers.pinky = extended('pinky');
  p.fingers.thumb = p.thumbTip.distanceTo(p.idxMeta) > 0.07;

  return p;
}

const isOpen = (p) => p.fingers.index && p.fingers.middle && p.fingers.ring && p.fingers.pinky;
const isFist = (p) => !p.fingers.index && !p.fingers.middle && !p.fingers.ring && !p.fingers.pinky;
const isPointing = (p) => p.fingers.index && !p.fingers.middle && !p.fingers.ring && !p.fingers.pinky;

// Pinch with hysteresis when hands are tracked; the trigger when using controllers.
function isPinching(rig, pose) {
  if (pose) {
    const d = pose.idxTip.distanceTo(pose.thumbTip);
    rig.pinching = rig.pinching ? d < PINCH_OFF : d < PINCH_ON;
  } else {
    rig.pinching = !!rig.selectDown;
  }
  return rig.pinching;
}

// ---------------------------------------------------------------------------
export function createPowers(ctx) {
  const { scene, camera, player, bodies, hands, keys, renderer, gridTexture, cancelHandGrab, sfx } = ctx;

  let equipped = null;   // power object or null
  let wheelOpen = false;
  let wheelLatched = false; // stays shut until the palm drops, so one tilt = one open
  let wheelSelected = -1;
  let wheelHold = 0;
  let wheelAway = 0;
  let powerActive = false;
  let prevRightPinch = false;
  let prevBothPinch = false;
  let prevPinchTracked = { left: false, right: false };
  const cooldowns = { spark: 0, push: 0 };
  const playerVelocity = new THREE.Vector3();   // how fast the player body is moving (walking, arm swing)
  const prevPlayerPos = player.position.clone();

  // ----- HUD -------------------------------------------------------------
  const hud = document.createElement('div');
  hud.style.cssText =
    'position:fixed;top:12px;right:12px;font:13px system-ui,sans-serif;color:#cfd8e3;' +
    'text-align:right;opacity:.85;pointer-events:none;user-select:none;white-space:pre;';
  document.body.appendChild(hud);
  let toast = '';
  let toastTimer = 0;

  function showToast(msg, seconds = 1.6) {
    toast = msg;
    toastTimer = seconds;
  }

  function refreshHud() {
    const power = equipped ? equipped.name : 'none';
    const lines = [`Power: ${power}`];
    if (toastTimer > 0 && toast) lines.push(toast);
    hud.textContent = lines.join('\n');
  }

  // Desktop: keys 1-8 equip wheel slots, T toggles the octopus arms
  let toggleRequested = false;
  function consumeToggle() {
    const v = toggleRequested;
    toggleRequested = false;
    return v;
  }
  window.addEventListener('keydown', (e) => {
    const m = /^Digit([1-8])$/.exec(e.code);
    if (m) selectSlot(Number(m[1]) - 1, true);
    if (e.code === 'KeyT') toggleRequested = true;
  });

  function selectSlot(i, fromKey = false) {
    const power = POWERS[i];
    if (!power) {
      showToast(`Slot ${i + 1} is empty. Room for a future power.`);
      return;
    }
    if (equipped !== power) octopus.setDeployed(false);
    equipped = power;
    showToast(`Equipped: ${power.name}`);
    if (fromKey) refreshHud();
  }

  // ----- Power wheel visuals ----------------------------------------------
  const wheel = new THREE.Group();
  wheel.visible = false;
  scene.add(wheel);

  function makeLabelTexture(text, dim) {
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 96;
    const g = c.getContext('2d');
    g.fillStyle = dim ? 'rgba(20,22,28,0.0)' : 'rgba(20,22,28,0.0)';
    g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = dim ? '#7d8590' : '#ffffff';
    g.font = 'bold 34px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, 128, 48);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  const slices = [];
  for (let i = 0; i < WHEEL_SLOTS; i++) {
    const power = POWERS[i];
    const color = power ? power.color : 0x3a3f47;
    const start = i * WHEEL_STEP - WHEEL_STEP / 2 + 0.02;
    const geometry = new THREE.RingGeometry(0.07, 0.17, 24, 1, start, WHEEL_STEP - 0.04);
    const material = new THREE.MeshStandardMaterial({
      color,
      map: gridTexture,
      emissive: color,
      emissiveIntensity: 0.15,
      roughness: 0.4,
      transparent: true,
      opacity: power ? 0.95 : 0.45,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geometry, material);
    wheel.add(mesh);

    const label = new THREE.Mesh(
      new THREE.PlaneGeometry(0.2, 0.075),
      new THREE.MeshBasicMaterial({
        map: makeLabelTexture(power ? shortName(power.name) : '+', !power),
        transparent: true,
        depthWrite: false,
      })
    );
    const mid = i * WHEEL_STEP;
    label.position.set(Math.cos(mid) * 0.235, Math.sin(mid) * 0.235, 0.005);
    wheel.add(label);
    slices.push({ mesh, material });
  }

  function shortName(name) {
    return name.split(' ').slice(-1)[0].slice(0, 9);
  }

  const wheelQuat = new THREE.Quaternion();
  const FORWARD_Z = new THREE.Vector3(0, 0, 1);

  function updateWheel(left, right, rightPinchEdge, dt) {
    // Open only after the palm has been held up for a moment; close shortly after it drops
    const palmUp = !!left && left.palmFacing.y > PALM_UP;
    wheelHold = palmUp ? wheelHold + dt : 0;
    wheelAway = palmUp ? 0 : wheelAway + dt;
    if (!wheelOpen && !wheelLatched && wheelHold >= WHEEL_HOLD) wheelOpen = true;
    if (wheelOpen && wheelAway > WHEEL_CLOSE_DELAY) {
      wheelOpen = false;
      wheelLatched = false;
    }
    if (!palmUp && wheelAway > WHEEL_CLOSE_DELAY) wheelLatched = false;
    if (!wheelOpen) {
      wheel.visible = false;
      return;
    }

    // Place the wheel just above the left palm, lying flat against it
    wheel.visible = true;
    wheelQuat.setFromUnitVectors(FORWARD_Z, left.palmFacing);
    wheel.quaternion.copy(wheelQuat);
    wheel.position.copy(left.palmCenter).addScaledVector(left.palmFacing, 0.12);
    wheel.updateWorldMatrix(true, false);

    // Which slice is the right index pointing at?
    wheelSelected = -1;
    if (right) {
      _s1.copy(right.idxTip);
      wheel.worldToLocal(_s1);
      const r = Math.hypot(_s1.x, _s1.y);
      if (r > 0.05) {
        const angle = Math.atan2(_s1.y, _s1.x);
        wheelSelected = Math.round((((angle + Math.PI * 2) % (Math.PI * 2)) / WHEEL_STEP)) % WHEEL_SLOTS;
      }
    }
    slices.forEach((s, i) => {
      const hot = i === wheelSelected;
      s.material.emissiveIntensity = hot ? 0.9 : 0.15;
      s.mesh.scale.setScalar(hot ? 1.08 : 1);
    });

    // Right pinch equips the highlighted slice and latches the wheel shut
    if (rightPinchEdge && wheelSelected >= 0) {
      selectSlot(wheelSelected);
      wheelOpen = false;
      wheelLatched = true;
    }
  }

  // ----- Doctor Octopus (robotic arms, see octopus.js) ----------------------
  const octopus = createOctopus({ scene, camera, player, bodies, gridTexture });
  const spider = createSpider({ scene, player, camera, bodies, sfx });

  // ----- Superfly ---------------------------------------------------------
  const flyDir = new THREE.Vector3();
  const FOV_NORMAL = 70;
  const FOV_FLY = 84;

  function updateFlight(dt, using) {
    let fov = FOV_NORMAL;
    if (using) {
      const right = hands.find((h) => h.handedness === 'right') || hands[1];
      const pose = right && right.pose;
      if (pose && pose.fingers.index) {
        flyDir.copy(pose.indexDir);
      } else if (pose) {
        flyDir.copy(pose.palmFwd);
      } else {
        camera.getWorldDirection(flyDir);
      }
      if (flyDir.lengthSq() < 1e-6) flyDir.set(0, 0, -1);
      flyDir.normalize();
      player.position.addScaledVector(flyDir, FLY_SPEED * dt);
      fov = FOV_FLY;
    }
    if (dt > 0) {
      const next = THREE.MathUtils.lerp(camera.fov, fov, 1 - Math.exp(-6 * dt));
      if (Math.abs(next - camera.fov) > 0.01) {
        camera.fov = next;
        camera.updateProjectionMatrix();
      }
    }
  }

  // ----- Power use -----------------------------------------------------------
  // Octopus: both-hand pinch (or T) toggles deploy. Superfly: hold to fly.
  function updatePower(dt, time, using, toggleEdge, inputs) {
    const isOctopus = !!equipped && equipped.id === 'octopus';
    const isFly = !!equipped && equipped.id === 'superfly';

    if (isOctopus && toggleEdge) {
      const next = !octopus.isDeployed();
      octopus.setDeployed(next);
      if (next) for (const h of hands) cancelHandGrab(h);
      showToast(next ? 'Tentacles deployed' : 'Tentacles retracted');
    }

    if (isFly && using && !powerActive) {
      powerActive = true;
      for (const h of hands) cancelHandGrab(h);
      showToast(`${equipped.name}!`, 1.0);
    } else if (!(isFly && using) && powerActive) {
      powerActive = false;
    }

    octopus.update(dt, time, inputs);
    updateFlight(dt, isFly && powerActive);
    octopus.updatePlayer(dt, (isFly && powerActive) || spider.isSwinging() || spider.isCrawling());
    return powerActive;
  }

  // ----- Gesture spells -------------------------------------------------------
  const projectiles = [];
  const projectileGeometry = new THREE.SphereGeometry(0.035, 12, 8);
  const projectileMaterial = new THREE.MeshBasicMaterial({ color: 0xffe066 });

  function fireSpark(origin, dir) {
    const mesh = new THREE.Mesh(projectileGeometry, projectileMaterial);
    mesh.position.copy(origin);
    scene.add(mesh);
    projectiles.push({ mesh, vel: dir.clone().multiplyScalar(SPARK_SPEED), life: 1.2, dir: dir.clone() });
  }

  function updateProjectiles(dt) {
    for (let i = projectiles.length - 1; i >= 0; i--) {
      const p = projectiles[i];
      p.life -= dt;
      p.mesh.position.addScaledVector(p.vel, dt);
      let hitBody = false;
      for (const b of bodies) {
        if (b.state !== 'free') continue;
        const reach = (b.shape === 'sphere' ? b.r : Math.max(b.half.x, b.half.y, b.half.z)) + 0.04;
        if (b.center.distanceTo(p.mesh.position) < reach) {
          b.vel.addScaledVector(p.dir, 6 * b.invMass);
          hitBody = true;
          break;
        }
      }
      if (hitBody || p.life <= 0 || p.mesh.position.y < 0) {
        scene.remove(p.mesh);
        projectiles.splice(i, 1);
      }
    }
  }

  const shockwaves = [];
  const shockGeometry = new THREE.RingGeometry(0.05, 0.07, 36);

  function fireShockwave(origin, dir) {
    const material = new THREE.MeshBasicMaterial({ color: 0x9be7ff, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false });
    const mesh = new THREE.Mesh(shockGeometry, material);
    mesh.position.copy(origin);
    mesh.lookAt(_s1.copy(origin).add(dir));
    scene.add(mesh);
    shockwaves.push({ mesh, material, t: 0, dir: dir.clone(), origin: origin.clone() });

    for (const b of bodies) {
      if (b.state !== 'free') continue;
      _s2.subVectors(b.center, origin);
      const d = _s2.length();
      if (d > PUSH_RANGE || d < 1e-4) continue;
      _s2.divideScalar(d);
      if (_s2.dot(dir) < PUSH_CONE) continue;
      const strength = PUSH_STRENGTH * (1 - d / PUSH_RANGE + 0.2);
      b.vel.addScaledVector(dir, strength * b.invMass);
    }
  }

  function updateShockwaves(dt) {
    for (let i = shockwaves.length - 1; i >= 0; i--) {
      const s = shockwaves[i];
      s.t += dt;
      const k = Math.min(1, s.t / 0.4);
      s.mesh.scale.setScalar(1 + k * PUSH_RANGE * 10);
      s.material.opacity = 0.9 * (1 - k);
      if (k >= 1) {
        scene.remove(s.mesh);
        s.material.dispose();
        shockwaves.splice(i, 1);
      }
    }
  }

  const gatherGlow = new THREE.Mesh(
    new THREE.SphereGeometry(0.06, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0x7fffd4, transparent: true, opacity: 0.45, depthWrite: false })
  );
  gatherGlow.visible = false;
  scene.add(gatherGlow);

  function updateSpells(dt, left, right, worldDt = dt) {
    if (dt > 0) playerVelocity.copy(player.position).sub(prevPlayerPos).divideScalar(dt);
    prevPlayerPos.copy(player.position);
    // Spider owns its own gestures, so spark, shockwave and gather stay off
    if (equipped && equipped.id === 'spider') return;
    cooldowns.spark = Math.max(0, cooldowns.spark - dt);
    cooldowns.push = Math.max(0, cooldowns.push - dt);

    // Spark: right index pointing, flicked forward (relative to the body)
    if (right && isPointing(right) && cooldowns.spark === 0) {
      const flick = _s1.copy(right.idxVel).sub(playerVelocity).dot(right.indexDir);
      if (flick > SPARK_TRIGGER) {
        fireSpark(right.idxTip, right.indexDir);
        cooldowns.spark = 0.5;
      }
    }

    // Push: an open palm thrust forward, sustained, relative to the body.
    // Walking and arm swing move the hands too, so their speed is measured
    // against the player's own motion and must hold for a moment.
    const blocked = wheelOpen || powerActive || octopus.isDeployed();
    for (const hand of [left, right]) {
      if (!hand) continue;
      if (!isOpen(hand) || cooldowns.push > 0 || blocked) {
        hand.pushT = 0;
        continue;
      }
      const shove = _s1.copy(hand.wristVel).sub(playerVelocity).dot(hand.palmFwd);
      hand.pushT = shove > PUSH_TRIGGER ? (hand.pushT || 0) + dt : 0;
      if (hand.pushT >= PUSH_HOLD) {
        fireShockwave(hand.palmCenter, hand.palmFwd);
        cooldowns.push = PUSH_COOLDOWN;
        hand.pushT = 0;
      }
    }

    // Gather: left fist pulls nearby objects toward the palm
    const gathering = !!(left && isFist(left));
    gatherGlow.visible = gathering;
    if (gathering) {
      gatherGlow.position.copy(left.palmCenter);
      for (const b of bodies) {
        if (b.state !== 'free') continue;
        _s2.subVectors(left.palmCenter, b.center);
        const d = _s2.length();
        if (d > GATHER_RANGE || d < 1e-3) continue;
        _s2.divideScalar(d);
        b.vel.addScaledVector(_s2, (1.5 + 4 * (1 - d / GATHER_RANGE)) * worldDt);
        if (b.vel.length() > 3) b.vel.setLength(3);
      }
    }
  }

  // ----- Public API -------------------------------------------------------
  function handInput(rig, pose, side) {
    if (!renderer.xr.isPresenting) {
      // Desktop: virtual hands in front of the camera
      camera.getWorldDirection(_fwd);
      _right.crossVectors(_fwd, UP).normalize();
      const pos = camera.getWorldPosition(new THREE.Vector3())
        .addScaledVector(_right, side * 0.35)
        .addScaledVector(_fwd, 0.5)
        .addScaledVector(UP, -0.25);
      return { pos, vel: new THREE.Vector3(), grip: !!keys && keys.has('Space'), dir: camera.getWorldDirection(new THREE.Vector3()) };
    }
    if (pose) return { pos: pose.wrist, vel: pose.wristVel, grip: !!rig.pinching, dir: pose.palmFwd };
    if (rig.connected) {
      const dir = new THREE.Vector3(0, 0, -1).transformDirection(rig.controller.matrixWorld);
      return { pos: rig.controller.getWorldPosition(new THREE.Vector3()), vel: rig.vel, grip: !!rig.pinching, dir };
    }
    return null;
  }

  function update(dt, worldDt = dt) {
    const time = performance.now() / 1000;
    const left = hands.find((h) => h.handedness === 'left') || hands[0];
    const right = hands.find((h) => h.handedness === 'right') || hands[1];

    const lpose = readPose(left, dt);
    const rpose = readPose(right, dt);
    const lpinch = isPinching(left, lpose);
    const rpinch = isPinching(right, rpose);
    const bothPinch = lpinch && rpinch;

    const rightPinchEdge = rpinch && !prevRightPinch;
    const bothEdge = bothPinch && !prevBothPinch;
    prevRightPinch = rpinch;
    prevBothPinch = bothPinch;

    updateWheel(lpose, rpose, rightPinchEdge, dt);

    const toggleEdge = bothEdge || consumeToggle();
    const using = bothPinch || (!renderer.xr.isPresenting && !!keys && keys.has('Space'));
    const inputs = {
      left: handInput(left, lpose, -1),
      right: handInput(right, rpose, 1),
    };
    if (equipped && equipped.id === 'spider') {
      const blocked = wheelOpen || powerActive || octopus.isDeployed();
      spider.update(dt, worldDt, lpose, rpose, blocked);
    }
    updatePower(dt, time, using, toggleEdge, inputs);

    updateSpells(dt, lpose, rpose, worldDt);
    updateProjectiles(worldDt);
    updateShockwaves(worldDt);

    if (toastTimer > 0) toastTimer -= dt;
    refreshHud();
  }

  // Main calls this to stop a hand's normal grab while the wheel or a power is using the hands
  function blocksGrab() {
    return wheelOpen || powerActive || octopus.isDeployed();
  }

  function reset() {
    octopus.reset();
    spider.reset();
    for (const p of projectiles) scene.remove(p.mesh);
    projectiles.length = 0;
    for (const s of shockwaves) {
      scene.remove(s.mesh);
      s.material.dispose();
    }
    shockwaves.length = 0;
  }

  refreshHud();
  return { update, blocksGrab, reset, selectSlot, spiderWebs: () => spider.webCount(), spiderCrawling: () => spider.isCrawling(), webLengths: () => spider.webLengths(), get equipped() { return equipped; } };
}
