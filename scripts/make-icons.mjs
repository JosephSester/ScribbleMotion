// Renders public/icons/icon.svg to the PNG sizes the manifest and iOS need.
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'public', 'icons', 'icon.svg');
const out = (name) => join(root, 'public', 'icons', name);

const jobs = [
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['icon-maskable-512.png', 512],
  ['apple-touch-icon-180.png', 180]
];

for (const [name, size] of jobs) {
  await sharp(src, { density: 300 }).resize(size, size).png().toFile(out(name));
  console.log('wrote', name);
}
