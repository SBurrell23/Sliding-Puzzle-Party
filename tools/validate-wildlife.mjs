/**
 * HEAD-checks every photo in data/wildlife.json and rewrites the file with
 * only the URLs that actually resolve. Run after fetch-wildlife.mjs.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const path = new URL('../data/wildlife.json', import.meta.url);
const data = JSON.parse(readFileSync(path, 'utf8'));

async function check(photo) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(photo.u, { method: 'HEAD' });
      if (res.status === 200) return true;
      if (res.status === 404) return false;
    } catch {}
    await new Promise((r) => setTimeout(r, 500 * attempt));
  }
  return false;
}

const good = [];
const bad = [];
const CONCURRENCY = 24;
let cursor = 0;

await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (cursor < data.photos.length) {
      const photo = data.photos[cursor++];
      ((await check(photo)) ? good : bad).push(photo);
    }
  })
);

console.log(`ok: ${good.length}   dead: ${bad.length}`);
bad.slice(0, 10).forEach((p) => console.log('  dead ->', p.u));

data.photos = good;
data.count = good.length;
writeFileSync(path, JSON.stringify(data));
console.log(`data/wildlife.json now holds ${good.length} photos.`);
