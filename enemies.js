import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Enemies with guns. They spawn in during play, shoot at your head, and can be
// killed.
//
//   Spawning  : up to MAX_ALIVE at a time, one every SPAWN_EVERY seconds.
//               Each rises out of the floor in a flash, at a random point in
//               front of you.
//   Health    : HP hits to kill. Thrown objects and your hands deal damage.
//   Death     : the enemy falls over and goes away after a few seconds.
//   Shooting  : fires every 2.5-4 s, only while alive and in range.
//   Bullets   : real physics bodies, so Spider-Sense can see them coming.
//
// All enemy timing uses world time, so bullet time slows their fire too.
// ---------------------------------------------------------------------------

const POOL = 6;                 // enemy objects, reused
const MAX_ALIVE = 4;
const SPAWN_EVERY = 5;          // s between spawns
const SPAWN_IN = 0.6;           // s to rise out of the floor
const SPAWN_DIST = [12, 18];    // m from you
const SPAWN_ARC = Math.PI * 0.7; // radians either side of forward
const HP = 3;
const DEAD_TIME = 2.5;          // s a fallen enemy stays down before it's cleared
const BULLET_SPEED = 18;
const BULLET_SPREAD = 0.05;
const FIRE_RANGE = 25;
const HIT_RADIUS = 0.35;
const FALL_TIME = 0.4;
const BODY_HIT_RADIUS = 0.9;
const BODY_HIT_SPEED = 2;       // m/s a thrown object needs to hurt an enemy
const HAND_HIT_SPEED = 2;       // m/s a hand needs to punch an enemy
const HIT_COOLDOWN = 0.4;       // s before the same thing can hurt the same enemy again

export function createEnemies({ scene, player, camera, bodies, hands, gridTexture, fireBullet, onHit }) {
  const bodyMaterial = new THREE.MeshStandardMaterial({ color: 0x343a40, map: gridTexture, roughness: 0.6 });
  const armorMaterial = new THREE.MeshStandardMaterial({ color: 0xc92a2a, map: gridTexture, roughness: 0.5 });
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
      root, tilt, muzzle, flash, ring,
      state: 'inactive',       // inactive | spawning | up | falling | down
      stateTime: 0,
      hp: HP,
      fireTimer: 0,
      flashTimer: 0,
      hitTimes: new Map(),     // what hurt us recently -> time
    };
  }

  const pool = Array.from({ length: POOL }, buildEnemy);
  let spawnTimer = 3;          // first spawn a few seconds in
  let hits = 0;
  let kills = 0;

  // Screen counter
  const counter = document.createElement('div');
  counter.style.cssText =
    'position:fixed;top:12px;left:50%;transform:translateX(-50%);font:bold 16px system-ui,sans-serif;' +
    'color:#ffe066;text-shadow:0 0 6px #000;pointer-events:none;user-select:none;text-align:center;';
  document.body.appendChild(counter);
  function showCounter() {
    counter.innerHTML = `Hits taken: ${hits}<br>Enemies down: ${kills}`;
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

  function trySpawn() {
    const aliveCount = pool.filter(alive).length;
    if (aliveCount >= MAX_ALIVE) return;
    const slot = pool.find((e) => e.state === 'inactive');
    if (!slot) return;

    // A random spot in front of the player, away from the spot they're standing on
    camera.getWorldDirection(_fwd);
    const base = Math.atan2(_fwd.x, _fwd.z) + Math.PI;
    const a = base + (Math.random() * 2 - 1) * SPAWN_ARC;
    const r = SPAWN_DIST[0] + Math.random() * (SPAWN_DIST[1] - SPAWN_DIST[0]);
    slot.root.position.set(player.position.x + Math.sin(a) * r, -1.8, player.position.z + Math.cos(a) * r);
    slot.root.visible = true;
    slot.tilt.rotation.z = 0;
    slot.hp = HP;
    slot.hitTimes.clear();
    slot.state = 'spawning';
    slot.stateTime = 0;
    slot.fireTimer = 1 + Math.random() * 2;
    slot.ring.position.set(slot.root.position.x, 0.02, slot.root.position.z);
    slot.ring.visible = true;
  }

  function fire(e) {
    e.muzzle.updateWorldMatrix(true, false);
    e.muzzle.getWorldPosition(_muzzle);
    camera.getWorldPosition(_head);
    _dir.subVectors(_head, _muzzle).normalize();
    _dir.x += (Math.random() - 0.5) * BULLET_SPREAD;
    _dir.y += (Math.random() - 0.5) * BULLET_SPREAD;
    _dir.normalize();
    fireBullet(_muzzle.clone(), _dir.clone().multiplyScalar(BULLET_SPEED));
    e.flash.visible = true;
    e.flashTimer = 0.06;
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
    }
  }

  function update(dt) {
    if (dt <= 0) return;

    spawnTimer -= dt;
    if (spawnTimer <= 0) {
      spawnTimer = SPAWN_EVERY;
      trySpawn();
    }

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

      // Alive and standing: face the player and shoot
      const dx = player.position.x - e.root.position.x;
      const dz = player.position.z - e.root.position.z;
      e.root.rotation.y = Math.atan2(dx, dz) + Math.PI;

      if (e.flashTimer > 0) {
        e.flashTimer -= dt;
        if (e.flashTimer <= 0) e.flash.visible = false;
      }

      e.fireTimer -= dt;
      const dist = e.root.position.distanceTo(player.position);
      if (e.fireTimer <= 0) {
        e.fireTimer = 2.5 + Math.random() * 1.5;
        if (dist < FIRE_RANGE) fire(e);
      }

      // Damage from thrown objects
      _center.copy(e.root.position);
      _center.y += 1.0;
      for (const b of bodies) {
        if (b.bullet || b.state !== 'free') continue;
        if (b.vel.length() < BODY_HIT_SPEED) continue;
        if (b.center.distanceTo(_center) < BODY_HIT_RADIUS) {
          damage(e, Math.max(1, Math.round(b.vel.length() / 5)), b, performance.now() / 1000);
        }
      }

      // Damage from your hands
      for (const rig of hands) {
        for (const kb of rig.kinJoints.values()) {
          if (!kb.active || kb.vel.length() < HAND_HIT_SPEED) continue;
          if (kb.center.distanceTo(_center) < BODY_HIT_RADIUS) {
            damage(e, 1, kb, performance.now() / 1000);
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
        if (onHit) onHit(hits);
      }
    }
  }

  return {
    update,
    get hits() { return hits; },
    get kills() { return kills; },
    get aliveCount() { return pool.filter(alive).length; },
  };
}
