// SPDX-License-Identifier: GPL-2.0-or-later
//
// `gnome-extensions pack` flattens every --extra-source file into the zip
// root regardless of its original path, which loses the lib/ subdirectory
// extension.js imports from at runtime (`./lib/indicator.js`). Build the zip
// directly instead, preserving dist/extension's directory structure exactly.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const distExtension = join(root, "dist", "extension");

if (!existsSync(distExtension)) {
  console.error("dist/extension not found — run `npm run build` first.");
  process.exit(1);
}

const metadata = JSON.parse(
  readFileSync(join(distExtension, "metadata.json"), "utf8"),
);
const outFile = join(root, `${metadata.uuid}.shell-extension.zip`);

rmSync(outFile, { force: true });

// Excludes devtime-only output that shouldn't ship: .d.ts, .js.map, and the
// dev-mode .env flag (see scripts/copy-assets.mjs) even if one happens to
// exist locally.
const result = spawnSync( // NOSONAR - devtime-only build script, not shipped, fixed argv
  "zip",
  ["-r", "-X", outFile, ".", "-x", "*.d.ts", "-x", "*.js.map", "-x", ".env"],
  { cwd: distExtension, stdio: "inherit" },
);
if (result.status !== 0) process.exit(result.status ?? 1);

console.log(`\nPacked ${outFile}`);
