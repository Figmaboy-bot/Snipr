import * as esbuild from "esbuild";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

await esbuild.build({
  entryPoints: [join(root, "shared", "merge.js")],
  bundle: true,
  format: "iife",
  globalName: "SniprMerge",
  outfile: join(root, "shared", "merge.bundle.js"),
  platform: "browser",
  minify: false,
  footer: {
    // `self` (not `window`) so this bundle works both loaded as a plain
    // <script> and via importScripts() in background.js's service worker.
    js: "self.SniprMerge = SniprMerge;",
  },
});

console.log("Built shared/merge.bundle.js");
