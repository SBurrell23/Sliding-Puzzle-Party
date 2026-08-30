/**
 * Sliding puzzle model + DOM renderer.
 *
 * Model notes
 *   `tiles[position] = tileId`. The blank is the highest id (size*size - 1) so a
 *   solved board is simply `tiles[i] === i`. Tile id `n` displays the number
 *   `n + 1` and its picture crop comes from its home row/column.
 *
 * Renderer notes
 *   One element per tile id, created once. A move only rewrites the `--c`/`--r`
 *   custom properties of the tiles that actually moved, so a click is a handful
 *   of style writes — no layout thrash, no transitions, no animation frames.
 *   Hit testing is done arithmetically from the board rect rather than with
 *   per-tile listeners, which keeps input latency flat as the board grows.
 */

const ENCODE_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_';

/** Small, fast, seedable PRNG so every player scrambles to the same board. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomSeed() {
  return (Math.random() * 0xffffffff) >>> 0;
}

export class Puzzle {
  /**
   * @param {number} size  board is size x size
   * @param {number} seed  scramble seed; identical seeds give identical boards
   */
  constructor(size, seed) {
    this.size = size;
    this.seed = seed >>> 0;
    this.blankId = size * size - 1;
    this.tiles = new Array(size * size);
    this.blank = 0;
    this.moves = 0;
    this.reset();
  }

  /** Returns to the scrambled starting position for this seed. */
  reset() {
    const total = this.size * this.size;
    for (let i = 0; i < total; i++) this.tiles[i] = i;
    this.blank = total - 1;
    this.moves = 0;
    this.#scramble();
  }

  /**
   * Scrambles by walking the blank randomly. Because every step is a legal
   * move, the result is always solvable — no parity repair needed.
   */
  #scramble() {
    const n = this.size;
    const random = mulberry32(this.seed);
    const steps = Math.max(240, n * n * 30);
    let previous = -1;

    for (let step = 0; step < steps; step++) {
      const options = this.#neighbours(this.blank);
      const choices = options.length > 1 ? options.filter((p) => p !== previous) : options;
      const target = choices[Math.floor(random() * choices.length) % choices.length];
      previous = this.blank;
      this.tiles[this.blank] = this.tiles[target];
      this.tiles[target] = this.blankId;
      this.blank = target;
    }

    // A scramble that lands back on solved would be an anticlimax.
    if (this.isSolved()) {
      const target = this.#neighbours(this.blank)[0];
      this.tiles[this.blank] = this.tiles[target];
      this.tiles[target] = this.blankId;
      this.blank = target;
    }
    this.moves = 0;
  }

  #neighbours(index) {
    const n = this.size;
    const row = (index / n) | 0;
    const col = index % n;
    const out = [];
    if (row > 0) out.push(index - n);
    if (row < n - 1) out.push(index + n);
    if (col > 0) out.push(index - 1);
    if (col < n - 1) out.push(index + 1);
    return out;
  }

  /**
   * Slides the tile at `index` into the blank, pushing any tiles between them
   * when `multiSlide` is on.
   *
   * @returns {number[]|null} positions that received a tile, or null if illegal
   */
  move(index, multiSlide = true) {
    const n = this.size;
    if (index < 0 || index >= n * n || index === this.blank) return null;

    const row = (index / n) | 0;
    const col = index % n;
    const blankRow = (this.blank / n) | 0;
    const blankCol = this.blank % n;
    if (row !== blankRow && col !== blankCol) return null;

    const distance = Math.abs(row - blankRow) + Math.abs(col - blankCol);
    if (!multiSlide && distance !== 1) return null;

    const stepRow = Math.sign(row - blankRow);
    const stepCol = Math.sign(col - blankCol);
    const step = stepRow * n + stepCol;

    const changed = [];
    let cursor = this.blank;
    while (cursor !== index) {
      const next = cursor + step;
      this.tiles[cursor] = this.tiles[next];
      changed.push(cursor);
      cursor = next;
    }
    this.tiles[cursor] = this.blankId;
    this.blank = cursor;
    this.moves += 1;
    return changed;
  }

  /** True when the tile at `index` can move right now. */
  canMove(index, multiSlide = true) {
    const n = this.size;
    if (index === this.blank) return false;
    const row = (index / n) | 0;
    const col = index % n;
    const blankRow = (this.blank / n) | 0;
    const blankCol = this.blank % n;
    if (row !== blankRow && col !== blankCol) return false;
    if (multiSlide) return true;
    return Math.abs(row - blankRow) + Math.abs(col - blankCol) === 1;
  }

  isSolved() {
    for (let i = 0; i < this.tiles.length; i++) {
      if (this.tiles[i] !== i) return false;
    }
    return true;
  }

  /** Fraction of tiles sitting in their home position, 0..1. */
  progress() {
    let home = 0;
    for (let i = 0; i < this.tiles.length; i++) {
      if (this.tiles[i] === i) home++;
    }
    return home / this.tiles.length;
  }

  /** Compact wire format: one character per tile. */
  encode() {
    let out = '';
    for (let i = 0; i < this.tiles.length; i++) out += ENCODE_ALPHABET[this.tiles[i]];
    return out;
  }
}

