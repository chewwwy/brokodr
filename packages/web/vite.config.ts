import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite"
import path from "path";
import runableAnalyticsPlugin from "./vite/__plugins/runable-analytics-plugin";
import honoDevPlugin from "./vite/__plugins/hono-dev-plugin";
import assetOptimizerPlugin from "./vite/__plugins/asset-optimizer-plugin";

const root = path.resolve(__dirname, "../..");

export default defineConfig(({ mode }) => {
	const env = loadEnv(mode, root, '');
	Object.assign(process.env, env);

	return {
		// All env files live at the repo root — keep Vite's own env loading there too,
		// so packages/web/.env* files can never shadow the root .env.
		envDir: root,
		plugins: [honoDevPlugin(), react(), runableAnalyticsPlugin(), tailwind(), assetOptimizerPlugin()],
		resolve: {
			alias: {
				"@": path.resolve(__dirname, "./src/web"),
			},
		},
		server: {
			allowedHosts: true,
			hmr: { overlay: false, },
			cors: false,
			// Cross-origin isolation unlocks SharedArrayBuffer, which the audio engine uses
			// for its lock-free UI<->audio-thread transport (see src/web/audio/backend.ts).
			// COEP is `credentialless` rather than `require-corp` so third-party subresources
			// still load; every font and asset this app needs is self-hosted anyway. If
			// isolation is unavailable (e.g. inside a platform preview iframe) the engine
			// detects it and switches to a postMessage transport automatically.
			headers: {
				"Cross-Origin-Opener-Policy": "same-origin",
				"Cross-Origin-Embedder-Policy": "credentialless",
			},
		},
		// Keep the DSP modules as separate files: they are loaded by the AudioWorklet at
		// runtime via addModule() + native `import`, not bundled into the app graph.
		assetsInclude: ["**/*.wasm"],
	};
});
