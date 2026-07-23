// One-shot logo renderer: rasterizes docs/logo.svg into the addon list
// icon (64x64 TGA, the texture format every WoW client loads) and a
// 256px PNG avatar for GitHub / CurseForge. Rerun after editing the SVG:
//   npm run logo:render
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

const svgPath = join(process.cwd(), "docs", "logo.svg");

// Uncompressed 32-bit top-down TGA: 18-byte header + BGRA pixels.
async function renderTga(size: number, outPath: string) {
  const { data, info } = await sharp(svgPath)
    .resize(size, size)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (info.width !== size || info.height !== size || info.channels !== 4) {
    throw new Error(`unexpected raster ${info.width}x${info.height}x${info.channels} for ${outPath}`);
  }
  const pixels = Buffer.from(data);
  for (let i = 0; i < pixels.length; i += 4) {
    const red = pixels[i];
    pixels[i] = pixels[i + 2];
    pixels[i + 2] = red;
  }
  const header = Buffer.alloc(18);
  header[2] = 2; // uncompressed true-color
  header.writeUInt16LE(size, 12);
  header.writeUInt16LE(size, 14);
  header[16] = 32; // bits per pixel
  header[17] = 0x28; // 8 alpha bits, top-down row order
  writeFileSync(outPath, Buffer.concat([header, pixels]));
  console.log(`wrote ${outPath} (${size}x${size} TGA)`);
}

async function renderPng(size: number, outPath: string) {
  await sharp(svgPath).resize(size, size).png().toFile(outPath);
  console.log(`wrote ${outPath} (${size}x${size} PNG)`);
}

await renderTga(64, join(process.cwd(), "addon", "WoWderhoiAH", "logo.tga"));
await renderPng(256, join(process.cwd(), "docs", "logo-256.png"));
