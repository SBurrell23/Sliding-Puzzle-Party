/**
 * Audio: a looping MP3 soundtrack plus fully synthesised sound effects.
 *
 * Every effect is generated with the Web Audio API at call time — there are no
 * effect files to download, and a tile click costs a couple of oscillator nodes.
 * Browsers block audio until the first gesture, so `unlock()` is wired to the
 * first pointer/key event and both the AudioContext and the music start there.
 */

import { prefs, savePrefs } from './settings.js';

let ctx = null;
let fxBus = null;
let unlocked = false;
let musicEl = null;
let musicWanted = false;

function ensureContext() {
  if (ctx) return ctx;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  ctx = new Ctor();
  fxBus = ctx.createGain();
  fxBus.gain.value = effectiveFxVolume();
  fxBus.connect(ctx.destination);
  return ctx;
}

function effectiveFxVolume() {
  return prefs.fxMuted ? 0 : prefs.fxVolume;
}

function effectiveMusicVolume() {
  return prefs.musicMuted ? 0 : prefs.musicVolume;
}

export function attachMusicElement(el) {
  musicEl = el;
  musicEl.volume = effectiveMusicVolume();
  // If the file is missing or blocked we simply carry on without music.
  musicEl.addEventListener('error', () => console.warn('Soundtrack unavailable.'));
}

/** Called from the first real user gesture. Safe to call repeatedly. */
export function unlock() {
  ensureContext();
  if (ctx && ctx.state === 'suspended') ctx.resume();
  unlocked = true;
  if (musicWanted) playMusic();
}

export function isUnlocked() {
  return unlocked;
}

/* ------------------------------------------------------------------ music */

export function playMusic() {
  musicWanted = true;
  if (!musicEl || !unlocked) return;
  musicEl.volume = effectiveMusicVolume();
  if (musicEl.paused) {
    musicEl.play().catch(() => {
      /* still blocked; the next gesture will retry */
    });
  }
}

export function stopMusic() {
  musicWanted = false;
  if (musicEl && !musicEl.paused) musicEl.pause();
}

export function setMusicVolume(value) {
  prefs.musicVolume = Math.min(1, Math.max(0, value));
  if (musicEl) musicEl.volume = effectiveMusicVolume();
  savePrefs();
}

export function setMusicMuted(muted) {
  prefs.musicMuted = !!muted;
  if (musicEl) musicEl.volume = effectiveMusicVolume();
  savePrefs();
}

export function setFxVolume(value) {
  prefs.fxVolume = Math.min(1, Math.max(0, value));
  if (fxBus) fxBus.gain.value = effectiveFxVolume();
  savePrefs();
}

export function setFxMuted(muted) {
  prefs.fxMuted = !!muted;
  if (fxBus) fxBus.gain.value = effectiveFxVolume();
  savePrefs();
}

/* ------------------------------------------------------------------ synth */

/**
 * One shaped oscillator voice.
 * @param {object} o
 * @param {number} o.freq      starting frequency in Hz
 * @param {number} [o.to]      frequency to glide to
 * @param {number} [o.dur]     length in seconds
 * @param {string} [o.type]    oscillator waveform
 * @param {number} [o.gain]    peak gain
 * @param {number} [o.delay]   seconds to wait before starting
 * @param {number} [o.attack]  attack time in seconds
 */
function voice({ freq, to, dur = 0.12, type = 'square', gain = 0.3, delay = 0, attack = 0.004 }) {
  if (!ensureContext() || effectiveFxVolume() <= 0) return;
  const t0 = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const env = ctx.createGain();

  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (to && to !== freq) osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t0 + dur);

  env.gain.setValueAtTime(0.0001, t0);
  env.gain.exponentialRampToValueAtTime(gain, t0 + attack);
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

  osc.connect(env);
  env.connect(fxBus);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

