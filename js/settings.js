/**
 * Persistent user preferences and puzzle configuration.
 *
 * Two separate concerns live here:
 *   - `prefs`  : per-device preferences (name, volumes, control style). Never
 *                travels over the network.
 *   - `config` : the puzzle definition (size, tiles, colour). In multiplayer the
 *                host's config is broadcast so everyone races the same puzzle.
 */

const PREFS_KEY = 'spp.prefs.v1';
const BEST_KEY = 'spp.best.v1';

export const TILE_STYLES = {
  numbers: 'Numbers',
  photo: 'Wildlife photo',
  color: 'Colour blocks',
};

export const PALETTES = {
  aqua: { name: 'Aqua', a: '#2dd4bf', b: '#3b82f6', ink: '#04121a' },
  violet: { name: 'Violet', a: '#c084fc', b: '#6366f1', ink: '#140326' },
  sunset: { name: 'Sunset', a: '#fbbf24', b: '#f43f5e', ink: '#2a0a06' },
  lime: { name: 'Lime', a: '#a3e635', b: '#10b981', ink: '#08210d' },
  candy: { name: 'Candy', a: '#f472b6', b: '#a78bfa', ink: '#2b0620' },
  slate: { name: 'Slate', a: '#cbd5e1', b: '#64748b', ink: '#0b1220' },
  ember: { name: 'Ember', a: '#fb923c', b: '#b91c1c', ink: '#280802' },
  ice: { name: 'Ice', a: '#e0f2fe', b: '#38bdf8', ink: '#04202e' },
};

export const SIZES = [3, 4, 5, 6, 7, 8];

const DEFAULT_PREFS = {
  name: '',
  musicVolume: 0.4,
  fxVolume: 0.7,
  musicMuted: false,
  fxMuted: false,
  hoverMove: false, // opt-in: hovering a tile slides it
  multiSlide: true, // clicking further down a row pushes the whole run
  animate: false, // instant by default — this is a race
  showNumbersOnPhoto: true,
  highlightSettled: true,
};

const DEFAULT_CONFIG = {
  size: 4,
  tileStyle: 'numbers',
  palette: 'aqua',
};

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return { ...fallback };
    return { ...fallback, ...JSON.parse(raw) };
  } catch {
    return { ...fallback };
  }
}

export const prefs = readJSON(PREFS_KEY, DEFAULT_PREFS);
export const config = readJSON('spp.config.v1', DEFAULT_CONFIG);

export function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* private browsing — preferences simply won't persist */
  }
}

export function saveConfig() {
  try {
    localStorage.setItem('spp.config.v1', JSON.stringify(config));
  } catch {
    /* ignore */
  }
}

/** Replace the local config with one received from the host. */
export function adoptConfig(incoming) {
  config.size = SIZES.includes(incoming.size) ? incoming.size : DEFAULT_CONFIG.size;
  config.tileStyle = TILE_STYLES[incoming.tileStyle] ? incoming.tileStyle : DEFAULT_CONFIG.tileStyle;
  config.palette = PALETTES[incoming.palette] ? incoming.palette : DEFAULT_CONFIG.palette;
}

/** The subset of config that is meaningful to send over the wire. */
export function shareableConfig() {
  return { size: config.size, tileStyle: config.tileStyle, palette: config.palette };
}

/* ------------------------------------------------------------------ bests */

const bests = readJSON(BEST_KEY, {});

/** Personal best time (ms) for a given size + tile style, or null. */
export function getBest(size, tileStyle) {
  const entry = bests[`${size}:${tileStyle}`];
  return entry?.ms ?? null;
}

/** Records a finish; returns true when it beat the previous best. */
export function recordBest(size, tileStyle, ms, moves) {
  const key = `${size}:${tileStyle}`;
  const previous = bests[key];
  if (previous && previous.ms <= ms) return false;
  bests[key] = { ms, moves, at: Date.now() };
  try {
    localStorage.setItem(BEST_KEY, JSON.stringify(bests));
  } catch {
    /* ignore */
  }
  return true;
}
