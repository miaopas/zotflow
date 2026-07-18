/**
 * Editable-region parser tests.
 *
 * Usage:  node scripts/test-editable-regions.mjs [filter...]
 */

import esbuild from "esbuild";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const testEntry = path.resolve(root, "scripts/_test-editable-regions-entry.ts");
const testOut = path.resolve(root, "scripts/_test-editable-regions-out.mjs");

await esbuild.build({
    entryPoints: [testEntry],
    bundle: true,
    write: true,
    outfile: testOut,
    format: "esm",
    target: "es2020",
    platform: "node",
    external: ["obsidian"],
    banner: { js: "" },
});

const filter = process.argv.slice(2);
const { run } = await import(`./_test-editable-regions-out.mjs?t=${Date.now()}`);
await run(filter.length ? filter : undefined);

fs.unlinkSync(testOut);
