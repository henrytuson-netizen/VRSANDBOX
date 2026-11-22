import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Living world: something is always happening, whatever your hands do.
//
//   Motes     : a few glowing particles drift around you. Fast hands scatter them.
//   Wakes     : a hand trails light only while it moves fast.
//   Ripples   : rings spread on the floor under fast, low hands.
//   Breathing : the ambient light slowly shifts colour.
// ---------------------------------------------------------------------------

const MOTES = 120;                 // fewer, so the air isn't busy
const WAKE_POOL = 260;
const RINGS = 14;
const MOTE_RADIUS = 14;
const HAND_COLORS = [0x4fc3ff, 0xff8a4f];
const ACTIVE_SPEED = 0.6;          // m/s: below this, hands are quiet
const MOVE_THRESHOLD = 0.15;       // m/s: a hand this fast scatters motes

export function createAmbience({ scene, player, hands, hemi }) {
  const tmpA = new THREE.Vector3();
  const tmpB = new THREE.Vector3();

  // ----- Motes ------------------------------------------------------------
  const moteBase = new Float32Array(MOTES * 3);
  const moteVel = Array.from({ length: MOTES }, () => new THREE.Vector3());
  const motePhase = new Float32Array(MOTES);
  const moteColor = new Float32Array(MOTES * 3);
  const moteGeometry = new THREE.BufferGeometry();
  moteGeometry.setAttribute('position', new THREE.BufferAttribute(moteBase, 3));
  moteGeometry.setAttribute('color', new THREE.BufferAttribute(moteColor, 3));
  const moteMaterial = new THREE.PointsMaterial({
    size: 0.07,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    sizeAttenuation: true,
  });
  const motes = new THREE.Points(moteGeometry, moteMaterial);
  motes.frustumCulled = false;
  scene.add(motes);

  function respawnMote(i) {
    const a = Math.random() * Math.PI * 2;
    const r = 3 + Math.random() * (MOTE_RADIUS - 3);
    moteBase[i * 3] = player.position.x + Math.cos(a) * r;
    moteBase[i * 3 + 1] = 0.3 + Math.random() * 3.2;
    moteBase[i * 3 + 2] = player.position.z + Math.sin(a) * r;
    moteVel[i].set(0, 0, 0);
    motePhase[i] = Math.random() * Math.PI * 2;
  }
  for (let i = 0; i < MOTES; i++) respawnMote(i);

  // ----- Wakes --------------------------------------------------------------
  const wakePos = new Float32Array(WAKE_POOL * 3);
  const wakeVel = Array.from({ length: WAKE_POOL }, () => new THREE.Vector3());
  const wakeLife = new Float32Array(WAKE_POOL);
  const wakeColor = new Float32Array(WAKE_POOL * 3);
  const wakeGeometry = new THREE.BufferGeometry();
  wakeGeometry.setAttribute('position', new THREE.BufferAttribute(wakePos, 3));
  wakeGeometry.setAttribute('color', new THREE.BufferAttribute(wakeColor, 3));
  const wakeMaterial = new THREE.PointsMaterial({
    size: 0.05,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const wakes = new THREE.Points(wakeGeometry, wakeMaterial);
  wakes.frustumCulled = false;
  scene.add(wakes);
  let wakeCursor = 0;
  const emitAccum = hands.map(() => 0);

  function emitWake(p, v, color) {
    const i = wakeCursor;
    wakeCursor = (wakeCursor + 1) % WAKE_POOL;
    wakePos[i * 3] = p.x;
    wakePos[i * 3 + 1] = p.y;
    wakePos[i * 3 + 2] = p.z;
    wakeVel[i].set((Math.random() - 0.5) * 0.3, Math.random() * 0.2, (Math.random() - 0.5) * 0.3).addScaledVector(v, 0.25);
    wakeLife[i] = 0.7 + Math.random() * 0.6;
    const c = new THREE.Color(color);
    wakeColor[i * 3] = c.r;
    wakeColor[i * 3 + 1] = c.g;
    wakeColor[i * 3 + 2] = c.b;
  }

  // ----- Floor ripples ----------------------------------------------------
  const ringGeometry = new THREE.RingGeometry(0.06, 0.08, 48);
  ringGeometry.rotateX(-Math.PI / 2);
  const rings = Array.from({ length: RINGS }, () => {
    const material = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(ringGeometry, material);
    mesh.visible = false;
    scene.add(mesh);
    return { mesh, material, t: 1 };
  });
  let ringCursor = 0;

  function spawnRipple(x, z, color) {
    const r = rings[ringCursor];
    ringCursor = (ringCursor + 1) % RINGS;
    r.mesh.position.set(x, 0.01, z);
    r.material.color.set(color);
    r.t = 0;
    r.mesh.visible = true;
  }

  let breath = 0;

  function update(dt, time) {
    if (dt <= 0) return;

    // Hand positions and speeds (hands may be missing on desktop)
    const handInfo = hands.map((rig) => {
      const p = tmpA.set(0, 0, 0);
      const present = rig.controller && (rig.connected || !rig.hand);
      if (present) rig.controller.getWorldPosition(p);
      const speed = rig.vel ? rig.vel.length() : 0;
      return { rig, p: p.clone(), speed, present };
    });

    // Motes: drift, scatter from moving hands, swarm around still ones
    for (let i = 0; i < MOTES; i++) {
      const v = moteVel[i];
      const ph = motePhase[i];
      v.x += Math.sin(time * 0.6 + ph) * 0.8 * dt;
      v.y += Math.cos(time * 0.5 + ph * 1.3) * 0.5 * dt;
      v.z += Math.sin(time * 0.7 + ph * 0.7) * 0.8 * dt;
      const x = moteBase[i * 3];
      const y = moteBase[i * 3 + 1];
      const z = moteBase[i * 3 + 2];
      for (const h of handInfo) {
        if (!h.present) continue;
        tmpB.set(x - h.p.x, y - h.p.y, z - h.p.z);
        const d = tmpB.length();
        if (h.speed > ACTIVE_SPEED && d < 0.5) {
          v.addScaledVector(tmpB.divideScalar(Math.max(d, 1e-3)), 6 * dt);
        }
      }
      v.clampLength(0, 1.2);
      v.multiplyScalar(Math.exp(-0.4 * dt));
      moteBase[i * 3] += v.x * dt;
      moteBase[i * 3 + 1] += v.y * dt;
      moteBase[i * 3 + 2] += v.z * dt;

      // Keep motes around the player
      const dx = moteBase[i * 3] - player.position.x;
      const dz = moteBase[i * 3 + 2] - player.position.z;
      if (dx * dx + dz * dz > MOTE_RADIUS * MOTE_RADIUS) respawnMote(i);

      // Gentle glow flicker, a little brighter near hands
      const flicker = 0.7 + 0.3 * Math.sin(time * 1.2 + ph);
      const c = 0.22 * flicker;
      moteColor[i * 3] = c * 0.6;
      moteColor[i * 3 + 1] = c * 0.9;
      moteColor[i * 3 + 2] = c * 1.0;
    }
    moteGeometry.attributes.position.needsUpdate = true;
    moteGeometry.attributes.color.needsUpdate = true;

    // Wakes: every hand always gives off light; moving hands give off more
    handInfo.forEach((h, idx) => {
      if (!h.present) return;
      // Quiet unless the hand is moving fast
      const rate = h.speed > ACTIVE_SPEED ? (h.speed - ACTIVE_SPEED) * 30 : 0;
      emitAccum[idx] += rate * dt;
      const color = HAND_COLORS[idx % 2];
      while (emitAccum[idx] >= 1) {
        emitAccum[idx] -= 1;
        emitWake(h.p, h.rig.vel || tmpB.set(0, 0, 0), color);
      }

      // Idle ripple every few seconds, or a bigger one when the hand moves low
      if (h.p.y < 1.2 && h.speed > ACTIVE_SPEED) {
        spawnRipple(h.p.x, h.p.z, color);
      }
    });

    for (let i = 0; i < WAKE_POOL; i++) {
      if (wakeLife[i] <= 0) {
        wakeColor[i * 3] = wakeColor[i * 3 + 1] = wakeColor[i * 3 + 2] = 0;
        continue;
      }
      wakeLife[i] -= dt;
      wakeVel[i].multiplyScalar(Math.exp(-2.5 * dt));
      wakePos[i * 3] += wakeVel[i].x * dt;
      wakePos[i * 3 + 1] += wakeVel[i].y * dt;
      wakePos[i * 3 + 2] += wakeVel[i].z * dt;
      // Fade out through colour, since additive blending turns dark into invisible
      const fade = Math.max(0, Math.min(1, wakeLife[i] * 1.5));
      wakeColor[i * 3] *= 0.95 * fade + 0.0;
      wakeColor[i * 3 + 1] *= 0.95 * fade + 0.0;
      wakeColor[i * 3 + 2] *= 0.95 * fade + 0.0;
    }
    wakeGeometry.attributes.position.needsUpdate = true;
    wakeGeometry.attributes.color.needsUpdate = true;

    // Ripples expand and fade
    for (const r of rings) {
      if (!r.mesh.visible) continue;
      r.t = Math.min(1, r.t + dt / 1.2);
      r.mesh.scale.setScalar(0.5 + r.t * 6);
      r.material.opacity = (1 - r.t) * 0.7;
      if (r.t >= 1) r.mesh.visible = false;
    }

    // Breathing light: the sky never sits still
    breath += dt * 0.02;
    hemi.color.setHSL(0.6 + Math.sin(breath) * 0.06, 0.25, 0.85);
  }

  return { update };
}
