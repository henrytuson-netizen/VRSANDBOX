import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Comfort vignette: a soft dark frame at the edges of the view that grows as
// you move faster, so fast swings and flights feel less sudden. It sits on the
// camera, so it also shows inside a headset.
// ---------------------------------------------------------------------------

const FULL_AT = 9;      // m/s: the vignette is at its strongest here
const START_AT = 3;     // m/s: below this, no vignette
const MAX_OPACITY = 0.55;

function darkVignetteTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(128, 128, 60, 128, 128, 128);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(0.6, 'rgba(0,0,0,0)');
  grad.addColorStop(1, 'rgba(0,0,0,1)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function createComfort({ camera, player, settings }) {
  const overlay = new THREE.Group();
  overlay.position.set(0, 0, -0.3);
  camera.add(overlay);
  const material = new THREE.MeshBasicMaterial({
    map: darkVignetteTexture(), transparent: true, opacity: 0, depthTest: false, depthWrite: false,
  });
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 0.6), material);
  plane.renderOrder = 998;
  overlay.add(plane);

  const prev = player.position.clone();
  const vel = new THREE.Vector3();
  let speed = 0;

  function update(dt) {
    if (dt > 0) {
      vel.copy(player.position).sub(prev).divideScalar(dt);
      speed += (vel.length() - speed) * (1 - Math.exp(-6 * dt));
    }
    prev.copy(player.position);
    const amount = settings.vignette
      ? THREE.MathUtils.clamp((speed - START_AT) / (FULL_AT - START_AT), 0, 1)
      : 0;
    material.opacity = amount * MAX_OPACITY;
  }

  return { update };
}
