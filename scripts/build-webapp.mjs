import * as esbuild from "esbuild";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const watch = process.argv.includes("--watch");

const options = {
  entryPoints: [join(root, "webapp", "src", "app.js")],
  bundle: true,
  format: "iife",
  outfile: join(root, "webapp", "app.bundle.js"),
  platform: "browser",
  minify: !watch,
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("Watching webapp/src/app.js …");
} else {
  await esbuild.build(options);
  console.log("Built webapp/app.bundle.js");
}
