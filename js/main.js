/**
 * Sliding Puzzle Party — application wiring.
 *
 * Screens are plain sections toggled by `show()`. Two game modes share the same
 * puzzle engine and board renderer:
 *
 *   solo  — local timer, personal bests, no networking.
 *   race  — a PeerJS room where the host picks the puzzle, broadcasts the seed
 *           so everyone scrambles identically, and merges each player's board
 *           into a snapshot that is fanned back out ~12 times a second.
 */

import { Puzzle, BoardView, randomSeed, decodeTiles } from './puzzle.js';
import { Net } from './net.js';
import {
  prepareSquareImage,
  prefetchImage,
  randomPhotoIndex,
  loadCatalog,
  creditFor,
} from './images.js';
import { buildConfigUI } from './config-ui.js';
import * as audio from './audio.js';
import { sfx } from './audio.js';
import {
  prefs,
  config,
  savePrefs,
  adoptConfig,
  shareableConfig,
  PALETTES,
  TILE_STYLES,
  getBest,
  recordBest,
} from './settings.js';

const $ = (id) => document.getElementById(id);
const SNAPSHOT_HZ = 12;
const RIVAL_BOARD_PX = 108;

/* ========================================================================== */
/*  Screens & chrome                                                          */
/* ========================================================================== */

let currentScreen = 'home';

function show(name) {
  currentScreen = name;
  for (const section of document.querySelectorAll('.screen')) {
    section.classList.toggle('active', section.id === `screen-${name}`);
  }
  window.scrollTo(0, 0);
}

function toast(text, kind = '', duration = 2600) {
  const node = document.createElement('div');
  node.className = `toast ${kind}`.trim();
  node.textContent = text;
  $('toasts').appendChild(node);
  setTimeout(() => {
    node.classList.add('out');
    setTimeout(() => node.remove(), 320);
  }, duration);
}

function formatTime(ms) {
  if (ms == null) return '—';
  const total = ms / 1000;
  if (total < 60) return `${total.toFixed(1)}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total - minutes * 60;
  return `${minutes}:${seconds.toFixed(1).padStart(4, '0')}`;
}

/* ========================================================================== */
/*  Audio panel                                                               */
/* ========================================================================== */

function syncAudioButton() {
  const silent = (prefs.musicMuted || prefs.musicVolume === 0) && (prefs.fxMuted || prefs.fxVolume === 0);
  $('audioBtn').classList.toggle('muted', silent);
}

function setupAudioPanel() {
  audio.attachMusicElement($('music'));

  const musicVol = $('musicVol');
  const fxVol = $('fxVol');
  musicVol.value = String(Math.round(prefs.musicVolume * 100));
  fxVol.value = String(Math.round(prefs.fxVolume * 100));
  $('musicVolOut').textContent = musicVol.value;
  $('fxVolOut').textContent = fxVol.value;
  $('musicMute').classList.toggle('off', prefs.musicMuted);
  $('fxMute').classList.toggle('off', prefs.fxMuted);
  syncAudioButton();

  musicVol.addEventListener('input', () => {
    audio.setMusicVolume(Number(musicVol.value) / 100);
    $('musicVolOut').textContent = musicVol.value;
    syncAudioButton();
  });

  fxVol.addEventListener('input', () => {
    audio.setFxVolume(Number(fxVol.value) / 100);
    $('fxVolOut').textContent = fxVol.value;
    syncAudioButton();
  });
  fxVol.addEventListener('change', () => sfx.click());

  $('musicMute').addEventListener('click', () => {
    audio.setMusicMuted(!prefs.musicMuted);
    $('musicMute').classList.toggle('off', prefs.musicMuted);
    syncAudioButton();
  });

  $('fxMute').addEventListener('click', () => {
    audio.setFxMuted(!prefs.fxMuted);
    $('fxMute').classList.toggle('off', prefs.fxMuted);
    syncAudioButton();
    if (!prefs.fxMuted) sfx.click();
  });

  $('testFx').addEventListener('click', () => audio.previewEffects());

  const panel = $('audioPanel');
  const open = () => {
    panel.hidden = false;
    sfx.click();
  };
  const close = () => {
    panel.hidden = true;
  };

  $('audioBtn').addEventListener('click', open);
  panel.addEventListener('click', (event) => {
    if (event.target === panel || event.target.closest('[data-close-modal]')) close();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !panel.hidden) close();
  });
}

/** Browsers require a gesture before any audio; the first one starts the music. */
function setupAudioUnlock() {
  const kick = () => {
    audio.unlock();
    audio.playMusic();
  };
  ['pointerdown', 'keydown', 'touchstart'].forEach((type) =>
    document.addEventListener(type, kick, { once: true, capture: true })
  );
}

/* ========================================================================== */
/*  Board sizing                                                              */
/* ========================================================================== */

/** Largest board that fits the stage, rounded so every tile is a whole pixel. */
function fitBoardPixels(stage, size) {
  const available = stage.getBoundingClientRect().width || window.innerWidth - 40;
  const vertical = window.innerHeight - stage.getBoundingClientRect().top - 96;
  const raw = Math.max(200, Math.min(available, vertical, 640));
  return Math.max(size * 28, Math.floor(raw / size) * size);
}

/* ========================================================================== */
/*  Solo mode                                                                 */
/* ========================================================================== */

const solo = {
  view: null,
  puzzle: null,
  seed: 0,
  imageUrl: null,
  photo: null,
  /** catalogue position of the picture currently on the board */
  photoIndex: null,
  /** catalogue position warmed up ahead of the next puzzle */
  nextPhotoIndex: null,
  startedAt: 0,
  running: false,
  timer: null,
};

/* ------------------------------------------------------- session record */

/** Solves completed since the last visit to the main menu. */
const sessionRecord = [];

function renderSessionRecord() {
  const list = $('recordList');
  list.textContent = '';
  $('recordCount').textContent = String(sessionRecord.length);
  $('recordEmpty').hidden = sessionRecord.length > 0;

  // Newest first: the run you just finished is the one you want to read.
  for (let i = sessionRecord.length - 1; i >= 0; i--) {
    const entry = sessionRecord[i];
    const item = document.createElement('li');
    if (entry.best) item.classList.add('best');

    const index = document.createElement('span');
    index.className = 'record-index';
    index.textContent = `#${i + 1}`;

    const meta = document.createElement('span');
    meta.className = 'record-meta';
    const label = document.createElement('span');
    label.className = 'record-label';
    label.textContent = `${entry.size}×${entry.size} · ${TILE_STYLES[entry.tileStyle] || entry.tileStyle}`;
    const moves = document.createElement('span');
    moves.className = 'record-moves';
    moves.textContent = entry.best ? `${entry.moves} moves · best` : `${entry.moves} moves`;
    meta.append(label, moves);

    const time = document.createElement('span');
    time.className = 'record-time';
    time.textContent = formatTime(entry.ms);

    item.append(index, meta, time);
    list.appendChild(item);
  }
}

