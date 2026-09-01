# Sliding Puzzle Party

A fast, competitive sliding-puzzle game in vanilla JavaScript. Play solo against
the clock, or open a peer-to-peer room and race friends Tetris 99 style — everyone
gets the same puzzle, and you watch their boards fill in beside yours in real time.

**▶ [Play it here](https://sburrell23.github.io/Sliding-Puzzle-Party/)**

No build step, no bundler, no backend. Just static files.

## Features

**Built for racing.** Tiles move on `pointerdown` with no transition at all — a
click is a couple of CSS custom-property writes, so the tile is simply *there*.
Slide animation is an opt-in setting, off by default.

- **Solo mode** with a timer, move counter, and personal bests per board size.
- **All-time stats**, from the chart button in the corner: puzzles completed,
  fastest ever, fewest moves, average time and average moves, plus a per-puzzle
  breakdown. Solo and multiplayer finishes both count. Kept in `localStorage`, so
  it is per-browser and survives reloads but not a site-data wipe — there is a
  two-tap reset in the panel if you want to start over deliberately.
- **Session record** down the left of the solo screen: every solve you complete,
  newest first, with its time, move count, and a marker on personal bests.
  Finishing shows a toast rather than a dialog, so the completed picture stays in
  view. Use *Setup* to change puzzle settings without losing the record — only
  returning to the main menu clears it.
- **Multiplayer rooms** — host a room, share a six-character code (or an invite
  link), and race. Rival boards mirror live beside your own with names, move
  counts, progress bars, and finishing places.
- **Same puzzle for everyone.** The host broadcasts a seed; every client
  scrambles identically with the same PRNG.
- **Back to the lobby** after a round, so you can tweak settings and go again
  without re-sharing the code.
- **Configurable puzzles** — 3×3 up to 8×8, numbered tiles, wildlife photos, or
  colour blocks. Eight preset palettes, or pick **two colours of your own** to
  fade between; the tile numbers automatically switch between dark and light ink
  so they stay readable against whatever gradient you choose.
- **Solved tiles glow green**, so you can see the picture assembling at a glance.
- **520 CC0 wildlife photographs** pulled from iNaturalist, centre-cropped in the
  browser and sliced across the board. Hold *Preview* to peek at the finished picture.
- **Pictures arrive before the puzzle does.** Photos are prepared ahead of time
  and cached by index: solo prefetches while you are on the setup screen, and in
  multiplayer the host announces the next round's picture from the lobby so every
  player has it downloaded before the countdown starts. The clock never runs while
  an image is still loading.
- **Move on hover** (off by default) — sweep the pointer to slide tiles instead
  of clicking. Also: push whole rows in one click, arrow-key play.
- **Sound** — a looping soundtrack plus effects synthesised live with the Web
  Audio API (no effect files to download). Volume for music and effects is always
  reachable from the speaker button in the corner.

## Running locally

Any static file server works; ES modules and `fetch` need HTTP rather than
`file://`.

```bash
npx http-server . -p 5173 -c-1
```

Then open <http://localhost:5173>.

To race yourself, open a second tab and join with the room code. Note that two
tabs on the same origin share one `localStorage`, so they also share a display
name — real players on separate devices do not have this problem.

## How multiplayer works

Rooms are a star topology over [PeerJS](https://peerjs.com), using the public
broker for signalling and WebRTC data channels for everything after that. The
host's peer id is `spp-<CODE>`, so the room code is all anyone needs to connect.

- Clients push their board to the host at ~12 Hz, encoded as one character per
  tile.
- The host merges every board into a single snapshot and fans it back out at the
  same rate, so message volume stays linear in the player count.
- The host is the authority on finishing order and standings, which keeps every
  screen agreeing about who won.

If the host closes the room, clients are returned to the menu.

## Refreshing the photo set

`data/wildlife.json` is generated, not hand-written:

```bash
node tools/fetch-wildlife.mjs
node tools/validate-wildlife.mjs
```

The fetcher pulls research-grade, CC0-licensed observations across eight iconic
taxa (birds, mammals, insects, reptiles, amphibians, fish, arachnids, molluscs),
capped at three photos per species so the set stays varied. The validator drops
any URL that no longer resolves.

## Deployment

Pushing to `main` triggers `.github/workflows/deploy.yml`, which publishes the
repository root to GitHub Pages. There is nothing to build.

## Credits

- Wildlife photography: [iNaturalist](https://www.inaturalist.org) contributors,
  released under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/).
- Peer-to-peer networking: [PeerJS](https://peerjs.com).
- The soundtrack (`assets/music/theme.mp3`) was supplied with the project.

Code is released under the MIT License — see [LICENSE](LICENSE).