/** Filtered white noise — used for thuds and the confetti-ish finish. */
function noise({ dur = 0.16, gain = 0.22, delay = 0, freq = 900, q = 1, type = 'lowpass' }) {
  if (!ensureContext() || effectiveFxVolume() <= 0) return;
  const t0 = ctx.currentTime + delay;
  const frames = Math.max(1, Math.floor(ctx.sampleRate * dur));
  const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;

  const src = ctx.createBufferSource();
  src.buffer = buffer;

  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = freq;
  filter.Q.value = q;

  const env = ctx.createGain();
  env.gain.setValueAtTime(gain, t0);
  env.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

  src.connect(filter);
  filter.connect(env);
  env.connect(fxBus);
  src.start(t0);
  src.stop(t0 + dur + 0.02);
}

/**
 * Sound effects. Kept short and dry so rapid-fire sliding never turns to mush.
 */
export const sfx = {
  /** Tile slide. Pitch rises slightly with a longer multi-tile push. */
  move(count = 1) {
    const base = 460 + Math.min(count - 1, 4) * 55;
    voice({ freq: base, to: base * 1.5, dur: 0.045, type: 'triangle', gain: 0.22 });
    noise({ dur: 0.035, gain: 0.06, freq: 2600, type: 'highpass' });
  },

  /** Tile landed in its home position. */
  settle() {
    voice({ freq: 880, to: 1320, dur: 0.07, type: 'sine', gain: 0.16 });
  },

  /** Attempted a tile that cannot move. */
  blocked() {
    voice({ freq: 150, to: 96, dur: 0.09, type: 'sawtooth', gain: 0.14 });
  },

  click() {
    voice({ freq: 620, to: 780, dur: 0.05, type: 'square', gain: 0.15 });
  },

  toggle(on) {
    voice({ freq: on ? 620 : 460, to: on ? 900 : 340, dur: 0.07, type: 'square', gain: 0.16 });
  },

  /** Countdown tick (3, 2, 1) then the higher "GO". */
  tick(final = false) {
    if (final) {
      voice({ freq: 880, dur: 0.28, type: 'square', gain: 0.3 });
      voice({ freq: 1320, dur: 0.3, type: 'triangle', gain: 0.2, delay: 0.02 });
    } else {
      voice({ freq: 440, dur: 0.14, type: 'square', gain: 0.24 });
    }
  },

  /** Local player solved the puzzle. */
  win() {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) =>
      voice({ freq: f, dur: 0.34, type: 'square', gain: 0.22, delay: i * 0.085 })
    );
    voice({ freq: 1568, dur: 0.5, type: 'triangle', gain: 0.18, delay: 0.34 });
    noise({ dur: 0.5, gain: 0.09, freq: 5200, type: 'highpass', delay: 0.34 });
  },

  /** Someone else crossed the line. */
  rivalFinish() {
    voice({ freq: 740, to: 990, dur: 0.16, type: 'triangle', gain: 0.17 });
    voice({ freq: 990, to: 1240, dur: 0.16, type: 'triangle', gain: 0.13, delay: 0.1 });
  },

  join() {
    voice({ freq: 520, to: 790, dur: 0.13, type: 'sine', gain: 0.2 });
  },

  leave() {
    voice({ freq: 520, to: 300, dur: 0.16, type: 'sine', gain: 0.18 });
  },

  /** Race is starting / room created. */
  fanfare() {
    [392, 523.25, 659.25].forEach((f, i) =>
      voice({ freq: f, dur: 0.24, type: 'square', gain: 0.2, delay: i * 0.07 })
    );
  },

  error() {
    voice({ freq: 240, to: 120, dur: 0.24, type: 'sawtooth', gain: 0.2 });
  },
};

/** Plays a short medley so the volume slider can be judged by ear. */
export function previewEffects() {
  sfx.move(1);
  setTimeout(() => sfx.move(3), 110);
  setTimeout(() => sfx.settle(), 230);
  setTimeout(() => sfx.rivalFinish(), 350);
}
