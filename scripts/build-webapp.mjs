import * as esbuild from "esbuild";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const watch = process.argv.includes("--watch");

const options = {
  entryPoints: [
    join(root, "webapp", "src", "app.js"),
    join(root, "webapp", "src", "share.js"),
  ],
  bundle: true,
  format: "iife",
  outdir: join(root, "webapp"),
  entryNames: "[name].bundle",
  platform: "browser",
  minify: !watch,
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("Watching webapp/src/*.js …");
} else {
  await esbuild.build(options);
  console.log("Built webapp/app.bundle.js and webapp/share.bundle.js");
}
