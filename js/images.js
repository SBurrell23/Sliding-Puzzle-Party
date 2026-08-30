/**
 * Wildlife picture catalogue.
 *
 * `data/wildlife.json` holds ~520 CC0 photographs harvested from iNaturalist
 * (see tools/fetch-wildlife.mjs). Photos are picked by index from a shared seed
 * so every racer gets the same animal.
 *
 * Puzzle tiles need a square source, so the chosen photo is centre-cropped into
 * an offscreen canvas and handed to CSS as a blob URL. The iNaturalist bucket
 * sends `Access-Control-Allow-Origin: *`, so the canvas stays untainted.
 */

const CATALOG_URL = 'data/wildlife.json';
const CANVAS_SIZE = 900;
/** Prepared pictures to keep alive; older ones have their blob URLs revoked. */
const CACHE_LIMIT = 6;

let catalogPromise = null;
let catalog = null;

/** normalised index -> Promise<{url, photo}|null> */
const preparedByIndex = new Map();

/** Loads (and caches) the photo catalogue. Resolves to null if unavailable. */
export function loadCatalog() {
  if (catalogPromise) return catalogPromise;
  catalogPromise = fetch(CATALOG_URL)
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    })
    .then((data) => {
      catalog = data;
      return data;
    })
    .catch((error) => {
      console.warn('Wildlife catalogue unavailable:', error);
      catalog = null;
      return null;
    });
  return catalogPromise;
}

export function catalogSize() {
  return catalog?.photos?.length || 0;
}

/** Wraps any integer into a valid catalogue position, or -1 with no catalogue. */
function normalizeIndex(index) {
  const total = catalog?.photos?.length || 0;
  if (!total) return -1;
  return ((Math.trunc(index) % total) + total) % total;
}

/** Photo metadata for a shared index, or null. */
export function photoAt(index) {
  const position = normalizeIndex(index);
  return position < 0 ? null : catalog.photos[position];
}

/** Picks a catalogue position at random, or null when there is no catalogue. */
export function randomPhotoIndex() {
  const total = catalogSize();
  return total ? Math.floor(Math.random() * total) : null;
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Could not load ${url}`));
    image.src = url;
  });
}

function toObjectUrl(canvas) {
  return new Promise((resolve) => {
    if (canvas.toBlob) {
      canvas.toBlob(
        (blob) => resolve(blob ? URL.createObjectURL(blob) : canvas.toDataURL('image/jpeg', 0.9)),
        'image/jpeg',
        0.9
      );
    } else {
      resolve(canvas.toDataURL('image/jpeg', 0.9));
    }
  });
}

/** Downloads one photo and rasterises a centre-cropped square from it. */
async function buildSquare(photo) {
  let image;
  try {
    image = await loadImage(photo.u);
  } catch (error) {
    console.warn(error);
    return null;
  }

  const side = Math.min(image.naturalWidth, image.naturalHeight);
  const sx = (image.naturalWidth - side) / 2;
  const sy = (image.naturalHeight - side) / 2;

  const canvas = document.createElement('canvas');
  canvas.width = CANVAS_SIZE;
  canvas.height = CANVAS_SIZE;
  const context = canvas.getContext('2d');
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, sx, sy, side, side, 0, 0, CANVAS_SIZE, CANVAS_SIZE);

  try {
    return { url: await toObjectUrl(canvas), photo };
  } catch (error) {
    console.warn('Could not rasterise photo:', error);
    return null;
  }
}

/** Drops the oldest cached pictures and releases their blob URLs. */
async function evictOldest() {
  while (preparedByIndex.size > CACHE_LIMIT) {
    const oldest = preparedByIndex.keys().next().value;
    const pending = preparedByIndex.get(oldest);
    preparedByIndex.delete(oldest);
    const prepared = await pending;
    if (prepared?.url?.startsWith('blob:')) URL.revokeObjectURL(prepared.url);
  }
}

/**
 * Fetches the photo at `index` and returns a square, ready-to-slice image.
 *
 * Results are cached by index, so a picture that was prefetched during a menu
 * or a countdown is returned immediately when the puzzle actually starts.
 *
 * @returns {Promise<{url: string, photo: object}|null>} null when the picture
 *          cannot be loaded, so the caller can fall back to numbered tiles.
 */
export async function prepareSquareImage(index) {
  await loadCatalog();
  const position = normalizeIndex(index);
  if (position < 0) return null;

  const cached = preparedByIndex.get(position);
  if (cached) return cached;

  const pending = buildSquare(catalog.photos[position]);
  preparedByIndex.set(position, pending);

  const prepared = await pending;
  // A failure should not be cached — the next attempt deserves a fresh try.
  if (!prepared) preparedByIndex.delete(position);
  else evictOldest();

  return prepared;
}

/**
 * Warms the cache for `index` in the background. Fire-and-forget: callers use
 * this so that `prepareSquareImage` later resolves without a visible wait.
 */
export function prefetchImage(index) {
  if (index == null) return;
  prepareSquareImage(index).catch(() => {
    /* a failed prefetch just means the real request will retry */
  });
}

/** Human-readable credit line for a photo record. */
export function creditFor(photo) {
  if (!photo) return '';
  const species = photo.s && photo.s !== photo.n ? ` (${photo.s})` : '';
  return `${photo.n}${species} — CC0 via iNaturalist`;
}
