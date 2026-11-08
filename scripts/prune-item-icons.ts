// Removes the legacy public/icons/<itemId>.jpg files. Icons are now keyed
// by the catalogue's shared icon id and served as .webp; the old per-item
// copies are dead weight (about 22 MB on a full client).
import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { ICON_PATH } from "@/lib/item-icons";

const iconsDir = join(process.cwd(), ICON_PATH);

function main() {
  if (!existsSync(iconsDir)) {
    console.log("No icon directory; nothing to prune.");
    return;
  }
  let deleted = 0;
  let bytes = 0;
  for (const name of readdirSync(iconsDir)) {
    if (!name.endsWith(".jpg")) continue;
    const path = join(iconsDir, name);
    bytes += statSync(path).size;
    unlinkSync(path);
    deleted += 1;
  }
  console.log(`Removed ${deleted} legacy item-id icons (${(bytes / 1024 / 1024).toFixed(1)} MB).`);
}

main();