function addSessionRecord(entry) {
  sessionRecord.push(entry);
  renderSessionRecord();
}

function clearSessionRecord() {
  sessionRecord.length = 0;
  renderSessionRecord();
}

function soloBoardSettings() {
  return {
    hoverMove: prefs.hoverMove,
    multiSlide: prefs.multiSlide,
    animate: prefs.animate,
    highlightSettled: prefs.highlightSettled,
    showNumbers: config.tileStyle !== 'photo' || prefs.showNumbersOnPhoto,
    tileStyle: config.tileStyle,
    palette: PALETTES[config.palette],
    imageUrl: solo.imageUrl,
  };
}

function soloStopTimer() {
  solo.running = false;
  if (solo.timer) {
    clearInterval(solo.timer);
    solo.timer = null;
  }
}

function soloTick() {
  if (!solo.running) return;
  $('soloTime').textContent = formatTime(performance.now() - solo.startedAt);
}

function soloUpdateBest() {
  const best = getBest(config.size, config.tileStyle);
  $('soloBest').textContent = best == null ? '—' : formatTime(best);
}

/** Loads the picture for a photo puzzle; falls back to numbers if it fails. */
async function resolveImage(imageIndex) {
  if (config.tileStyle !== 'photo') return { url: null, photo: null };
  const catalog = await loadCatalog();
  if (!catalog) {
    toast('Wildlife photos unavailable — using numbered tiles.', 'warn');
    return { url: null, photo: null };
  }
  const prepared = await prepareSquareImage(imageIndex);
  if (!prepared) {
    toast('That photo would not load — using numbered tiles.', 'warn');
    return { url: null, photo: null };
  }
  return prepared;
}

/** Warms up the picture that the next puzzle will use. */
function queueNextPhoto() {
  if (config.tileStyle !== 'photo') return;
  loadCatalog().then(() => {
    if (solo.nextPhotoIndex == null) solo.nextPhotoIndex = randomPhotoIndex();
    prefetchImage(solo.nextPhotoIndex);
  });
}

/** Blocks the start/restart controls while a picture is still downloading. */
function setSoloBusy(busy) {
  for (const id of ['startSolo', 'soloRestart', 'soloNew']) $(id).disabled = busy;
  $('soloSetupStatus').textContent = busy ? 'Loading picture…' : '';
  if (busy && currentScreen === 'solo') $('soloCaption').textContent = 'Loading picture…';
}

/**
 * Starts a solo puzzle. The picture is resolved *before* the board is shown and
 * the clock is started, so a photo puzzle never begins as numbered tiles and
 * the timer never runs while an image is still downloading.
 *
 * @param {object}  options
 * @param {boolean} options.reuseSeed   replay the same scramble
 * @param {boolean} options.reusePhoto  keep the picture currently in play
 */
