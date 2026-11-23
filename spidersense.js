import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Spider-Sense: bullet time when something fast is heading for you.
//
//   Threat    : a free object within THREAT_RANGE, closing on your head faster
//               than THREAT_SPEED. Objects you just let go of are ignored.
//   Effect    : the world slows to SLOW_FACTOR, easing in and out. Your own
//               movement, hands and gestures stay at real time.
//   Cooldown  : COOLDOWN seconds before it can fire again.
//   Enabled   : only while Spider-Sense is the equipped power.
//
// update(dt) takes REAL time (the player clock) and returns the world factor.
// ---------------------------------------------------------------------------

const THREAT_RANGE = 6;        // m
const THREAT_SPEED = 4;        // m/s closing speed
const RELEASE_GRACE = 1.5;     // s after letting go before an object can threaten you
const SLOW_FACTOR = 0.2;
const EASE_IN = 0.15;          // s
const HOLD = 0.7;              // s
const EASE_OUT = 0.3;          // s
const COOLDOWN = 4;            // s

const _head = new THREE.Vector3();
const _rel = new THREE.Vector3();
const _right = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const TINT_MAX = 0.45;         // strongest the red edge can get, so it stays comfortable

// Soft red vignette: clear in the middle, red toward the edges
function vignetteTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(128, 128, 40, 128, 128, 128);
  grad.addColorStop(0, 'rgba(255,30,30,0)');
  grad.addColorStop(0.55, 'rgba(255,30,30,0)');
  grad.addColorStop(1, 'rgba(255,30,30,1)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
// Strip that is solid red at one end and clear toward the middle
function edgeTexture() {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 4;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 256, 0);
  grad.addColorStop(0, 'rgba(255,60,60,1)');
  grad.addColorStop(0.6, 'rgba(255,60,60,0)');
  grad.addColorStop(1, 'rgba(255,60,60,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 4);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function createSpiderSense({ bodies, camera, isEnabled, tintEnabled = () => true }) {
  // The overlay lives on the camera, so it also shows inside a headset
  const overlay = new THREE.Group();
  overlay.position.set(0, 0, -0.3);
  camera.add(overlay);
  const overlayMat = (map) => new THREE.MeshBasicMaterial({
    map, transparent: true, opacity: 0, depthTest: false, depthWrite: false,
  });
  const vignette = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 0.6), overlayMat(vignetteTexture()));
  const leftStrip = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.6), overlayMat(edgeTexture()));
  const rightStrip = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.6), overlayMat(edgeTexture()));
  leftStrip.position.x = -0.26;
  rightStrip.position.x = 0.26;
  rightStrip.rotation.y = Math.PI;   // solid edge faces outward on the right
  for (const m of [vignette, leftStrip, rightStrip]) {
    m.renderOrder = 999;
    overlay.add(m);
  }
  let pulseClock = 0;

  function updateOverlay(dt) {
    pulseClock += dt;
    const pulse = 0.75 + 0.25 * Math.sin(pulseClock * 12);
    const tint = tintEnabled() ? 1 : 0;
    vignette.material.opacity = threatLevel * TINT_MAX * pulse * tint;

    // Which side the threat is on, relative to where you're facing
    camera.getWorldDirection(_fwd);
    _fwd.y = 0;
    if (_fwd.lengthSq() < 1e-6) _fwd.set(0, 0, -1);
    _fwd.normalize();
    _right.crossVectors(_fwd, UP).normalize();
    const side = threatDir.dot(_right);
    const sideAmt = Math.min(1, Math.abs(side) * 2);
    const onRight = side > 0;
    const strength = threatLevel * sideAmt * TINT_MAX * 1.4 * pulse * tint;
    rightStrip.material.opacity = onRight ? strength : 0;
    leftStrip.material.opacity = onRight ? 0 : strength;
  }

  let phase = 'idle';    // idle | in | hold | out
  let t = 0;
  let cooldown = 0;
  let threatDir = new THREE.Vector3();   // unit vector from you to the threat
  let threatLevel = 0;                   // 0..1, for the visual cue in stage 3

  function findThreat(now) {
    camera.getWorldPosition(_head);
    let best = null;
    let bestScore = 0;
    for (const b of bodies) {
      if (b.state !== 'free') continue;
      if (b.releasedAt !== undefined && now - b.releasedAt < RELEASE_GRACE) continue;
      _rel.subVectors(b.center, _head);
      const dist = _rel.length();
      if (dist > THREAT_RANGE || dist < 1e-3) continue;
      _rel.divideScalar(dist);
      // Closing speed: how fast the object moves toward your head
      const closing = -b.vel.dot(_rel);
      if (closing < THREAT_SPEED) continue;
      const score = closing / dist;   // fast and close wins
      if (score > bestScore) {
        bestScore = score;
        best = { body: b, dir: _rel.clone(), dist };   // from you toward the threat
      }
    }
    return best;
  }

  // Ease in/out curve for the bullet-time factor
  function curve() {
    if (phase === 'in') return 1 + (SLOW_FACTOR - 1) * smooth(t / EASE_IN);
    if (phase === 'hold') return SLOW_FACTOR;
    if (phase === 'out') return SLOW_FACTOR + (1 - SLOW_FACTOR) * smooth(t / EASE_OUT);
    return 1;
  }
  const smooth = (x) => {
    const c = Math.min(1, Math.max(0, x));
    return c * c * (3 - 2 * c);
  };

  function update(dt) {
    if (dt <= 0) return 1;
    const now = performance.now() / 1000;
    cooldown = Math.max(0, cooldown - dt);

    if (!isEnabled()) {
      phase = 'idle';
      threatLevel = 0;
      updateOverlay(dt);
      return 1;
    }

    if (phase === 'idle' && cooldown === 0) {
      const threat = findThreat(now);
      if (threat) {
        phase = 'in';
        t = 0;
        cooldown = COOLDOWN;
        threatDir.copy(threat.dir);
      }
    }

    if (phase !== 'idle') {
      t += dt;
      if (phase === 'in' && t >= EASE_IN) { phase = 'hold'; t = 0; }
      else if (phase === 'hold' && t >= HOLD) { phase = 'out'; t = 0; }
      else if (phase === 'out' && t >= EASE_OUT) { phase = 'idle'; t = 0; }
    }

    // How strongly the sense is firing (0 idle, 1 at full bullet time)
    threatLevel = phase === 'idle' ? 0 : 1 - (curve() - SLOW_FACTOR) / (1 - SLOW_FACTOR);
    updateOverlay(dt);
    return curve();
  }

  return {
    update,
    get threatDir() { return threatDir; },
    get threatLevel() { return threatLevel; },
    get active() { return phase !== 'idle'; },
  };
}
