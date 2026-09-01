/**
 * Builds the puzzle settings panel, shared by the solo setup screen and the
 * multiplayer lobby.
 *
 * Rows come in two flavours:
 *   - "puzzle" rows define the board itself and must match for everyone, so in
 *     a lobby only the host may edit them.
 *   - "control" rows are personal input preferences and stay editable always.
 */

import {
  config,
  prefs,
  saveConfig,
  savePrefs,
  normalizeHex,
  PALETTES,
  CUSTOM_PALETTE,
  SIZES,
  TILE_STYLES,
} from './settings.js';
import { sfx } from './audio.js';

function makeRow(title, subtitle, group) {
  const row = document.createElement('div');
  row.className = 'cfg-row';
  row.dataset.group = group;

  const label = document.createElement('div');
  label.className = 'cfg-label';
  const strong = document.createElement('span');
  strong.textContent = title;
  const sub = document.createElement('span');
  sub.className = 'cfg-sub';
  sub.textContent = subtitle;
  label.append(strong, sub);

  const control = document.createElement('div');
  control.className = 'cfg-control';

  row.append(label, control);
  return { row, control };
}

function makeSegmented(options, getValue, setValue) {
  const wrap = document.createElement('div');
  wrap.className = 'seg';

  const paint = () => {
    const current = getValue();
    for (const button of wrap.children) {
      button.classList.toggle('on', button.dataset.value === String(current));
    }
  };

  for (const [value, text] of options) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.value = String(value);
    button.textContent = text;
    button.addEventListener('click', () => {
      setValue(value);
      paint();
      sfx.click();
    });
    wrap.appendChild(button);
  }

  paint();
  return { el: wrap, refresh: paint };
}

function makeSwitch(getValue, setValue) {
  const label = document.createElement('label');
  label.className = 'switch';

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = !!getValue();

  const track = document.createElement('span');
  track.className = 'track';
  const thumb = document.createElement('span');
  thumb.className = 'thumb';

  input.addEventListener('change', () => {
    setValue(input.checked);
    sfx.toggle(input.checked);
  });

  label.append(input, track, thumb);
  return { el: label, refresh: () => { input.checked = !!getValue(); } };
}

/**
 * Preset gradient swatches plus a custom option driven by two colour pickers.
 *
 * @param {() => string} getValue        current palette key
 * @param {(key: string) => void} setValue
 * @param {() => void} commit            called once an edit is settled, so the
 *                                       host only broadcasts on release rather
 *                                       than on every frame of a colour drag
 */
function makeSwatches(getValue, setValue, commit) {
  const wrap = document.createElement('div');
  wrap.className = 'swatches';

  const buttons = [];
  const customButton = document.createElement('button');
  const inputA = document.createElement('input');
  const inputB = document.createElement('input');

  const paint = () => {
    const current = getValue();
    for (const button of buttons) button.classList.toggle('on', button.dataset.value === current);
    customButton.classList.toggle('on', current === CUSTOM_PALETTE);
    const a = normalizeHex(config.customA) || '#f472b6';
    const b = normalizeHex(config.customB) || '#38bdf8';
    customButton.style.background = `linear-gradient(150deg, ${a}, ${b})`;
    inputA.value = a;
    inputB.value = b;
  };

  for (const [key, palette] of Object.entries(PALETTES)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'swatch';
    button.dataset.value = key;
    button.title = palette.name;
    button.setAttribute('aria-label', palette.name);
    button.style.background = `linear-gradient(150deg, ${palette.a}, ${palette.b})`;
    button.addEventListener('click', () => {
      setValue(key);
      paint();
      commit();
      sfx.click();
    });
    buttons.push(button);
    wrap.appendChild(button);
  }

  customButton.type = 'button';
  customButton.className = 'swatch custom-swatch';
  customButton.dataset.value = CUSTOM_PALETTE;
  customButton.title = 'Your own two colours';
  customButton.setAttribute('aria-label', 'Custom colours');
  customButton.addEventListener('click', () => {
    setValue(CUSTOM_PALETTE);
    paint();
    commit();
    sfx.click();
  });
  wrap.appendChild(customButton);

  const pair = document.createElement('div');
  pair.className = 'custom-pair';

  for (const [input, key, label] of [
    [inputA, 'customA', 'First custom colour'],
    [inputB, 'customB', 'Second custom colour'],
  ]) {
    input.type = 'color';
    input.className = 'color-input';
    input.title = label;
    input.setAttribute('aria-label', label);

    // `input` fires continuously while dragging: update locally only.
    input.addEventListener('input', () => {
      config[key] = normalizeHex(input.value) || config[key];
      setValue(CUSTOM_PALETTE);
      saveConfig();
      paint();
    });
    // `change` fires once the value settles: safe to broadcast from here.
    input.addEventListener('change', () => {
      config[key] = normalizeHex(input.value) || config[key];
      setValue(CUSTOM_PALETTE);
      paint();
      commit();
      sfx.click();
    });

    pair.appendChild(input);
  }

  const group = document.createElement('div');
  group.className = 'swatch-group';
  group.append(wrap, pair);

  paint();
  return { el: group, refresh: paint };
}