async function startSolo({ reuseSeed = false, reusePhoto = false } = {}) {
  soloStopTimer();
  if (!reuseSeed) solo.seed = randomSeed();

  if (config.tileStyle === 'photo') {
    await loadCatalog();
    if (!reusePhoto || solo.photoIndex == null) {
      solo.photoIndex = solo.nextPhotoIndex ?? randomPhotoIndex();
      solo.nextPhotoIndex = null;
    }
    setSoloBusy(true);
    const prepared = await resolveImage(solo.photoIndex);
    setSoloBusy(false);
    solo.imageUrl = prepared.url;
    solo.photo = prepared.photo;
  } else {
    solo.imageUrl = null;
    solo.photo = null;
    solo.photoIndex = null;
  }

  show('solo');

  if (!solo.view) {
    solo.view = new BoardView($('soloBoardHolder'), {
      interactive: true,
      onMove: onSoloMove,
      onIllegal: () => sfx.blocked(),
    });
  }

  solo.puzzle = new Puzzle(config.size, solo.seed);
  solo.view.attach(solo.puzzle);
  solo.view.configure(soloBoardSettings());
  solo.view.setPixelSize(fitBoardPixels($('soloBoardHolder').parentElement, config.size));
  solo.view.setLocked(false);

  $('soloMoves').textContent = '0';
  $('soloTime').textContent = '0.0s';
  $('soloCaption').textContent = solo.photo ? creditFor(solo.photo) : '';
  $('soloPeek').disabled = !solo.imageUrl;
  soloUpdateBest();

  solo.startedAt = performance.now();
  solo.running = true;
  solo.timer = setInterval(soloTick, 100);

  // Get the following puzzle's picture ready while this one is being played.
  queueNextPhoto();
}

function onSoloMove(count) {
  sfx.move(count);
  $('soloMoves').textContent = String(solo.puzzle.moves);
  if (solo.puzzle.isSolved()) finishSolo();
}

function finishSolo() {
  const elapsed = performance.now() - solo.startedAt;
  const moves = solo.puzzle.moves;
  soloStopTimer();
  solo.view.setLocked(true);
  solo.view.flashSolved();
  $('soloTime').textContent = formatTime(elapsed);
  sfx.win();

  const improved = recordBest(config.size, config.tileStyle, elapsed, moves);
  soloUpdateBest();
  addSessionRecord({ size: config.size, tileStyle: config.tileStyle, ms: elapsed, moves, best: improved });

  // A toast rather than an overlay, so the finished picture stays in view.
  toast(
    improved
      ? `Solved in ${formatTime(elapsed)} · ${moves} moves — new personal best!`
      : `Solved in ${formatTime(elapsed)} · ${moves} moves`,
    improved ? 'warn' : 'good',
    4200
  );
}

/* ========================================================================== */
/*  Multiplayer                                                               */
/* ========================================================================== */

const net = new Net();

const race = {
  active: false,
  phase: 'idle', // idle | countdown | racing | finished
  puzzle: null,
  view: null,
  seed: 0,
  imageIndex: 0,
  imageUrl: null,
  photo: null,
  startedAt: 0,
  timer: null,
  finished: false,
  myPlace: 0,
  /** rival board views, keyed by peer id */
  rivals: new Map(),
  /** peers whose finish this client has already announced */
  announced: new Set(),
  /** edge length used for the rival mini-boards, set per round */
  rivalPx: RIVAL_BOARD_PX,
  /** picture the next round will use; announced from the lobby so everyone
   *  can download it before the countdown rather than during it */
  nextImageIndex: null,
  /** host authority: peer id -> {tiles, moves, ms, place} */
  boards: new Map(),
  finishOrder: [],
  snapshotTimer: null,
  uploadTimer: null,
  dirty: false,
  lastResults: null,
};

let lobbyConfigUI = null;
let soloConfigUI = null;

function selfName() {
  return prefs.name || (net.isHost ? 'Host' : 'Player');
}

function raceBoardSettings() {
  return {
    hoverMove: prefs.hoverMove,
    multiSlide: prefs.multiSlide,
    animate: prefs.animate,
    highlightSettled: prefs.highlightSettled,
    showNumbers: config.tileStyle !== 'photo' || prefs.showNumbersOnPhoto,
    tileStyle: config.tileStyle,
    palette: PALETTES[config.palette],
    imageUrl: race.imageUrl,
  };
}

/* ------------------------------------------------------------------ lobby */

function renderPlayers() {
  const list = $('playerList');
  list.textContent = '';
  const players = net.playerList;
  $('playerCount').textContent = String(players.filter((p) => p.connected).length);

  for (const player of players) {
    const item = document.createElement('li');
    if (!player.connected) item.style.opacity = '0.45';

    const dot = document.createElement('span');
    dot.className = 'player-dot';
    dot.style.background = player.color;

    const name = document.createElement('span');
    name.textContent = player.name;

    const tag = document.createElement('span');
    tag.className = 'player-tag';
    if (player.id === net.selfId) {
      tag.classList.add('you');
      tag.textContent = player.isHost ? 'you · host' : 'you';
    } else if (player.isHost) {
      tag.classList.add('host');
      tag.textContent = 'host';
    } else if (!player.connected) {
      tag.textContent = 'left';
    }

    item.append(dot, name, tag);
    list.appendChild(item);
  }
}

/**
 * Host only: choose the next round's picture now and tell everyone, so each
 * player downloads it while sitting in the lobby instead of at the whistle.
 */
