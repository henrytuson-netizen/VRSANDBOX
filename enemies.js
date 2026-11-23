import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Enemies. Nothing spawns on its own: you summon them from the command menu.
//
//   gunman : 3 hits. Fires every 2.5-4 s, a quick round with some spread.
//   sniper : 2 hits. Fires every 6-7 s from far off, a very fast and accurate round.
//   brute  : 6 hits. No gun. Charges you and bashes you when it reaches you.
//
//   Health  : thrown objects and your hands deal damage, with a short cooldown.
//   Death   : the enemy falls over and clears away after a few seconds.
//   Bullets : real physics bodies, so Spider-Sense can see them coming.
//
// All enemy timing uses world time, so bullet time slows them too.
// ---------------------------------------------------------------------------

export const ENEMY_TYPES = {
  gunman: { hp: 3, fire: [2.5, 4], speed: 18, spread: 0.05, range: 25, color: 0xc92a2a, scale: 1, gun: true, melee: false },
  sniper: { hp: 2, fire: [6, 7], speed: 40, spread: 0.01, range: 60, color: 0x1864ab, scale: 1.05, gun: true, melee: false },
  brute:  { hp: 6, fire: [0, 0], speed: 0, spread: 0, range: 0, color: 0x2b8a3e, scale: 1.6, gun: false, melee: true },
};

const POOL = 8;                 // enemy objects, reused
const SPAWN_IN = 0.6;           // s to rise out of the floor
const SPAWN_DIST = { min: 12, max: 18 };
const SPAWN_ARC = Math.PI * 0.7; // radians either side of forward
const DEAD_TIME = 2.5;          // s a fallen enemy stays down before it's cleared
const BULLET_RADIUS = 0.05;
const HIT_RADIUS = 0.35;        // m around your head that a bullet must pass to hit
const FALL_TIME = 0.4;
const BODY_HIT_RADIUS = 0.9;
const BODY_HIT_SPEED = 2;       // m/s a thrown object needs to hurt an enemy
const HAND_HIT_SPEED = 2;       // m/s a hand needs to punch an enemy
const HIT_COOLDOWN = 0.4;       // s before the same thing can hurt the same enemy again
const BRUTE_SPEED = 1.8;        // m/s walk toward you
const BRUTE_REACH = 1.6;        // m from you to bash
const BRUTE_BASH_EVERY = 1.2;   // s between bashes