/** Decodes `Puzzle#encode` output back into a tile array. */
export function decodeTiles(text) {
  const out = new Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = ENCODE_ALPHABET.indexOf(text[i]);
  return out;
}

/* ========================================================================= */

/**
 * Renders a board into `holder`. Set `interactive: true` for the local player's
 * board; rival boards are display-only and driven by `showTiles()`.
 */
export class BoardView {
  constructor(holder, options = {}) {
    this.holder = holder;
    this.interactive = !!options.interactive;
    this.onMove = options.onMove || (() => {});
    this.onIllegal = options.onIllegal || (() => {});

    this.size = 0;
    this.pixels = 0;
    this.puzzle = null;
    this.tiles = [];
    this.elements = [];
    this.locked = false;
    this.hoverCell = -1;

    this.settings = {
      hoverMove: false,
      multiSlide: true,
      animate: false,
      showNumbers: true,
      highlightSettled: true,
      tileStyle: 'numbers',
      imageUrl: null,
    };

    this.el = document.createElement('div');
    this.el.className = 'board';
    this.peek = document.createElement('div');
    this.peek.className = 'peek-layer';
    this.el.appendChild(this.peek);
    holder.appendChild(this.el);

    if (this.interactive) this.#bindInput();
  }

  /* ------------------------------------------------------------ building */

  /**
   * Builds (or rebuilds) the tile elements for a board of `size`.
   * Tile elements are keyed by tile id and reused across moves.
   */
  build(size) {
    if (this.size === size && this.elements.length) return;
    this.size = size;
    this.el.style.setProperty('--n', String(size));
    this.el.querySelectorAll('.tile').forEach((node) => node.remove());
    this.elements = [];

    const total = size * size;
    const fragment = document.createDocumentFragment();
    for (let id = 0; id < total; id++) {
      const tile = document.createElement('div');
      tile.className = id === total - 1 ? 'tile blank' : 'tile';
      // Home row/column drive the photo crop and never change.
      tile.style.setProperty('--hc', String(id % size));
      tile.style.setProperty('--hr', String((id / size) | 0));

      const inner = document.createElement('div');
      inner.className = 'tile-inner';
      if (id !== total - 1) {
        const num = document.createElement('span');
        num.className = 'num';
        num.textContent = String(id + 1);
        inner.appendChild(num);
      }
      tile.appendChild(inner);
      fragment.appendChild(tile);
      this.elements.push(tile);
    }
    this.el.appendChild(fragment);
  }

  /** Sets the on-screen board edge length in CSS pixels. */
  setPixelSize(pixels) {
    this.pixels = Math.round(pixels);
    const tile = this.pixels / this.size;
    this.el.style.setProperty('--bp', `${this.pixels}px`);
    this.el.style.setProperty('--tile', `${tile}px`);
    this.el.style.setProperty('--gap', `${Math.max(1, Math.round(tile * 0.035))}px`);
  }

  /** Applies visual configuration; `imageUrl` may be null for non-photo modes. */
  configure(options) {
    Object.assign(this.settings, options);
    const s = this.settings;

    this.el.classList.toggle('photo', s.tileStyle === 'photo' && !!s.imageUrl);
    this.el.classList.toggle('no-numbers', !s.showNumbers);
    this.el.classList.toggle('animate', !!s.animate);
    this.el.classList.toggle('hover-mode', this.interactive && !!s.hoverMove);

    if (s.imageUrl) this.el.style.setProperty('--img', `url("${s.imageUrl}")`);
    else this.el.style.removeProperty('--img');

    if (s.palette) {
      this.el.style.setProperty('--tile-a', s.palette.a);
      this.el.style.setProperty('--tile-b', s.palette.b);
      this.el.style.setProperty('--tile-ink', s.palette.ink);
    }
    if (this.tiles.length) this.#paintSettled();
  }

  /** Binds this view to a live puzzle (the local player's board). */
  attach(puzzle) {
    this.puzzle = puzzle;
    this.el.classList.remove('solved', 'peeking');
    this.build(puzzle.size);
    this.showTiles(puzzle.tiles);
  }