function queueRacePhoto() {
  if (!net.isHost) return;
  if (config.tileStyle !== 'photo') {
    race.nextImageIndex = null;
    return;
  }
  loadCatalog().then(() => {
    if (race.nextImageIndex == null) race.nextImageIndex = randomPhotoIndex();
    if (race.nextImageIndex == null) return;
    prefetchImage(race.nextImageIndex);
    net.broadcast({ t: 'preload', imageIndex: race.nextImageIndex });
  });
}

function enterLobby() {
  show('lobby');
  $('roomCode').textContent = net.code || '------';
  $('startRace').hidden = !net.isHost;
  $('waitHint').hidden = net.isHost;
  $('clientConfigHint').hidden = net.isHost;

  if (!lobbyConfigUI) {
    lobbyConfigUI = buildConfigUI($('lobbyConfig'), (kind) => {
      if (kind === 'puzzle' && net.isHost) {
        net.broadcast({ t: 'config', config: shareableConfig() });
        // A different tile style may mean a different picture is needed.
        race.nextImageIndex = null;
        queueRacePhoto();
      }
    });
  }
  lobbyConfigUI.refresh();
  lobbyConfigUI.setEditable(net.isHost);
  renderPlayers();

  $('lobbyStatus').textContent = net.isHost
    ? 'Share the code — the race starts when you say so.'
    : 'Connected. Waiting for the host.';
  $('lobbyStatus').className = 'status-line ok';

  queueRacePhoto();
}

/* ------------------------------------------------------------- race setup */

function clearRivals() {
  for (const rival of race.rivals.values()) rival.view.destroy();
  race.rivals.clear();
  $('rivalGrid').textContent = '';
}

/** Creates (or reuses) the small board card for one rival. */
function ensureRival(player) {
  let entry = race.rivals.get(player.id);
  if (entry) return entry;

  const card = document.createElement('div');
  card.className = 'rival';

  const nameRow = document.createElement('div');
  nameRow.className = 'rival-name';
  const dot = document.createElement('span');
  dot.className = 'player-dot';
  dot.style.background = player.color;
  const label = document.createElement('span');
  label.textContent = player.name;
  nameRow.append(dot, label);

  const holder = document.createElement('div');
  holder.className = 'rival-board-holder';

  const foot = document.createElement('div');
  foot.className = 'rival-foot';
  const status = document.createElement('span');
  status.textContent = '0 moves';
  const place = document.createElement('span');
  place.className = 'rival-place';
  foot.append(status, place);

  const bar = document.createElement('div');
  bar.className = 'rival-bar';
  const fill = document.createElement('i');
  fill.style.width = '0%';
  bar.appendChild(fill);

  card.append(nameRow, holder, foot, bar);
  $('rivalGrid').appendChild(card);

  const view = new BoardView(holder, { interactive: false });
  view.build(config.size);
  view.configure({ ...raceBoardSettings(), highlightSettled: false, hoverMove: false, animate: false });
  view.setPixelSize(race.rivalPx);

  entry = { player, card, view, status, place, fill };
  race.rivals.set(player.id, entry);
  return entry;
}

/**
 * Rival boards grow when there are only a few opponents and shrink as the room
 * fills, so the sidebar always looks deliberate rather than sparse or cramped.
 */
function rivalPixelsFor(count) {
  const target = count <= 2 ? 168 : count <= 4 ? 142 : count <= 8 ? 120 : count <= 12 ? 102 : 88;
  return Math.max(config.size * 10, Math.floor(target / config.size) * config.size);
}

function rebuildRivals() {
  clearRivals();
  const others = net.playerList.filter((p) => p.id !== net.selfId);
  $('rivalCount').textContent = String(others.length);
  race.rivalPx = rivalPixelsFor(others.length);
  $('rivalGrid').style.gridTemplateColumns = `repeat(auto-fill, minmax(${race.rivalPx + 20}px, 1fr))`;
  if (!others.length) {
    const empty = document.createElement('p');
    empty.className = 'rival-empty';
    empty.textContent = 'No rivals yet — you are racing solo.';
    $('rivalGrid').appendChild(empty);
    return;
  }
  // Everyone scrambles from the same seed, so a rival who has not moved yet is
  // showing exactly our own starting position — not a solved board.
  const start = race.puzzle
    ? race.puzzle.tiles.slice()
    : Array.from({ length: config.size * config.size }, (_, i) => i);
  const home = start.reduce((sum, tile, index) => sum + (tile === index ? 1 : 0), 0);

  for (const player of others) {
    const entry = ensureRival(player);
    entry.view.showTiles(start);
    entry.fill.style.width = `${Math.round((home / start.length) * 100)}%`;
  }
}

function resizeBoards() {
  if (currentScreen === 'solo' && solo.view) {
    solo.view.setPixelSize(fitBoardPixels($('soloBoardHolder').parentElement, solo.view.size));
  }
  if (currentScreen === 'race' && race.view) {
    race.view.setPixelSize(fitBoardPixels($('raceBoardHolder').parentElement, race.view.size));
  }
}

/**
 * Begins a round on this machine. Host and clients both run this so the two
 * roles stay in step; only the host actually chose the seed.
 */
