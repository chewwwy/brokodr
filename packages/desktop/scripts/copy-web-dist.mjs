/**
 * Copies the built web app into packages/desktop/web-dist.
 *
 * The packaged Electron app serves the web build over a loopback HTTP server (see
 * electron/main.ts for why it cannot use file://). electron-builder only bundles paths
 * listed in its `files` array, and those paths must live inside packages/desktop — it
 * will not reach up into a sibling workspace package. So the build output has to be
 * physically copied here first.
 *
 * Without this step the installed app starts, binds its loopback server, and serves
 * nothing: a blank window.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, "..");
const webDist = path.resolve(desktopRoot, "../web/dist");
const target = path.join(desktopRoot, "web-dist");

if (!fs.existsSync(path.join(webDist, "index.html"))) {
  console.error(
    `\n[copy-web-dist] Web build not found at ${webDist}\n` +
      `Run \`bun run build\` from the repo root first (it builds packages/web before packages/desktop).\n`,
  );
  process.exit(1);
}

fs.rmSync(target, { recursive: true, force: true });
fs.cpSync(webDist, target, { recursive: true });

// Fail loudly if the DSP modules did not make it across. They are loaded at runtime by
// AudioWorklet.addModule() from /dsp/..., so they are NOT part of the JS bundle graph and
// a broken copy would only surface as "the engine will not start" in the packaged app.
const dspEntry = path.join(target, "dsp", "worklet-processor.js");
if (!fs.existsSync(dspEntry)) {
  console.error(`\n[copy-web-dist] ${dspEntry} is missing — the audio engine cannot start.\n`);
  process.exit(1);
}

const count = fs.readdirSync(path.join(target, "dsp"), { recursive: true }).length;
console.log(`[copy-web-dist] web-dist ready (${count} entries under /dsp)`);
