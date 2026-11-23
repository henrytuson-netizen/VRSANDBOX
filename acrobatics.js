import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Acrobatics, part of the Spider power.
//
//   Hand-plant vault : run fast and plant one open hand, nearly still, on the
//                      floor or a building. You vault up and keep your speed.
//   Sweep jump       : from the ground, sweep both hands up together.
//
// Both only fire after a short hold and then wait a moment, so ordinary arm
// movement doesn't set them off.
// ---------------------------------------------------------------------------

const RUN_SPEED = 3;            // m/s you must be moving to vault
const PLANT_HEIGHT = 0.3;       // m: a hand this low counts as planted on the floor
const PLANT_REACH = 0.25;       // m from a building face
const PLANT_STILL = 0.6;        // m/s: the planted hand must be nearly still
const PLANT_HOLD = 0.1;         // s the hand must stay planted
const SWEEP_SPEED = 2.5;        // m/s upward sweep of both hands
const VAULT_LAUNCH = 6;         // m/s up
const JUMP_LAUNCH = 7;          // m/s up
const COOLDOWN = 0.9;           // s between moves

function boxDistance(p, b) {
  const dx = Math.max(Math.abs(p.x - b.center.x) - b.half.x, 0);
  const dy = Math.max(Math.abs(p.y - b.center.y) - b.half.y, 0);
  const dz = Math.max(Math.abs(p.z - b.center.z) - b.half.z, 0);
  return Math.hypot(dx, dy, dz);
}

export function createAcrobatics({ player, bodies, octopus, sfx }) {
  const prev = player.position.clone();
  const vel = new THREE.Vector3();
  const rel = new THREE.Vector3();   // hand velocity relative to the world, not to the moving body
  const plantTime = { left: 0, right: 0 };
  let cooldown = 0;
  const counts = { vaults: 0, jumps: 0 };

  function plantedSurface(p) {
    if (p.y < PLANT_HEIGHT) return 'floor';
    for (const b of bodies) {
      if (b.isStatic && boxDistance(p, b) < PLANT_REACH) return 'building';
    }
    return null;
  }

  function update(dt, left, right, blocked) {
    if (dt <= 0) return;
    cooldown = Math.max(0, cooldown - dt);
    vel.copy(player.position).sub(prev).divideScalar(dt);
    prev.copy(player.position);
    const runSpeed = Math.hypot(vel.x, vel.z);

    // Vault: an open hand planted while running fast
    for (const side of ['left', 'right']) {
      const pose = side === 'left' ? left : right;
      rel.copy(pose ? pose.wristVel : vel).sub(vel);
      const planted = pose && pose.fingers.index && pose.fingers.middle && pose.fingers.ring && pose.fingers.pinky
        && plantedSurface(pose.palmCenter) !== null && rel.length() < PLANT_STILL;
      plantTime[side] = planted ? plantTime[side] + dt : 0;
      if (cooldown === 0 && !blocked && plantTime[side] >= PLANT_HOLD && runSpeed > RUN_SPEED) {
        octopus.launch(VAULT_LAUNCH);
        cooldown = COOLDOWN;
        plantTime[side] = 0;
        counts.vaults++;
        sfx.play('jump');
      }
    }

    // Sweep jump: both hands sweep up together from the ground
    if (cooldown === 0 && !blocked && left && right && player.position.y < 0.05) {
      const lUp = left.wristVel.y - vel.y;
      const rUp = right.wristVel.y - vel.y;
      if (lUp > SWEEP_SPEED && rUp > SWEEP_SPEED) {
        octopus.launch(JUMP_LAUNCH);
        cooldown = COOLDOWN;
        counts.jumps++;
        sfx.play('jump');
      }
    }
  }

  return { update, counts: () => ({ ...counts }) };
}