async function beginRace({ seed, imageIndex, config: shared }) {
  adoptConfig(shared);
  race.seed = seed;
  race.imageIndex = imageIndex;
  race.finished = false;
  race.myPlace = 0;
  race.announced.clear();
  race.phase = 'countdown';
  race.active = true;
  race.imageUrl = null;
  race.photo = null;

  show('race');
  $('raceMoves').textContent = '0';
  $('raceTime').textContent = '0.0s';
  $('racePlace').textContent = '—';
  $('raceCaption').textContent = '';
  $('endRound').hidden = true;

  race.puzzle = new Puzzle(config.size, seed);

  if (!race.view) {
    race.view = new BoardView($('raceBoardHolder'), {
      interactive: true,
      onMove: onRaceMove,
      onIllegal: () => sfx.blocked(),
    });
  }
  race.view.attach(race.puzzle);
  race.view.configure(raceBoardSettings());
  race.view.setPixelSize(fitBoardPixels($('raceBoardHolder').parentElement, config.size));
  race.view.setLocked(true);

  rebuildRivals();

  // The lobby already told everyone which picture to download, so this normally
  // resolves from cache. Dress the boards the moment it lands — usually before
  // the countdown even finishes — and only then start the clock.
  const imagePromise = resolveImage(imageIndex).then(({ url, photo }) => {
    race.imageUrl = url;
    race.photo = photo;
    race.view.configure(raceBoardSettings());
    for (const rival of race.rivals.values()) {
      rival.view.configure({ ...raceBoardSettings(), highlightSettled: false, hoverMove: false, animate: false });
    }
    $('raceCaption').textContent = photo ? creditFor(photo) : '';
    $('racePeek').disabled = !url;
  });

  await runCountdown();
  await imagePromise;

  race.phase = 'racing';
  race.startedAt = performance.now();
  race.view.setLocked(false);
  race.timer = setInterval(() => {
    if (race.phase === 'racing' && !race.finished) {
      $('raceTime').textContent = formatTime(performance.now() - race.startedAt);
    }
  }, 100);

  startUploads();
  if (net.isHost) startSnapshots();
}

function runCountdown() {
  return new Promise((resolve) => {
    const overlay = $('countdown');
    const label = $('countdownNum');
    let value = 3;
    overlay.hidden = false;
    label.textContent = String(value);
    sfx.tick();

    const step = setInterval(() => {
      value -= 1;
      if (value > 0) {
        label.textContent = String(value);
        label.style.animation = 'none';
        void label.offsetWidth;
        label.style.animation = '';
        sfx.tick();
      } else {
        label.textContent = 'GO';
        label.style.animation = 'none';
        void label.offsetWidth;
        label.style.animation = '';
        sfx.tick(true);
        clearInterval(step);
        setTimeout(() => {
          overlay.hidden = true;
          resolve();
        }, 450);
      }
    }, 800);
  });
}

function onRaceMove(count) {
  sfx.move(count);
  $('raceMoves').textContent = String(race.puzzle.moves);
  race.dirty = true;
  if (race.puzzle.isSolved()) finishRace();
}

function finishRace() {
  if (race.finished) return;
  const elapsed = performance.now() - race.startedAt;
  race.finished = true;
  race.phase = 'finished';
  race.view.setLocked(true);
  race.view.flashSolved();
  $('raceTime').textContent = formatTime(elapsed);
  sfx.win();

  const payload = { ms: elapsed, moves: race.puzzle.moves, tiles: race.puzzle.encode() };
  if (net.isHost) {
    hostRecordFinish(net.selfId, payload);
  } else {
    net.sendToHost({ t: 'done', ...payload });
  }
}

/* --------------------------------------------------------- board uploads */

function startUploads() {
  stopUploads();
  if (net.isHost) return; // the host reads its own board directly
  race.uploadTimer = setInterval(() => {
    if (!race.dirty || !race.puzzle) return;
    race.dirty = false;
    net.sendToHost({ t: 'board', tiles: race.puzzle.encode(), moves: race.puzzle.moves });
  }, 1000 / SNAPSHOT_HZ);
}

function stopUploads() {
  if (race.uploadTimer) {
    clearInterval(race.uploadTimer);
    race.uploadTimer = null;
  }
}

/* --------------------------------------------------------- host authority */

function hostBoardFor(id) {
  let entry = race.boards.get(id);
  if (!entry) {
    entry = { tiles: '', moves: 0, ms: null, place: 0 };
    race.boards.set(id, entry);
  }
  return entry;
}

function hostRecordFinish(id, { ms, moves, tiles }) {
  const entry = hostBoardFor(id);
  if (entry.ms != null) return; // already across the line
  entry.ms = ms;
  entry.moves = moves;
  if (tiles) entry.tiles = tiles;
  race.finishOrder.push(id);
  entry.place = race.finishOrder.length;

  const player = net.players.get(id);
  if (player) {
    if (id === net.selfId) {
      race.myPlace = entry.place;
      $('racePlace').textContent = ordinal(entry.place);
    } else {
      toast(`${player.name} finished ${ordinal(entry.place)}!`, 'good');
      sfx.rivalFinish();
    }
  }

  pushSnapshot();
  $('endRound').hidden = !net.isHost;
  maybeEndRound();
}

