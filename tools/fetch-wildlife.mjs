/**
 * Builds data/wildlife.json — a curated list of CC0 wildlife photos from iNaturalist.
 *
 * iNaturalist's API is free and needs no key. We only take `photo_license=cc0`
 * research-grade observations, ordered by faves, so the pictures are both
 * legally reusable and actually nice to look at.
 *
 *   node tools/fetch-wildlife.mjs
 */
import { writeFileSync } from 'node:fs';

const API = 'https://api.inaturalist.org/v1/observations';
const PER_PAGE = 100;

// How many photos to pull per iconic taxon (~520 total).
const QUOTAS = {
  Aves: 120,
  Mammalia: 120,
  Insecta: 80,
  Reptilia: 60,
  Amphibia: 50,
  Actinopterygii: 40,
  Arachnida: 30,
  Mollusca: 20,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getPage(taxon, page) {
  const url = `${API}?${new URLSearchParams({
    photo_license: 'cc0',
    quality_grade: 'research',
    iconic_taxa: taxon,
    photos: 'true',
    order_by: 'votes',
    order: 'desc',
    per_page: String(PER_PAGE),
    page: String(page),
  })}`;

  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Sliding-Puzzle-Party/1.0' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt === 4) throw err;
      await sleep(1500 * attempt);
    }
  }
}

const photos = [];
const seenPhoto = new Set();
const seenSpecies = new Map(); // keep variety: at most 3 photos of any one species

for (const [taxon, quota] of Object.entries(QUOTAS)) {
  let kept = 0;
  for (let page = 1; page <= 12 && kept < quota; page++) {
    const data = await getPage(taxon, page);
    if (!data.results?.length) break;

    for (const obs of data.results) {
      if (kept >= quota) break;
      const photo = obs.photos?.[0];
      if (!photo?.url || photo.license_code !== 'cc0') continue;
      if (seenPhoto.has(photo.id)) continue;

      const species = obs.taxon?.name || 'unknown';
      const speciesCount = seenSpecies.get(species) || 0;
      if (speciesCount >= 3) continue;

      // Photo URLs come back as `.../square.jpg`; every other size lives beside it
      // under the *same* extension, so `.jpeg` originals must stay `.jpeg`.
      const match = photo.url.match(/^(.*\/)square\.(jpe?g|png)(?:\?.*)?$/i);
      if (!match) continue;
      const [, base, ext] = match;

      seenPhoto.add(photo.id);
      seenSpecies.set(species, speciesCount + 1);
      kept++;
      photos.push({
        u: `${base}large.${ext.toLowerCase()}`,
        n: obs.taxon?.preferred_common_name || species,
        s: species,
        g: taxon,
        a: (photo.attribution || '').replace(/\s+/g, ' ').trim(),
      });
    }
    await sleep(600); // be polite to the API
  }
  console.log(`${taxon}: ${kept}`);
}

const out = {
  source: 'iNaturalist (https://www.inaturalist.org)',
  license: 'CC0 1.0 Universal (public domain dedication)',
  generated: new Date().toISOString().slice(0, 10),
  count: photos.length,
  photos,
};

writeFileSync(new URL('../data/wildlife.json', import.meta.url), JSON.stringify(out));
console.log(`\nWrote data/wildlife.json with ${photos.length} photos.`);
