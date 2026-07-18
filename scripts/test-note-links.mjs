/**
 * Note link conversion tests.
 *
 * Usage:  node scripts/test-note-links.mjs [filter...]
 */

import esbuild from "esbuild";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const testEntry = path.resolve(root, "scripts/_test-note-links-entry.ts");
const testOut = path.resolve(root, "scripts/_test-note-links-out.mjs");

await esbuild.build({
    entryPoints: [testEntry],
    bundle: true,
    write: true,
    outfile: testOut,
    format: "esm",
    target: "es2020",
    platform: "node",
    conditions: ["worker"],
    external: ["obsidian"],
    banner: { js: "" },
});

const filter = process.argv.slice(2);
const { run } = await import(`./_test-note-links-out.mjs?t=${Date.now()}`);
await run(filter.length ? filter : undefined);

fs.unlinkSync(testOut);
