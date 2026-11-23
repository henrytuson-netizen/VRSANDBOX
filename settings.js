// ---------------------------------------------------------------------------
// Comfort settings, saved in this browser.
//   bulletTime : Spider-Sense slows the world when something is coming at you
//   redTint    : the red edge tint during bullet time
//   vignette   : a dark comfort vignette when you move fast (swinging, flying)
//   snapTurn   : turn in 30-degree steps instead of smoothly
// ---------------------------------------------------------------------------

const KEY = 'sandboxSettings';

export const DEFAULT_SETTINGS = {
  bulletTime: true,
  redTint: true,
  vignette: false,
  snapTurn: false,
};

// Comfort mode turns off the things most likely to make people feel sick
export const COMFORT_PRESET = {
  bulletTime: false,
  redTint: false,
  vignette: true,
  snapTurn: true,
};

export function loadSettings() {
  const settings = { ...DEFAULT_SETTINGS };
  try {
    Object.assign(settings, JSON.parse(localStorage.getItem(KEY) || '{}'));
  } catch (e) {
    // Storage can be blocked; the defaults still apply
  }
  return settings;
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch (e) {
    // Not saved, but the settings still apply for this visit
  }
}

// True when every comfort setting matches the preset
export function isComfortMode(settings) {
  return Object.keys(COMFORT_PRESET).every((k) => settings[k] === COMFORT_PRESET[k]);
}
