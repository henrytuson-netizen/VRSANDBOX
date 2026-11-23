import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Hand command menu.
//
//   Open   : turn the BACK of your left hand toward your face. The panel
//            unfolds from the wrist with a springy, staggered animation.
//   Choose : point your right index finger at a button (it lifts and glows),
//            then pinch to run it. The button pulses and a ring bursts out.
//   Close  : turn the hand away. The panel folds back in.
//   Desktop: Tab toggles the menu, keys 1-4 run a command directly.
// ---------------------------------------------------------------------------

const BUTTON_W = 0.2;
const BUTTON_H = 0.046;
const BUTTON_GAP = 0.012;
const OPEN_SPEED = 9;        // higher = snappier
const STAGGER = 0.05;        // seconds between buttons
const PINCH_ON = 0.03;
const PINCH_OFF = 0.045;
const LOOK_ANGLE = 0.8;     // how squarely the back of the hand must face you
const OPEN_HOLD = 0.6;       // seconds of deliberate looking before it opens
const CLOSE_DELAY = 0.3;     // seconds away before it closes

function easeOutBack(t) {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

function labelTexture(text, color, dim) {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 144;
  const g = c.getContext('2d');
  const r = 40;
  g.beginPath();
  g.moveTo(r, 0); g.lineTo(512 - r, 0); g.quadraticCurveTo(512, 0, 512, r);
  g.lineTo(512, 144 - r); g.quadraticCurveTo(512, 144, 512 - r, 144);
  g.lineTo(r, 144); g.quadraticCurveTo(0, 144, 0, 144 - r);
  g.lineTo(0, r); g.quadraticCurveTo(0, 0, r, 0);
  g.closePath();
  g.fillStyle = dim ? 'rgba(40,44,52,0.85)' : `#${color.toString(16).padStart(6, '0')}`;
  g.fill();
  g.fillStyle = dim ? '#7d8590' : '#0b0d12';
  g.font = 'bold 64px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 256, 74);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function createCommandMenu({ scene, camera, hands, keys, commands, sfx }) {
  const panel = new THREE.Group();
  panel.visible = false;
  scene.add(panel);

  const buttons = commands.map((cmd, i) => {
    const material = new THREE.MeshBasicMaterial({
      map: labelTexture(cmd.label, cmd.color, !!cmd.disabled),
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(BUTTON_W, BUTTON_H), material);
    mesh.position.y = -i * (BUTTON_H + BUTTON_GAP);
    panel.add(mesh);
    return { cmd, mesh, material, hover: 0, pulse: 0, index: i };
  });

  // Ring burst shown when a command runs
  const ringGeometry = new THREE.RingGeometry(0.06, 0.08, 40);
  const ringMaterial = new THREE.MeshBasicMaterial({ color: 0xfff1a8, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });
  const ring = new THREE.Mesh(ringGeometry, ringMaterial);
  ring.visible = false;
  panel.add(ring);
  let ringT = 1;

  let openAmount = 0;      // 0 closed .. 1 open
  let target = 0;
  let openAge = 0;         // seconds since opening started, for stagger
  let prevPinch = false;
  let pinching = false;
  let desktopTab = false;
  let desktopOpen = false;   // Tab toggles this, persists between frames
  let lookTimer = 0;
  let awayTimer = 0;
  let handOpen = false;
  const desktopRun = new Set();

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Tab') { e.preventDefault(); desktopTab = true; }
    const m = /^Digit([1-9])$/.exec(e.code);
    if (m) desktopRun.add(Number(m[1]) - 1);
  });

  const _head = new THREE.Vector3();
  const _toHead = new THREE.Vector3();
  const _back = new THREE.Vector3();
  const _tip = new THREE.Vector3();
  const _local = new THREE.Vector3();
  const _pos = new THREE.Vector3();
  const _quat = new THREE.Quaternion();
  const _lift = new THREE.Vector3(0, 0.22, 0);   // desktop: lift the panel so all commands fit

  function runCommand(index) {
    const b = buttons[index];
    if (!b || b.cmd.disabled) return;
    sfx.play('menu');
    b.cmd.run();
    b.pulse = 1;
    ringT = 0;
    ring.visible = true;
    ring.position.copy(b.mesh.position);
  }

  // Panel sits just above the back of the left hand, facing outward
  function placeOnHand(rig) {
    const pose = rig && rig.pose;
    if (!pose) return false;
    camera.getWorldPosition(_head);
    _toHead.subVectors(_head, pose.wrist).normalize();
    _back.copy(pose.palmFacing).negate();                  // back of the hand
    const backToFace = _back.dot(_toHead);
    if (backToFace < LOOK_ANGLE) return false;

    _pos.copy(pose.wrist).addScaledVector(_back, 0.09);
    panel.position.copy(_pos);
    _quat.setFromUnitVectors(new THREE.Vector3(0, 0, 1), _back);
    panel.quaternion.copy(_quat);
    panel.updateWorldMatrix(true, false);
    return true;
  }

  function update(dt) {
    const left = hands.find((h) => h.handedness === 'left');
    const right = hands.find((h) => h.handedness === 'right');
    const leftPose = left && left.pose;
    const rightPose = right && right.pose;

    // Open/close: back of the left hand facing you (or Tab on desktop)
    if (desktopTab) {
      desktopTab = false;
      desktopOpen = !desktopOpen;
    }
    const looking = !!leftPose && placeOnHand(left);
    lookTimer = looking ? lookTimer + dt : 0;
    if (!handOpen && lookTimer >= OPEN_HOLD) handOpen = true;
    if (handOpen) {
      awayTimer = looking ? 0 : awayTimer + dt;
      if (awayTimer > CLOSE_DELAY) handOpen = false;
    }
    let wantOpen = handOpen;
    if (!leftPose && desktopOpen) {
      // Desktop: float the panel in front of the camera, facing it
      wantOpen = true;
      const fwd = camera.getWorldDirection(new THREE.Vector3());
      panel.position.copy(camera.getWorldPosition(_pos)).addScaledVector(fwd, 0.6).add(_lift);
      panel.quaternion.copy(camera.quaternion);
    }
    if (wantOpen && target === 0) openAge = 0;
    target = wantOpen ? 1 : 0;
    if (wantOpen) openAge += dt;

    openAmount += (target - openAmount) * (1 - Math.exp(-OPEN_SPEED * dt));
    panel.visible = openAmount > 0.01;

    // Right index selects by hovering; a pinch runs the hovered button
    let hovered = -1;
    if (panel.visible && rightPose) {
      _tip.copy(rightPose.idxTip);
      panel.worldToLocal(_tip);
      for (const b of buttons) {
        const cx = 0, cy = b.mesh.position.y;
        const hw = BUTTON_W / 2 + 0.01, hh = BUTTON_H / 2 + 0.01;
        if (Math.abs(_tip.x - cx) < hw && Math.abs(_tip.y - cy) < hh && Math.abs(_tip.z) < 0.08) {
          hovered = b.index;
        }
      }
    }
    const pinchNow = rightPose ? (rightPose.idxTip.distanceTo(rightPose.thumbTip) < (pinching ? PINCH_OFF : PINCH_ON)) : false;
    pinching = pinchNow;
    if (pinchNow && !prevPinch && hovered >= 0) runCommand(hovered);
    prevPinch = pinchNow;

    // Desktop number keys run commands
    if (panel.visible) for (const i of desktopRun) runCommand(i);
    desktopRun.clear();

    // Per-button animation: staggered pop-in, hover lift, click pulse
    buttons.forEach((b) => {
      const delay = b.index * STAGGER;
      const local = THREE.MathUtils.clamp((openAge - delay) * 4, 0, 1);
      const pop = target === 1 ? easeOutBack(local) : openAmount;
      const hot = b.index === hovered ? 1 : 0;
      b.hover += (hot - b.hover) * (1 - Math.exp(-14 * dt));
      b.pulse = Math.max(0, b.pulse - dt * 3);
      const scale = pop * (1 + 0.15 * b.hover + 0.1 * Math.sin(b.pulse * Math.PI));
      b.mesh.scale.setScalar(Math.max(0.001, scale));
      b.material.opacity = THREE.MathUtils.clamp(pop, 0, 1);
      b.mesh.position.z = 0.004 * b.hover;
    });

    // Ring burst
    if (ringT < 1) {
      ringT = Math.min(1, ringT + dt * 2.5);
      ring.scale.setScalar(1 + ringT * 4);
      ringMaterial.opacity = 1 - ringT;
      if (ringT >= 1) ring.visible = false;
    }
  }

  return { update, get open() { return target === 1; } };
}
