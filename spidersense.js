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

export function createSpiderSense({ bodies, camera, isEnabled }) {
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
        best = { body: b, dir: _rel.clone().negate(), dist };
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
    return curve();
  }

  return {
    update,
    get threatDir() { return threatDir; },
    get threatLevel() { return threatLevel; },
    get active() { return phase !== 'idle'; },
  };
}
