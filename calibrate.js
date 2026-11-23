import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Gesture calibration. Four short steps, two seconds each:
//   1. pinch with your RIGHT hand
//   2. make a gun pose with your RIGHT hand
//   3. turn your LEFT palm up
// Each step records what your hands do, then sets the matching threshold.
// The result is saved in this browser, so it's there next time.
// ---------------------------------------------------------------------------

const KEY = 'sandboxTuning';
const STEP_TIME = 2;

const STEPS = [
  { text: 'Pinch with your RIGHT hand', side: 'right', kind: 'pinch' },
  { text: 'Make a gun with your RIGHT hand', side: 'right', kind: 'gun' },
  { text: 'Turn your LEFT palm up', side: 'left', kind: 'palm' },
];

export function createCalibration({ hands, tuning, sfx }) {
  // Load saved values, if any
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (saved) Object.assign(tuning, saved);
  } catch (e) {
    // Storage can be blocked; the defaults still work
  }

  const label = document.createElement('div');
  label.style.cssText =
    'position:fixed;bottom:90px;left:50%;transform:translateX(-50%);font:bold 22px system-ui,sans-serif;' +
    'color:#fff;background:rgba(11,13,18,0.75);padding:10px 18px;border-radius:12px;pointer-events:none;' +
    'user-select:none;text-align:center;display:none;';
  document.body.appendChild(label);

  let step = -1;     // -1 idle
  let time = 0;
  let samples = [];
  let message = '';
  let messageTime = 0;

  function say(text, seconds = 2.5) {
    message = text;
    messageTime = seconds;
  }

  function sample(kind, side) {
    // Same fallback as powers.js: if handedness isn't known yet, left is hand 0, right is hand 1
    const rig = hands.find((h) => h.handedness === side) || hands[side === 'left' ? 0 : 1];
    const pose = rig && rig.pose;
    if (!pose) return null;
    if (kind === 'pinch') return pose.idxTip.distanceTo(pose.thumbTip);
    if (kind === 'gun') return pose.thumbTip.distanceTo(pose.idxMeta);
    if (kind === 'palm') return pose.palmFacing.y;
    return null;
  }

  function finish(kind) {
    const sorted = samples.slice().sort((a, b) => a - b);
    if (sorted.length < 5) {
      say('Not enough hand data. Check that the hands are tracked, then try again.', 4);
      return false;
    }
    const low = sorted[Math.floor(sorted.length * 0.1)];
    const mid = sorted[Math.floor(sorted.length / 2)];
    const high = sorted[Math.floor(sorted.length * 0.9)];
    if (kind === 'pinch') {
      tuning.pinchOn = THREE.MathUtils.clamp(low * 1.6, 0.015, 0.05);
      tuning.pinchOff = tuning.pinchOn * 1.5;
    } else if (kind === 'gun') {
      tuning.thumbExt = THREE.MathUtils.clamp(mid * 0.8, 0.04, 0.09);
    } else if (kind === 'palm') {
      tuning.palmUp = THREE.MathUtils.clamp(high * 0.85, 0.5, 0.95);
    }
    return true;
  }

  function start() {
    if (step >= 0) return;
    step = 0;
    time = 0;
    samples = [];
    say('Calibrating. Follow the prompts.', 2);
    sfx.play('menu');
  }

  function update(dt) {
    if (step < 0) {
      label.style.display = 'none';
      if (messageTime > 0) {
        messageTime -= dt;
        label.textContent = message;
        label.style.display = 'block';
      }
      return;
    }

    const current = STEPS[step];
    time += dt;
    const v = sample(current.kind, current.side);
    if (v !== null) samples.push(v);

    label.textContent = `${current.text}  (${step + 1}/${STEPS.length})`;
    label.style.display = 'block';

    if (time >= STEP_TIME) {
      const ok = finish(current.kind);
      if (!ok) {
        step = -1;
        return;
      }
      step++;
      time = 0;
      samples = [];
      if (step >= STEPS.length) {
        step = -1;
        try {
          localStorage.setItem(KEY, JSON.stringify(tuning));
        } catch (e) {
          // Not saved, but the values still apply for this visit
        }
        say('Calibrated. Your gestures now use your own measurements.', 4);
        sfx.play('conjure');
      }
    }
  }

  return { start, update, get active() { return step >= 0; }, get step() { return step; } };
}
