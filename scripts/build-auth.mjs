import * as esbuild from "esbuild";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

await esbuild.build({
  entryPoints: [join(root, "auth", "firebase-auth.js")],
  bundle: true,
  format: "iife",
  globalName: "SnprFirebaseAuth",
  outfile: join(root, "auth", "firebase-auth.bundle.js"),
  platform: "browser",
  minify: false,
  footer: {
    js: "if (typeof SnprFirebaseAuth !== 'undefined' && SnprFirebaseAuth.default) { window.SnprFirebaseAuth = SnprFirebaseAuth.default; } else { window.SnprFirebaseAuth = SnprFirebaseAuth; }",
  },
});

console.log("Built auth/firebase-auth.bundle.js");