  /** Renders an arbitrary tile array — used for rival boards. */
  showTiles(tiles) {
    if (!tiles || !tiles.length) return;
    const size = Math.round(Math.sqrt(tiles.length));
    this.build(size);
    this.tiles = tiles.slice();
    for (let position = 0; position < tiles.length; position++) {
      this.#place(tiles[position], position);
    }
    this.#paintSettled();
  }

  #place(tileId, position) {
    const element = this.elements[tileId];
    if (!element) return;
    element.style.setProperty('--c', String(position % this.size));
    element.style.setProperty('--r', String((position / this.size) | 0));
  }

  /** Repaints only the tiles listed in `positions`. */
  #applyPositions(positions) {
    for (const position of positions) {
      this.#place(this.tiles[position], position);
    }
  }

  #paintSettled() {
    const on = this.settings.highlightSettled;
    for (let position = 0; position < this.tiles.length; position++) {
      const element = this.elements[this.tiles[position]];
      if (!element) continue;
      element.classList.toggle('settled', on && this.tiles[position] === position);
    }
  }

  setLocked(locked) {
    this.locked = !!locked;
    this.el.classList.toggle('locked', this.locked);
  }

  setPeeking(peeking) {
    this.el.classList.toggle('peeking', !!peeking && !!this.settings.imageUrl);
  }

  flashSolved() {
    this.el.classList.remove('solved');
    void this.el.offsetWidth; // restart the CSS animation
    this.el.classList.add('solved');
    // Drop the class again so the ring cannot bleed into the next puzzle.
    this.el.addEventListener('animationend', () => this.el.classList.remove('solved'), { once: true });
  }

  destroy() {
    this.el.remove();
  }

  /* ------------------------------------------------------------ input */

  /** Board-relative pointer position to a cell index, or -1 when outside. */
  #cellAt(clientX, clientY) {
    const rect = this.el.getBoundingClientRect();
    const tile = rect.width / this.size;
    const col = Math.floor((clientX - rect.left) / tile);
    const row = Math.floor((clientY - rect.top) / tile);
    if (col < 0 || row < 0 || col >= this.size || row >= this.size) return -1;
    return row * this.size + col;
  }

  #bindInput() {
    // pointerdown, not click: the tile should land on press, not on release.
    this.el.addEventListener('pointerdown', (event) => {
      if (this.locked || !this.puzzle) return;
      if (event.button !== undefined && event.button !== 0) return;
      event.preventDefault();
      const cell = this.#cellAt(event.clientX, event.clientY);
      if (cell < 0) return;
      this.hoverCell = cell;
      this.#tryMove(cell, this.settings.multiSlide);
    });

    // Hover mode: track the cell under the pointer and slide as it changes.
    this.el.addEventListener('pointermove', (event) => {
      if (!this.settings.hoverMove || this.locked || !this.puzzle) return;
      const cell = this.#cellAt(event.clientX, event.clientY);
      if (cell < 0 || cell === this.hoverCell) return;
      this.hoverCell = cell;
      // Single-step only: a sweeping cursor should not push whole rows.
      this.#tryMove(cell, false);
    });

    this.el.addEventListener('pointerleave', () => {
      this.hoverCell = -1;
    });

    this.el.addEventListener('contextmenu', (event) => event.preventDefault());
  }

  #tryMove(cell, multiSlide) {
    const changed = this.puzzle.move(cell, multiSlide);
    if (!changed) {
      this.onIllegal();
      return;
    }
    this.tiles = this.puzzle.tiles;
    this.#applyPositions(changed);
    // The blank is invisible but keep its coordinates honest anyway.
    this.#place(this.puzzle.blankId, this.puzzle.blank);

    // Only the moved tiles (and the vacated blank) can change settled state.
    if (this.settings.highlightSettled) {
      for (const position of changed) {
        const element = this.elements[this.tiles[position]];
        if (element) element.classList.toggle('settled', this.tiles[position] === position);
      }
    }

    // In hover mode the blank lands under the cursor, so the next cell the
    // pointer enters is a genuine new hover target.
    this.hoverCell = this.puzzle.blank;
    this.onMove(changed.length, changed);
  }

  /** Keyboard play: arrow keys move the tile from that direction into the blank. */
  handleKey(key) {
    if (this.locked || !this.puzzle) return false;
    const n = this.size;
    const blank = this.puzzle.blank;
    const row = (blank / n) | 0;
    const col = blank % n;
    let target = -1;
    if (key === 'ArrowUp' && row < n - 1) target = blank + n;
    else if (key === 'ArrowDown' && row > 0) target = blank - n;
    else if (key === 'ArrowLeft' && col < n - 1) target = blank + 1;
    else if (key === 'ArrowRight' && col > 0) target = blank - 1;
    if (target < 0) return false;
    this.#tryMove(target, false);
    return true;
  }
}