/**
 * Renders the settings panel into `container`.
 *
 * @param {HTMLElement} container
 * @param {(kind: 'puzzle'|'control') => void} onChange  fired after any edit
 * @returns {{refresh: Function, setEditable: (canEditPuzzle: boolean) => void}}
 */
export function buildConfigUI(container, onChange = () => {}) {
  container.textContent = '';
  const refreshers = [];
  const puzzleRows = [];

  const add = (title, subtitle, group, control) => {
    const { row, control: slot } = makeRow(title, subtitle, group);
    slot.appendChild(control.el);
    container.appendChild(row);
    if (control.refresh) refreshers.push(control.refresh);
    if (group === 'puzzle') puzzleRows.push(row);
    return row;
  };

  /* ------------------------------------------------------ puzzle settings */

  add(
    'Board size',
    'Bigger boards take a lot longer.',
    'puzzle',
    makeSegmented(
      SIZES.map((n) => [n, `${n}×${n}`]),
      () => config.size,
      (value) => {
        config.size = value;
        saveConfig();
        onChange('puzzle');
      }
    )
  );

  const styleControl = makeSegmented(
    Object.entries(TILE_STYLES),
    () => config.tileStyle,
    (value) => {
      config.tileStyle = value;
      saveConfig();
      updateDependants();
      onChange('puzzle');
    }
  );
  add('Tile style', 'Numbers are the classic; photos are harder.', 'puzzle', styleControl);

  const paletteRow = add(
    'Tile colour',
    'Presets, or pick two colours of your own to fade between.',
    'puzzle',
    makeSwatches(
      () => config.palette,
      (value) => {
        config.palette = value;
      },
      () => {
        saveConfig();
        onChange('puzzle');
      }
    )
  );

  /* ----------------------------------------------------- control settings */

  const numbersRow = add(
    'Numbers on photos',
    'Overlay tile numbers on picture puzzles.',
    'control',
    makeSwitch(
      () => prefs.showNumbersOnPhoto,
      (value) => {
        prefs.showNumbersOnPhoto = value;
        savePrefs();
        onChange('control');
      }
    )
  );

  add(
    'Move on hover',
    'Slide tiles by sweeping the pointer — no clicking.',
    'control',
    makeSwitch(
      () => prefs.hoverMove,
      (value) => {
        prefs.hoverMove = value;
        savePrefs();
        onChange('control');
      }
    )
  );

  add(
    'Push whole rows',
    'Clicking past the gap slides every tile in between.',
    'control',
    makeSwitch(
      () => prefs.multiSlide,
      (value) => {
        prefs.multiSlide = value;
        savePrefs();
        onChange('control');
      }
    )
  );

  add(
    'Slide animation',
    'Off means tiles snap instantly — fastest for racing.',
    'control',
    makeSwitch(
      () => prefs.animate,
      (value) => {
        prefs.animate = value;
        savePrefs();
        onChange('control');
      }
    )
  );

  add(
    'Highlight solved tiles',
    'Outlines tiles that are already home.',
    'control',
    makeSwitch(
      () => prefs.highlightSettled,
      (value) => {
        prefs.highlightSettled = value;
        savePrefs();
        onChange('control');
      }
    )
  );

  /** Colour is irrelevant to photo tiles; the numbers toggle only is not. */
  function updateDependants() {
    paletteRow.classList.toggle('cfg-disabled', config.tileStyle === 'photo');
    numbersRow.classList.toggle('cfg-disabled', config.tileStyle !== 'photo');
  }

  const refresh = () => {
    refreshers.forEach((fn) => fn());
    updateDependants();
  };

  updateDependants();

  return {
    refresh,
    setEditable(canEditPuzzle) {
      puzzleRows.forEach((row) => row.classList.toggle('cfg-disabled', !canEditPuzzle));
      if (canEditPuzzle) updateDependants();
    },
  };
}