/** Ends the round automatically once every connected player has finished. */
function maybeEndRound() {
  const active = net.playerList.filter((p) => p.connected);
  const allDone = active.every((p) => hostBoardFor(p.id).ms != null);
  if (allDone && active.length > 0) endRound();
}

function endRound() {
  if (!net.isHost || race.phase === 'results') return;
  race.phase = 'results';
  stopSnapshots();

  const standings = net.playerList.map((player) => {
    const entry = race.boards.get(player.id) || { moves: 0, ms: null, tiles: '' };
    const tiles = entry.tiles ? decodeTiles(entry.tiles) : null;
    let progress = 0;
    if (entry.ms != null) progress = 1;
    else if (tiles) progress = tiles.filter((tile, index) => tile === index).length / tiles.length;
    return {
      id: player.id,
      name: player.name,
      color: player.color,
      ms: entry.ms,
      moves: entry.moves,
      progress,
      connected: player.connected,
    };
  });

  standings.sort((a, b) => {
    if (a.ms != null && b.ms != null) return a.ms - b.ms;
    if (a.ms != null) return -1;
    if (b.ms != null) return 1;
    return b.progress - a.progress;
  });
  standings.forEach((row, index) => {
    row.place = index + 1;
  });

  net.broadcast({ t: 'results', standings });
  showResults(standings);
}

function startSnapshots() {
  stopSnapshots();
  race.snapshotTimer = setInterval(pushSnapshot, 1000 / SNAPSHOT_HZ);
}

function stopSnapshots() {
  if (race.snapshotTimer) {
    clearInterval(race.snapshotTimer);
    race.snapshotTimer = null;
  }
}

/** Host: merge every board into one message and fan it out. */
function pushSnapshot() {
  if (!net.isHost) return;

  if (race.puzzle) {
    const mine = hostBoardFor(net.selfId);
    mine.tiles = race.puzzle.encode();
    mine.moves = race.puzzle.moves;
  }

  const boards = [];
  for (const [id, entry] of race.boards) {
    boards.push([id, entry.tiles, entry.moves, entry.place || 0, entry.ms == null ? 0 : Math.round(entry.ms)]);
  }
  const message = { t: 'snapshot', b: boards };
  net.broadcast(message);
  applySnapshot(message);
}

/* ------------------------------------------------------------ rival views */

function applySnapshot(message) {
  for (const [id, tiles, moves, place, ms] of message.b) {
    // Our own placing is decided by the host, so read it back off the snapshot.
    if (id === net.selfId) {
      if (place > 0 && !race.myPlace) {
        race.myPlace = place;
        $('racePlace').textContent = ordinal(place);
      }
      continue;
    }

    const player = net.players.get(id);
    if (!player) continue;

    const entry = ensureRival(player);
    if (tiles) {
      const decoded = decodeTiles(tiles);
      entry.view.showTiles(decoded);
      const home = decoded.reduce((sum, tile, index) => sum + (tile === index ? 1 : 0), 0);
      entry.fill.style.width = `${Math.round((home / decoded.length) * 100)}%`;
    }
    entry.status.textContent = `${moves} moves`;
    entry.card.classList.toggle('gone', !player.connected);

    if (place > 0) {
      entry.card.classList.add('done');
      entry.place.textContent = `${ordinal(place)} · ${formatTime(ms)}`;
      entry.fill.style.width = '100%';
      // The host announces finishes as it records them; clients learn here.
      if (!net.isHost && !race.announced.has(id)) {
        race.announced.add(id);
        toast(`${player.name} finished ${ordinal(place)}!`, 'good');
        sfx.rivalFinish();
      }
    }
  }
}

function ordinal(n) {
  const suffix = ['th', 'st', 'nd', 'rd'][n % 100 > 10 && n % 100 < 14 ? 0 : Math.min(n % 10, 4)] || 'th';
  return `${n}${suffix}`;
}

/* ---------------------------------------------------------------- results */

function showResults(standings) {
  race.lastResults = standings;
  race.phase = 'results';
  stopUploads();
  stopSnapshots();
  if (race.timer) {
    clearInterval(race.timer);
    race.timer = null;
  }

  const list = $('resultsList');
  list.textContent = '';

  for (const row of standings) {
    const item = document.createElement('li');
    if (row.place === 1 && row.ms != null) item.classList.add('first');
    if (row.id === net.selfId) item.classList.add('me');

    const place = document.createElement('span');
    place.className = 'res-place';
    place.textContent = row.ms == null ? '—' : ordinal(row.place);

    const dot = document.createElement('span');
    dot.className = 'player-dot';
    dot.style.background = row.color;

    const name = document.createElement('span');
    name.className = 'res-name';
    name.textContent = row.name + (row.id === net.selfId ? ' (you)' : '');

    const time = document.createElement('span');
    if (row.ms == null) {
      time.className = 'res-dnf';
      time.textContent = `${Math.round(row.progress * 100)}% done`;
    } else {
      time.className = 'res-time';
      time.textContent = formatTime(row.ms);
    }

    const moves = document.createElement('span');
    moves.className = 'res-moves';
    moves.textContent = `${row.moves} moves`;

    item.append(place, dot, name, time, moves);
    list.appendChild(item);
  }

  $('backToLobby').hidden = !net.isHost;
  $('resultsWait').hidden = net.isHost;
  show('results');

  const mine = standings.find((row) => row.id === net.selfId);
  if (mine?.place === 1 && mine.ms != null) sfx.fanfare();
}

