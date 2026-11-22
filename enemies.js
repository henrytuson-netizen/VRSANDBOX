import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Enemies with guns. They turn to face you, aim at your head, and fire bullets.
//
//   Bullets   : real physics bodies, so Spider-Sense can see them coming.
//   Fire rate : every 2.5-4 s per enemy, with a little spread.
//   Hits      : a bullet that passes within reach of your head counts as a hit.
//   Knockdown : a thrown object hitting an enemy knocks it down for a while.
//
// All enemy timing uses world time, so bullet time slows their fire too.
// ---------------------------------------------------------------------------

const ENEMY_SPOTS = [
  { x: -6, z: -11 }, { x: -2.5, z: -13 }, { x: 2.5, z: -13 }, { x: 6, z: -11 },
];
const BULLET_SPEED = 18;       // m/s
const BULLET_SPREAD = 0.05;    // radians of aim error
const FIRE_RANGE = 25;         // m
const HIT_RADIUS = 0.35;       // m from your head
const KNOCK_SPEED = 3;         // m/s a thrown object needs to knock an enemy down
const DOWN_TIME = 6;           // s a knocked-down enemy stays down
const FALL_TIME = 0.4;         // s to fall over

export function createEnemies({ scene, player, camera, bodies, gridTexture, fireBullet, onHit }) {
  const bodyMaterial = new THREE.MeshStandardMaterial({ color: 0x343a40, map: gridTexture, roughness: 0.6 });
  const armorMaterial = new THREE.MeshStandardMaterial({ color: 0xc92a2a, map: gridTexture, roughness: 0.5 });
  const gunMaterial = new THREE.MeshStandardMaterial({ color: 0x212529, map: gridTexture, metalness: 0.6, roughness: 0.4 });
  const flashMaterial = new THREE.MeshBasicMaterial({ color: 0xffe066, transparent: true, opacity: 0.9 });
  const boxGeometry = (x, y, z) => new THREE.BoxGeometry(x, y, z);

  const enemies = ENEMY_SPOTS.map((spot) => {
    const root = new THREE.Group();          // position and facing, pivot at the feet
    root.position.set(spot.x, 0, spot.z);
    scene.add(root);

    const tilt = new THREE.Group();          // falls over around the feet
    root.add(tilt);

    const parts = [
      new THREE.Mesh(boxGeometry(0.2, 0.8, 0.2), bodyMaterial),   // left leg
      new THREE.Mesh(boxGeometry(0.2, 0.8, 0.2), bodyMaterial),   // right leg
      new THREE.Mesh(boxGeometry(0.55, 0.75, 0.3), armorMaterial), // torso
      new THREE.Mesh(new THREE.SphereGeometry(0.16, 16, 12), bodyMaterial), // head
      new THREE.Mesh(boxGeometry(0.12, 0.55, 0.12), bodyMaterial), // left arm
      new THREE.Mesh(boxGeometry(0.12, 0.55, 0.12), bodyMaterial), // right arm
    ];
    parts[0].position.set(-0.12, 0.4, 0);
    parts[1].position.set(0.12, 0.4, 0);
    parts[2].position.set(0, 1.17, 0);
    parts[3].position.set(0, 1.7, 0);
    parts[4].position.set(-0.37, 1.2, 0);
    parts[5].position.set(0.37, 1.2, 0);
    parts.forEach((p) => tilt.add(p));

    // The gun is held out in front of the right arm, pointing forward (-z)
    const gun = new THREE.Mesh(boxGeometry(0.1, 0.12, 0.45), gunMaterial);
    gun.position.set(0.37, 1.1, -0.28);
    tilt.add(gun);
    const muzzle = new THREE.Object3D();
    muzzle.position.set(0.37, 1.1, -0.55);
    tilt.add(muzzle);
    const flash = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 6), flashMaterial);
    flash.position.copy(muzzle.position);
    flash.visible = false;
    tilt.add(flash);

    return {
      root, tilt, muzzle, flash, gun,
      fireTimer: 1 + Math.random() * 2,
      flashTimer: 0,
      state: 'up',          // up | falling | down
      stateTime: 0,
    };
  });

  const _head = new THREE.Vector3();
  const _muzzle = new THREE.Vector3();
  const _dir = new THREE.Vector3();
  const _center = new THREE.Vector3();
  let hits = 0;

  // Screen counter
  const counter = document.createElement('div');
  counter.style.cssText =
    'position:fixed;top:12px;left:50%;transform:translateX(-50%);font:bold 16px system-ui,sans-serif;' +
    'color:#ffe066;text-shadow:0 0 6px #000;pointer-events:none;user-select:none;';
  counter.textContent = 'Hits: 0';
  document.body.appendChild(counter);

  function faceAndAim(e) {
    // Turn to face the player (yaw only)
    const dx = player.position.x - e.root.position.x;
    const dz = player.position.z - e.root.position.z;
    e.root.rotation.y = Math.atan2(dx, dz) + Math.PI;
  }

  function fire(e) {
    e.muzzle.updateWorldMatrix(true, false);
    e.muzzle.getWorldPosition(_muzzle);
    camera.getWorldPosition(_head);
    _dir.subVectors(_head, _muzzle).normalize();
    // Spread the aim a little so bullets don't all land on the same spot
    _dir.x += (Math.random() - 0.5) * BULLET_SPREAD;
    _dir.y += (Math.random() - 0.5) * BULLET_SPREAD;
    _dir.normalize();
    fireBullet(_muzzle.clone(), _dir.clone().multiplyScalar(BULLET_SPEED));
    e.flash.visible = true;
    e.flashTimer = 0.06;
  }

  function knockDown(e) {
    e.state = 'falling';
    e.stateTime = 0;
  }

  function update(dt) {
    if (dt <= 0) return;
    const time = dt;

    for (const e of enemies) {
      e.stateTime += time;

      // Knockdown and recovery
      if (e.state === 'falling') {
        const k = Math.min(1, e.stateTime / FALL_TIME);
        e.tilt.rotation.z = -(Math.PI / 2) * k;
        if (k >= 1) { e.state = 'down'; e.stateTime = 0; }
      } else if (e.state === 'down') {
        if (e.stateTime >= DOWN_TIME) {
          e.state = 'up';
          e.stateTime = 0;
          e.tilt.rotation.z = 0;
        }
      }

      if (e.state !== 'up') {
        e.flash.visible = false;
        continue;
      }

      faceAndAim(e);

      // Muzzle flash fades
      if (e.flashTimer > 0) {
        e.flashTimer -= time;
        if (e.flashTimer <= 0) e.flash.visible = false;
      }

      // Fire when the timer runs out and the player is in range
      e.fireTimer -= time;
      const dist = e.root.position.distanceTo(player.position);
      if (e.fireTimer <= 0) {
        e.fireTimer = 2.5 + Math.random() * 1.5;
        if (dist < FIRE_RANGE) fire(e);
      }

      // Thrown objects knock enemies down
      _center.copy(e.root.position);
      _center.y += 1.0;
      for (const b of bodies) {
        if (b.bullet || b.state !== 'free') continue;
        if (b.vel.length() < KNOCK_SPEED) continue;
        if (b.center.distanceTo(_center) < 0.8) {
          knockDown(e);
          break;
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
        counter.textContent = `Hits: ${hits}`;
        if (onHit) onHit(hits);
      }
    }
  }

  return {
    update,
    get hits() { return hits; },
  };
}
