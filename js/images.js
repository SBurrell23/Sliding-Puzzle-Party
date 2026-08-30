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

let catalogPromise = null;
let catalog = null;
let currentObjectUrl = null;

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

/** Photo metadata for a shared index, or null. */
export function photoAt(index) {
  if (!catalog?.photos?.length) return null;
  return catalog.photos[((index % catalog.photos.length) + catalog.photos.length) % catalog.photos.length];
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

/**
 * Fetches the photo at `index` and returns a square, ready-to-slice image.
 *
 * @returns {Promise<{url: string, photo: object}|null>} null when the picture
 *          cannot be loaded, so the caller can fall back to numbered tiles.
 */
export async function prepareSquareImage(index) {
  await loadCatalog();
  const photo = photoAt(index);
  if (!photo) return null;

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

  let url;
  try {
    url = await toObjectUrl(canvas);
  } catch (error) {
    console.warn('Could not rasterise photo:', error);
    return null;
  }

  // Only one prepared photo is ever in play; release the previous one.
  if (currentObjectUrl && currentObjectUrl.startsWith('blob:')) {
    URL.revokeObjectURL(currentObjectUrl);
  }
  currentObjectUrl = url;

  return { url, photo };
}

/** Human-readable credit line for a photo record. */
export function creditFor(photo) {
  if (!photo) return '';
  const species = photo.s && photo.s !== photo.n ? ` (${photo.s})` : '';
  return `${photo.n}${species} — CC0 via iNaturalist`;
}
