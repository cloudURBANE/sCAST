import fs from 'fs';
import path from 'path';
import sharp from 'sharp';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const PUBLIC_DIR = path.join(REPO_ROOT, 'artifacts', 'scent-cast', 'public');
const SPLASH_DIR = path.join(PUBLIC_DIR, 'icons', 'splash');
const LOGO_PATH = path.join(PUBLIC_DIR, 'scentbeam-logo-tight-transparent.png');

if (!fs.existsSync(SPLASH_DIR)) {
  fs.mkdirSync(SPLASH_DIR, { recursive: true });
}

const targets = [
  { width: 2048, height: 2732, name: 'apple-splash-2048-2732.png' },
  { width: 1668, height: 2388, name: 'apple-splash-1668-2388.png' },
  { width: 1536, height: 2048, name: 'apple-splash-1536-2048.png' },
  { width: 1668, height: 2224, name: 'apple-splash-1668-2224.png' },
  { width: 1620, height: 2160, name: 'apple-splash-1620-2160.png' },
  { width: 1290, height: 2796, name: 'apple-splash-1290-2796.png' },
  { width: 1179, height: 2556, name: 'apple-splash-1179-2556.png' },
  { width: 1284, height: 2778, name: 'apple-splash-1284-2778.png' },
  { width: 1170, height: 2532, name: 'apple-splash-1170-2532.png' },
  { width: 1125, height: 2436, name: 'apple-splash-1125-2436.png' },
  { width: 1242, height: 2688, name: 'apple-splash-1242-2688.png' },
  { width: 828, height: 1792, name: 'apple-splash-828-1792.png' },
  { width: 1242, height: 2208, name: 'apple-splash-1242-2208.png' },
  { width: 750, height: 1334, name: 'apple-splash-750-1334.png' },
  { width: 640, height: 1136, name: 'apple-splash-640-1136.png' }
];

async function generate() {
  console.log('Generating PWA splash screens...');
  const logoBuffer = fs.readFileSync(LOGO_PATH);

  for (const target of targets) {
    const outputPath = path.join(SPLASH_DIR, target.name);

    // Calculate a reasonable logo size (e.g. 50% of the screen width, capped at 320px)
    const logoWidth = Math.min(Math.round(target.width * 0.5), 320);

    // Resize the logo
    const resizedLogo = await sharp(logoBuffer)
      .resize({ width: logoWidth })
      .toBuffer();

    // Create a black canvas and composite the logo in the center
    await sharp({
      create: {
        width: target.width,
        height: target.height,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 1 }
      }
    })
      .composite([{
        input: resizedLogo,
        gravity: 'center'
      }])
      .png()
      .toFile(outputPath);

    console.log(`Generated ${target.name} (${target.width}x${target.height})`);
  }
  console.log('Splash screens generation complete!');
}

generate().catch(err => {
  console.error('Error generating splash screens:', err);
  process.exit(1);
});