function returnToLobby() {
  race.active = false;
  race.phase = 'idle';
  race.boards.clear();
  race.finishOrder = [];
  race.finished = false;
  stopUploads();
  stopSnapshots();
  if (race.timer) {
    clearInterval(race.timer);
    race.timer = null;
  }
  clearRivals();
  enterLobby();
}

/** Returns to the main menu, which is also what clears the session record. */
function goHome() {
  soloStopTimer();
  clearSessionRecord();
  if (net.peer) leaveRoom();
  else show('home');
}

function leaveRoom(message) {
  stopUploads();
  stopSnapshots();
  if (race.timer) {
    clearInterval(race.timer);
    race.timer = null;
  }
  clearRivals();
  race.active = false;
  race.phase = 'idle';
  race.boards.clear();
  race.finishOrder = [];
  net.leave();
  clearSessionRecord();
  show('home');
  if (message) toast(message, 'warn');
}

/* ------------------------------------------------------------ net wiring */

function wireNet() {
  net.on('players', () => {
    if (currentScreen === 'lobby') renderPlayers();
    if (net.isHost) net.broadcast(net.rosterMessage());
    if (currentScreen === 'race') {
      const others = net.playerList.filter((p) => p.id !== net.selfId);
      $('rivalCount').textContent = String(others.length);
      for (const player of others) ensureRival(player).card.classList.toggle('gone', !player.connected);
      if (net.isHost && race.phase === 'racing') maybeEndRound();
    }
  });

  net.on('playerJoined', (player) => {
    toast(`${player.name} joined`, 'good');
    sfx.join();
    if (net.isHost) {
      net.sendTo(player.id, { t: 'config', config: shareableConfig() });
      if (race.nextImageIndex != null) {
        net.sendTo(player.id, { t: 'preload', imageIndex: race.nextImageIndex });
      }
      // A late arrival during a live round watches until the next one.
      if (race.phase === 'racing') net.sendTo(player.id, { t: 'spectate' });
    }
  });

  net.on('playerLeft', (player) => {
    toast(`${player.name} left`, 'warn');
    sfx.leave();
  });

  net.on('hostGone', () => leaveRoom('The host closed the room.'));

  net.on('error', (error) => {
    console.error(error);
    toast(error?.message || 'Connection problem.', 'bad');
  });

  /* ---- host receiving from clients ---- */
  net.on('clientMessage', ({ from, message }) => {
    if (!net.isHost) return;
    if (message.t === 'board') {
      const entry = hostBoardFor(from);
      if (entry.ms == null) {
        entry.tiles = message.tiles;
        entry.moves = message.moves;
      }
    } else if (message.t === 'done') {
      hostRecordFinish(from, message);
    }
  });

  /* ---- clients receiving from the host ---- */
  net.on('hostMessage', (message) => {
    switch (message.t) {
      case 'players':
        if (currentScreen === 'lobby') renderPlayers();
        break;
      case 'config':
        adoptConfig(message.config);
        if (lobbyConfigUI) lobbyConfigUI.refresh();
        break;
      case 'preload':
        // Download the next round's picture now so the race starts on time.
        prefetchImage(message.imageIndex);
        break;
      case 'start':
        beginRace(message);
        break;
      case 'snapshot':
        if (race.active) applySnapshot(message);
        break;
      case 'results':
        showResults(message.standings);
        break;
      case 'lobby':
        returnToLobby();
        toast('Back to the lobby.', '');
        break;
      case 'spectate':
        toast('A race is already running — you will join the next one.', 'warn');
        break;
      default:
        break;
    }
  });
}

/* ========================================================================== */
/*  Peek (hold to preview the finished picture)                               */
/* ========================================================================== */

function wirePeek(buttonId, getView) {
  const button = $(buttonId);
  const start = (event) => {
    event.preventDefault();
    getView()?.setPeeking(true);
  };
  const stop = () => getView()?.setPeeking(false);

  button.addEventListener('pointerdown', start);
  button.addEventListener('pointerup', stop);
  button.addEventListener('pointerleave', stop);
  button.addEventListener('pointercancel', stop);
}

/* ========================================================================== */
/*  Boot                                                                      */
/* ========================================================================== */

