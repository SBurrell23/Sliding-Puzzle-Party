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

/** Palette key meaning "use the player's own two colours". */
export const CUSTOM_PALETTE = 'custom';

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
  // Starting point for the custom gradient, used until the player picks their own.
  customA: '#f472b6',
  customB: '#38bdf8',
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

/* ------------------------------------------------------- custom palette */

/** Accepts `#rgb` / `#rrggbb` and returns a normalised `#rrggbb`, or null. */
export function normalizeHex(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(text);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase();
  return /^#[0-9a-f]{6}$/i.test(text) ? text.toLowerCase() : null;
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
function luminance(hex) {
  const channels = [1, 3, 5].map((offset) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

/**
 * Picks tile-number ink that stays readable on an `a`→`b` gradient. The digit
 * sits in the middle of the tile, so the midpoint of the two colours is what
 * has to be contrasted against.
 */
export function inkFor(a, b) {
  return (luminance(a) + luminance(b)) / 2 > 0.4 ? '#0a0f18' : '#f7faff';
}

/** The {name, a, b, ink} actually in force, resolving the custom option. */
export function activePalette(source = config) {
  if (source.palette === CUSTOM_PALETTE) {
    const a = normalizeHex(source.customA) || DEFAULT_CONFIG.customA;
    const b = normalizeHex(source.customB) || DEFAULT_CONFIG.customB;
    return { name: 'Custom', a, b, ink: inkFor(a, b) };
  }
  return PALETTES[source.palette] || PALETTES[DEFAULT_CONFIG.palette];
}

/* ------------------------------------------------------------------ wire */

/** Replace the local config with one received from the host. */
export function adoptConfig(incoming) {
  config.size = SIZES.includes(incoming.size) ? incoming.size : DEFAULT_CONFIG.size;
  config.tileStyle = TILE_STYLES[incoming.tileStyle] ? incoming.tileStyle : DEFAULT_CONFIG.tileStyle;

  const custom = incoming.palette === CUSTOM_PALETTE;
  config.palette = custom || PALETTES[incoming.palette] ? incoming.palette : DEFAULT_CONFIG.palette;
  config.customA = normalizeHex(incoming.customA) || config.customA || DEFAULT_CONFIG.customA;
  config.customB = normalizeHex(incoming.customB) || config.customB || DEFAULT_CONFIG.customB;
}

/** The subset of config that is meaningful to send over the wire. */
export function shareableConfig() {
  return {
    size: config.size,
    tileStyle: config.tileStyle,
    palette: config.palette,
    customA: config.customA,
    customB: config.customB,
  };
}

/* ------------------------------------------------------- lifetime stats */

/**
 * Career stats, kept per (size, tile style) bucket plus running totals.
 *
 * Buckets matter because a "fastest ever" pooled across board sizes would
 * always just be your quickest 3×3. Totals are accumulated as sums rather than
 * stored averages, so the averages stay exact however many puzzles are added.
 *
 * This lives in localStorage, which is per-browser and can be cleared by the
 * player or the browser itself. It is a scoreboard, not a safe.
 */
const STATS_KEY = 'spp.stats.v1';

function emptyStats() {
  return {
    v: 1,
    totals: { completed: 0, raceCompleted: 0, timeMs: 0, moves: 0 },
    buckets: {},
    firstAt: null,
  };
}

/**
 * Earlier builds only stored a best time per bucket. Fold whatever is there
 * into the new shape so nobody's records disappear; each legacy entry counts
 * as the single completion we can actually prove happened.
 */
function migrateLegacyBests() {
  const legacy = readJSON(BEST_KEY, null);
  if (!legacy || typeof legacy !== 'object') return null;

  const stats = emptyStats();
  let found = false;
  for (const [key, entry] of Object.entries(legacy)) {
    if (!entry || typeof entry.ms !== 'number') continue;
    const moves = typeof entry.moves === 'number' ? entry.moves : 0;
    stats.buckets[key] = {
      completed: 1,
      bestMs: entry.ms,
      bestMoves: moves || null,
      timeMs: entry.ms,
      moves,
      lastAt: entry.at || null,
    };
    stats.totals.completed += 1;
    stats.totals.timeMs += entry.ms;
    stats.totals.moves += moves;
    stats.firstAt = stats.firstAt || entry.at || null;
    found = true;
  }
  return found ? stats : null;
}

function loadStats() {
  let stored = null;
  try {
    const raw = localStorage.getItem(STATS_KEY);
    stored = raw ? JSON.parse(raw) : null;
  } catch {
    stored = null;
  }
  if (!stored || stored.v !== 1) stored = migrateLegacyBests() || emptyStats();

  // Tolerate a partially written or hand-edited store.
  stored.totals = { completed: 0, raceCompleted: 0, timeMs: 0, moves: 0, ...(stored.totals || {}) };
  stored.buckets = stored.buckets && typeof stored.buckets === 'object' ? stored.buckets : {};
  return stored;
}

let stats = loadStats();

/** Write a freshly migrated store straight away, so the legacy key is read once. */
function persistMigration() {
  try {
    if (!localStorage.getItem(STATS_KEY) && stats.totals.completed > 0) saveStats();
  } catch {
    /* ignore */
  }
}

function saveStats() {
  try {
    localStorage.setItem(STATS_KEY, JSON.stringify(stats));
  } catch {
    /* private browsing or a full quota — stats simply won't persist */
  }
}

persistMigration();

const bucketKey = (size, tileStyle) => `${size}:${tileStyle}`;

/** Personal best time (ms) for a given size + tile style, or null. */
export function getBest(size, tileStyle) {
  return stats.buckets[bucketKey(size, tileStyle)]?.bestMs ?? null;
}

/**
 * Records one completed puzzle against the lifetime stats.
 *
 * @param {object} completion
 * @param {number} completion.size
 * @param {string} completion.tileStyle
 * @param {number} completion.ms
 * @param {number} completion.moves
 * @param {'solo'|'race'} [completion.mode]
 * @returns {{bestTime: boolean, bestMoves: boolean}} which records were broken
 */
export function recordCompletion({ size, tileStyle, ms, moves, mode = 'solo' }) {
  const key = bucketKey(size, tileStyle);
  const bucket =
    stats.buckets[key] ||
    (stats.buckets[key] = { completed: 0, bestMs: null, bestMoves: null, timeMs: 0, moves: 0, lastAt: null });

  const bestTime = bucket.bestMs == null || ms < bucket.bestMs;
  const bestMoves = bucket.bestMoves == null || moves < bucket.bestMoves;

  bucket.completed += 1;
  bucket.timeMs += ms;
  bucket.moves += moves;
  if (bestTime) bucket.bestMs = ms;
  if (bestMoves) bucket.bestMoves = moves;
  bucket.lastAt = Date.now();

  stats.totals.completed += 1;
  if (mode === 'race') stats.totals.raceCompleted += 1;
  stats.totals.timeMs += ms;
  stats.totals.moves += moves;
  stats.firstAt = stats.firstAt || Date.now();

  saveStats();
  return { bestTime, bestMoves };
}

/** Headline numbers plus a per-puzzle breakdown, ready for display. */
export function statsSummary() {
  const { completed, raceCompleted, timeMs, moves } = stats.totals;

  const rows = Object.entries(stats.buckets)
    .filter(([, bucket]) => bucket.completed > 0)
    .map(([key, bucket]) => {
      const [size, tileStyle] = key.split(':');
      return {
        size: Number(size),
        tileStyle,
        completed: bucket.completed,
        bestMs: bucket.bestMs,
        bestMoves: bucket.bestMoves,
        averageMs: bucket.timeMs / bucket.completed,
        averageMoves: bucket.moves / bucket.completed,
      };
    })
    .sort((a, b) => a.size - b.size || a.tileStyle.localeCompare(b.tileStyle));

  const pickLowest = (field) =>
    rows.reduce((best, row) => {
      if (row[field] == null) return best;
      return !best || row[field] < best[field] ? row : best;
    }, null);

  return {
    completed,
    raceCompleted,
    totalTimeMs: timeMs,
    averageMs: completed ? timeMs / completed : null,
    averageMoves: completed ? moves / completed : null,
    fastest: pickLowest('bestMs'),
    fewestMoves: pickLowest('bestMoves'),
    firstAt: stats.firstAt,
    rows,
  };
}

/** Wipes every lifetime stat. */
export function resetStats() {
  stats = emptyStats();
  saveStats();
  try {
    localStorage.removeItem(BEST_KEY);
  } catch {
    /* ignore */
  }
}