export function createEnemies({ scene, player, camera, bodies, hands, gridTexture, fireBullet, onHit, sfx }) {
  const bodyMaterial = new THREE.MeshStandardMaterial({ color: 0x343a40, map: gridTexture, roughness: 0.6 });
  const gunMaterial = new THREE.MeshStandardMaterial({ color: 0x212529, map: gridTexture, metalness: 0.6, roughness: 0.4 });
  const flashMaterial = new THREE.MeshBasicMaterial({ color: 0xffe066, transparent: true, opacity: 0.9 });
  const spawnMaterial = new THREE.MeshBasicMaterial({ color: 0xffe066, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false });
  const spawnRingGeometry = new THREE.RingGeometry(0.4, 0.6, 32);
  spawnRingGeometry.rotateX(-Math.PI / 2);

  function buildEnemy() {
    const root = new THREE.Group();
    root.visible = false;
    scene.add(root);
    const tilt = new THREE.Group();
    root.add(tilt);

    const armorMaterial = new THREE.MeshStandardMaterial({ color: 0xc92a2a, map: gridTexture, roughness: 0.5 });
    const parts = [
      new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.8, 0.2), bodyMaterial),
      new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.8, 0.2), bodyMaterial),
      new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.75, 0.3), armorMaterial),
      new THREE.Mesh(new THREE.SphereGeometry(0.16, 16, 12), bodyMaterial),
      new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.55, 0.12), bodyMaterial),
      new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.55, 0.12), bodyMaterial),
    ];
    parts[0].position.set(-0.12, 0.4, 0);
    parts[1].position.set(0.12, 0.4, 0);
    parts[2].position.set(0, 1.17, 0);
    parts[3].position.set(0, 1.7, 0);
    parts[4].position.set(-0.37, 1.2, 0);
    parts[5].position.set(0.37, 1.2, 0);
    parts.forEach((p) => tilt.add(p));

    const gun = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.12, 0.45), gunMaterial);
    gun.position.set(0.37, 1.1, -0.28);
    tilt.add(gun);
    const muzzle = new THREE.Object3D();
    muzzle.position.set(0.37, 1.1, -0.55);
    tilt.add(muzzle);
    const flash = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 6), flashMaterial);
    flash.position.copy(muzzle.position);
    flash.visible = false;
    tilt.add(flash);

    const ring = new THREE.Mesh(spawnRingGeometry, spawnMaterial);
    ring.visible = false;
    scene.add(ring);

    return {
      root, tilt, armor: parts[2], gun, muzzle, flash, ring,
      type: 'gunman',
      cfg: ENEMY_TYPES.gunman,
      state: 'inactive',       // inactive | spawning | up | falling | down
      stateTime: 0,
      hp: 3,
      fireTimer: 0,
      flashTimer: 0,
      bashTimer: 0,
      hitTimes: new Map(),
    };
  }

  const pool = Array.from({ length: POOL }, buildEnemy);
  let hits = 0;
  let kills = 0;
  let bumps = 0;

  // Screen counter
  const counter = document.createElement('div');
  counter.style.cssText =
    'position:fixed;top:12px;left:50%;transform:translateX(-50%);font:bold 16px system-ui,sans-serif;' +
    'color:#ffe066;text-shadow:0 0 6px #000;pointer-events:none;user-select:none;text-align:center;';
  document.body.appendChild(counter);
  function showCounter() {
    counter.innerHTML = `Hits taken: ${hits}<br>Bashed: ${bumps}<br>Enemies down: ${kills}`;
  }
  showCounter();

  const _head = new THREE.Vector3();
  const _muzzle = new THREE.Vector3();
  const _dir = new THREE.Vector3();
  const _center = new THREE.Vector3();
  const _fwd = new THREE.Vector3();

  function alive(e) {
    return e.state === 'spawning' || e.state === 'up';
  }

  // Summon one enemy of a type, at a random point in front of the player
  function spawn(type = 'gunman') {
    const slot = pool.find((e) => e.state === 'inactive');
    if (!slot) return false;
    const cfg = ENEMY_TYPES[type];

    camera.getWorldDirection(_fwd);
    const base = Math.atan2(_fwd.x, _fwd.z) + Math.PI;
    const a = base + (Math.random() * 2 - 1) * SPAWN_ARC;
    const r = SPAWN_DIST.min + Math.random() * (SPAWN_DIST.max - SPAWN_DIST.min);
    slot.root.position.set(player.position.x + Math.sin(a) * r, -1.8, player.position.z + Math.cos(a) * r);
    slot.root.scale.setScalar(cfg.scale);
    slot.root.visible = true;
    slot.tilt.rotation.z = 0;
    slot.armor.material.color.setHex(cfg.color);
    slot.gun.visible = cfg.gun;
    slot.muzzle.visible = cfg.gun;
    slot.type = type;
    slot.cfg = cfg;
    slot.hp = cfg.hp;
    slot.hitTimes.clear();
    slot.state = 'spawning';
    slot.stateTime = 0;
    slot.fireTimer = cfg.gun ? cfg.fire[0] + Math.random() * (cfg.fire[1] - cfg.fire[0]) : 0;
    slot.bashTimer = 0;
    slot.ring.position.set(slot.root.position.x, 0.02, slot.root.position.z);
    slot.ring.visible = true;
    sfx.play('spawn');
    return true;
  }

  // Clears every enemy on the field
  function clear() {
    for (const e of pool) {
      if (e.state === 'inactive') continue;
      e.state = 'inactive';
      e.root.visible = false;
      e.ring.visible = false;
      e.flash.visible = false;
    }
  }

  function fire(e) {
    e.muzzle.updateWorldMatrix(true, false);
    e.muzzle.getWorldPosition(_muzzle);
    camera.getWorldPosition(_head);
    _dir.subVectors(_head, _muzzle).normalize();
    _dir.x += (Math.random() - 0.5) * e.cfg.spread;
    _dir.y += (Math.random() - 0.5) * e.cfg.spread;
    _dir.normalize();
    fireBullet(_muzzle.clone(), _dir.clone().multiplyScalar(e.cfg.speed), BULLET_RADIUS);
    e.flash.visible = true;
    e.flashTimer = 0.06;
    sfx.play('bulletFire');
  }

  function damage(e, amount, key, time) {
    const last = e.hitTimes.get(key);
    if (last !== undefined && time - last < HIT_COOLDOWN) return;
    e.hitTimes.set(key, time);
    e.hp -= amount;
    if (e.hp <= 0 && alive(e)) {
      e.state = 'falling';
      e.stateTime = 0;
      kills++;
      showCounter();
      sfx.play('enemyDown');
    } else {
      sfx.play('enemyHurt');
    }
  }

  function update(dt) {
    if (dt <= 0) return;
    const now = performance.now() / 1000;

    for (const e of pool) {
      if (e.state === 'inactive') continue;
      e.stateTime += dt;

      if (e.state === 'spawning') {
        // Rise out of the floor, with a ring that spreads and fades
        const k = Math.min(1, e.stateTime / SPAWN_IN);
        e.root.position.y = -1.8 * (1 - k);
        e.ring.scale.setScalar(1 + k * 2);
        spawnMaterial.opacity = 0.8 * (1 - k);
        if (k >= 1) {
          e.state = 'up';
          e.stateTime = 0;
          e.ring.visible = false;
        }
        continue;
      }

      if (e.state === 'falling') {
        const k = Math.min(1, e.stateTime / FALL_TIME);
        e.tilt.rotation.z = -(Math.PI / 2) * k;
        if (k >= 1) {
          e.state = 'down';
          e.stateTime = 0;
        }
        continue;
      }

      if (e.state === 'down') {
        if (e.stateTime >= DEAD_TIME) {
          e.state = 'inactive';
          e.root.visible = false;
        }
        continue;
      }

      // Alive and standing: face the player
      const dx = player.position.x - e.root.position.x;
      const dz = player.position.z - e.root.position.z;
      e.root.rotation.y = Math.atan2(dx, dz) + Math.PI;
      const dist = Math.hypot(dx, dz);

      if (e.flashTimer > 0) {
        e.flashTimer -= dt;
        if (e.flashTimer <= 0) e.flash.visible = false;
      }

      if (e.cfg.melee) {
        // Brute: walk in, then bash
        if (dist > BRUTE_REACH) {
          const step = Math.min(dist - BRUTE_REACH, BRUTE_SPEED * dt);
          e.root.position.x += (dx / dist) * step;
          e.root.position.z += (dz / dist) * step;
        } else {
          e.bashTimer -= dt;
          if (e.bashTimer <= 0) {
            e.bashTimer = BRUTE_BASH_EVERY;
            bumps++;
            showCounter();
            sfx.play('hitPlayer');
          }
        }
      } else if (e.cfg.gun) {
        // Gunmen and snipers: fire on their own timer while in range
        e.fireTimer -= dt;
        if (e.fireTimer <= 0) {
          e.fireTimer = e.cfg.fire[0] + Math.random() * (e.cfg.fire[1] - e.cfg.fire[0]);
          if (dist < e.cfg.range) fire(e);
        }
      }

      // Damage from thrown objects
      _center.copy(e.root.position);
      _center.y += 1.0 * e.cfg.scale;
      for (const b of bodies) {
        if (b.bullet || b.state !== 'free') continue;
        if (b.vel.length() < BODY_HIT_SPEED) continue;
        if (b.center.distanceTo(_center) < BODY_HIT_RADIUS * e.cfg.scale) {
          damage(e, Math.max(1, Math.round(b.vel.length() / 5)), b, now);
        }
      }

      // Damage from your hands
      for (const rig of hands) {
        for (const kb of rig.kinJoints.values()) {
          if (!kb.active || kb.vel.length() < HAND_HIT_SPEED) continue;
          if (kb.center.distanceTo(_center) < BODY_HIT_RADIUS * e.cfg.scale) {
            damage(e, 1, kb, now);
          }
        }
      }
    }

    // Bullets that reach your head count as hits
    camera.getWorldPosition(_head);
    for (const b of bodies) {
      if (!b.bullet || b.dead) continue;
      if (b.mesh.position.distanceTo(_head) < HIT_RADIUS) {
        b.dead = true;
        hits++;
        showCounter();
        sfx.play('hitPlayer');
        if (onHit) onHit(hits);
      }
    }
  }

  return {
    update,
    spawn,
    clear,
    get hits() { return hits; },
    get kills() { return kills; },
    get aliveCount() { return pool.filter(alive).length; },
  };
}
