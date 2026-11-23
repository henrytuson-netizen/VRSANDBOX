// ---------------------------------------------------------------------------
// Sound: everything is synthesised in the browser, so there are no audio files.
// The audio context starts on the first click or key press, because browsers
// won't play sound before the user has interacted with the page.
// ---------------------------------------------------------------------------

const MAX_VOICES = 24;      // sounds playing at once
const MIN_GAP = 0.03;       // s between two of the same sound

export function createSound() {
  let ctx = null;
  let master = null;
  let noiseBuffer = null;
  let voices = 0;
  const lastPlayed = {};

  function ensure() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.35;
      master.connect(ctx.destination);
      // A second of white noise, reused by every noisy sound
      noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const data = noiseBuffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    }
    if (ctx.state === 'suspended') ctx.resume();
    return true;
  }
  document.addEventListener('pointerdown', ensure);
  window.addEventListener('keydown', ensure);

  // Tone with a pitch sweep and an amplitude envelope
  function tone({ type = 'sine', from, to = from, dur = 0.2, gain = 0.3, when = 0 }) {
    const t = ctx.currentTime + when;
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + dur);
    amp.gain.setValueAtTime(0.0001, t);
    amp.gain.exponentialRampToValueAtTime(gain, t + 0.01);
    amp.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(amp).connect(master);
    osc.start(t);
    osc.stop(t + dur + 0.02);
    voices++;
    osc.onended = () => { voices--; };
  }

  // Filtered noise burst
  function noise({ dur = 0.15, gain = 0.2, filter = 'bandpass', freq = 1200, freqEnd, Q = 1, when = 0 }) {
    const t = ctx.currentTime + when;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    const f = ctx.createBiquadFilter();
    f.type = filter;
    f.frequency.setValueAtTime(freq, t);
    if (freqEnd) f.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
    f.Q.value = Q;
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(gain, t);
    amp.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(amp).connect(master);
    src.start(t, Math.random() * 0.5, dur + 0.05);
    src.stop(t + dur + 0.05);
    voices++;
    src.onended = () => { voices--; };
  }

  const sounds = {
    // Spider
    webShot: () => {
      tone({ type: 'square', from: 900, to: 2400, dur: 0.12, gain: 0.12 });
      noise({ dur: 0.12, gain: 0.2, filter: 'highpass', freq: 2000 });
    },
    webAttach: () => noise({ dur: 0.08, gain: 0.25, filter: 'highpass', freq: 1800 }),
    zip: () => tone({ type: 'sawtooth', from: 180, to: 520, dur: 0.25, gain: 0.08 }),
    trapThrow: () => noise({ dur: 0.2, gain: 0.2, filter: 'bandpass', freq: 600, freqEnd: 200 }),
    crawl: () => noise({ dur: 0.1, gain: 0.12, filter: 'lowpass', freq: 500 }),

    // Combat
    bulletFire: () => tone({ type: 'sine', from: 1200, to: 400, dur: 0.08, gain: 0.15 }),
    bulletWhiz: () => noise({ dur: 0.12, gain: 0.12, filter: 'bandpass', freq: 1500, freqEnd: 800 }),
    hitPlayer: () => {
      tone({ type: 'sine', from: 140, to: 60, dur: 0.18, gain: 0.35 });
      noise({ dur: 0.1, gain: 0.25, filter: 'lowpass', freq: 900 });
    },
    enemyHurt: () => tone({ type: 'square', from: 320, to: 200, dur: 0.1, gain: 0.12 }),
    enemyDown: () => {
      tone({ type: 'sawtooth', from: 420, to: 70, dur: 0.5, gain: 0.12 });
      noise({ dur: 0.3, gain: 0.15, filter: 'lowpass', freq: 700 });
    },
    spawn: () => tone({ type: 'sine', from: 280, to: 900, dur: 0.3, gain: 0.12 }),

    // Physics: a thud whose loudness follows the impact speed
    impact: (speed = 3) => {
      const g = Math.min(0.4, 0.04 * speed);
      tone({ type: 'sine', from: 180 - Math.min(90, speed * 5), to: 70, dur: 0.12, gain: g });
      noise({ dur: 0.05, gain: g * 0.6, filter: 'lowpass', freq: 1200 });
    },

    // Acrobatics
    jump: () => {
      tone({ type: 'sine', from: 200, to: 520, dur: 0.2, gain: 0.12 });
      noise({ dur: 0.18, gain: 0.12, filter: 'highpass', freq: 1500 });
    },

    // Magic and menus
    menu: () => tone({ type: 'sine', from: 760, dur: 0.05, gain: 0.1 }),
    conjure: () => {
      tone({ type: 'sine', from: 600, to: 1400, dur: 0.3, gain: 0.12 });
      noise({ dur: 0.25, gain: 0.08, filter: 'highpass', freq: 3000 });
    },
    timeWarp: () => tone({ type: 'sine', from: 320, to: 80, dur: 0.6, gain: 0.15 }),
    rewind: () => noise({ dur: 0.8, gain: 0.2, filter: 'bandpass', freq: 4000, freqEnd: 300, Q: 2 }),
  };

  // Play by name, with a per-sound gap and a cap on how many sounds overlap
  function play(name, arg) {
    if (!ctx || !sounds[name]) return;
    const now = ctx.currentTime;
    if (lastPlayed[name] !== undefined && now - lastPlayed[name] < MIN_GAP) return;
    if (voices >= MAX_VOICES) return;
    lastPlayed[name] = now;
    sounds[name](arg);
  }

  return { play, ensure };
}