function wireUI() {
  for (const button of document.querySelectorAll('[data-home]')) {
    button.addEventListener('click', () => {
      sfx.click();
      goHome();
    });
  }

  /* ---- home ---- */
  const openSoloSetup = () => {
    if (!soloConfigUI) {
      soloConfigUI = buildConfigUI($('soloConfig'), (kind) => {
        // Switching to photo tiles should start the download straight away.
        if (kind === 'puzzle') queueNextPhoto();
      });
    }
    soloConfigUI.refresh();
    soloConfigUI.setEditable(true);
    $('soloSetupStatus').textContent = '';
    show('solo-setup');
    queueNextPhoto();
  };

  $('goSolo').addEventListener('click', () => {
    sfx.click();
    openSoloSetup();
  });

  // Reached from a game in progress: changing settings must not wipe the
  // session record — only the main menu does that.
  $('soloSetup').addEventListener('click', () => {
    sfx.click();
    soloStopTimer();
    openSoloSetup();
  });

  $('goHost').addEventListener('click', () => {
    sfx.click();
    $('hostName').value = prefs.name || '';
    $('hostStatus').textContent = '';
    show('host');
  });

  $('goJoin').addEventListener('click', () => {
    sfx.click();
    $('joinName').value = prefs.name || '';
    $('joinStatus').textContent = '';
    const fromLink = new URLSearchParams(location.search).get('room');
    if (fromLink) $('joinCode').value = fromLink.toUpperCase();
    show('join');
  });

  /* ---- solo ---- */
  $('startSolo').addEventListener('click', () => {
    sfx.click();
    startSolo();
  });
  $('soloRestart').addEventListener('click', () => {
    sfx.click();
    startSolo({ reuseSeed: true, reusePhoto: true });
  });
  $('soloNew').addEventListener('click', () => {
    sfx.click();
    startSolo();
  });
  wirePeek('soloPeek', () => solo.view);
  wirePeek('racePeek', () => race.view);

  /* ---- hosting ---- */
  $('doHost').addEventListener('click', async () => {
    const name = $('hostName').value.trim().slice(0, 14) || 'Host';
    prefs.name = name;
    savePrefs();
    const status = $('hostStatus');
    status.className = 'status-line';
    status.textContent = 'Opening room…';
    $('doHost').disabled = true;
    try {
      await net.hostRoom(name);
      sfx.fanfare();
      enterLobby();
    } catch (error) {
      status.className = 'status-line error';
      status.textContent = error?.message || 'Could not open a room.';
      sfx.error();
    } finally {
      $('doHost').disabled = false;
    }
  });

  /* ---- joining ---- */
  const codeInput = $('joinCode');
  codeInput.addEventListener('input', () => {
    codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });
  codeInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') $('doJoin').click();
  });

  $('doJoin').addEventListener('click', async () => {
    const name = $('joinName').value.trim().slice(0, 14) || 'Player';
    prefs.name = name;
    savePrefs();
    const status = $('joinStatus');
    status.className = 'status-line';
    status.textContent = 'Connecting…';
    $('doJoin').disabled = true;
    try {
      await net.joinRoom(codeInput.value, name);
      sfx.join();
      enterLobby();
    } catch (error) {
      status.className = 'status-line error';
      status.textContent = error?.message || 'Could not join that room.';
      sfx.error();
    } finally {
      $('doJoin').disabled = false;
    }
  });

  /* ---- lobby ---- */
  $('leaveLobby').addEventListener('click', () => {
    sfx.click();
    leaveRoom();
  });

  $('copyCode').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(net.code || '');
      toast('Room code copied.', 'good');
    } catch {
      toast('Copy failed — read the code out instead.', 'warn');
    }
  });

  $('copyLink').addEventListener('click', async () => {
    const link = `${location.origin}${location.pathname}?room=${net.code}`;
    try {
      await navigator.clipboard.writeText(link);
      toast('Invite link copied.', 'good');
    } catch {
      toast('Copy failed — share the code instead.', 'warn');
    }
  });

  $('startRace').addEventListener('click', () => {
    if (!net.isHost) return;
    sfx.click();
    race.boards.clear();
    race.finishOrder = [];
    const payload = {
      t: 'start',
      seed: randomSeed(),
      // Use the picture everyone was told to preload in the lobby.
      imageIndex: race.nextImageIndex ?? randomPhotoIndex() ?? 0,
      config: shareableConfig(),
    };
    race.nextImageIndex = null;
    net.broadcast(payload);
    beginRace(payload);
  });

  /* ---- race ---- */
  $('leaveRace').addEventListener('click', () => {
    sfx.click();
    leaveRoom();
  });

  $('endRound').addEventListener('click', () => {
    sfx.click();
    endRound();
  });

  /* ---- results ---- */
  $('backToLobby').addEventListener('click', () => {
    if (!net.isHost) return;
    sfx.click();
    net.broadcast({ t: 'lobby' });
    returnToLobby();
  });

  /* ---- global ---- */
  document.addEventListener('keydown', (event) => {
    if (!event.key.startsWith('Arrow')) return;
    const view = currentScreen === 'solo' ? solo.view : currentScreen === 'race' ? race.view : null;
    if (view?.handleKey(event.key)) event.preventDefault();
  });

  window.addEventListener('resize', resizeBoards);
  window.addEventListener('orientationchange', () => setTimeout(resizeBoards, 120));

  window.addEventListener('beforeunload', () => {
    if (net.peer) net.leave();
  });
}

function boot() {
  setupAudioPanel();
  setupAudioUnlock();
  wireUI();
  wireNet();
  renderSessionRecord();
  loadCatalog();

  // An invite link drops the player straight onto the join screen.
  const room = new URLSearchParams(location.search).get('room');
  if (room) {
    $('joinCode').value = room.toUpperCase();
    $('joinName').value = prefs.name || '';
    show('join');
  }
}

boot();
