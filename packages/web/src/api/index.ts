import type { RouterClient } from "@orpc/server";
import { createApp } from "./__core/app";
import { ping } from "./routes/ping";
import { presets } from "./routes/presets";
import { tts } from "./routes/tts";

// API features are oRPC procedures, one file per feature in ./routes/,
// composed into this router — typed end-to-end via the clients
// (web: src/web/lib/api.ts, mobile: lib/api.ts).
// Keep each routes/ file under 500 lines (`bun run lint` enforces this);
// split into more feature files as they grow.
// Patterns and examples: skills/app/references/api.md
export const router = {
  ping,
  presets,
  tts,
};

export type AppRouter = typeof router;
/** Typed client for the router — used by the web and mobile api clients. */
export type AppRouterClient = RouterClient<AppRouter>;

const app = createApp(router);

/**
 * Cross-origin isolation.
 *
 * SharedArrayBuffer — which the audio engine uses for its lock-free UI<->audio-thread
 * transport — is only exposed to a cross-origin isolated document. These headers request
 * that isolation on every response this server produces. COEP is `credentialless` rather
 * than `require-corp` so third-party subresources still load; everything this app needs is
 * self-hosted regardless.
 *
 * Isolation cannot be guaranteed: a static host or a preview iframe in front of this server
 * can strip or override the headers. The engine checks `crossOriginIsolated` at startup and
 * falls back to a postMessage transport when it is false, so the app degrades instead of
 * failing. The desktop build sets the same headers on the Electron session, where nothing
 * can strip them.
 */
app.use("*", async (c, next) => {
  await next();
  c.header("Cross-Origin-Opener-Policy", "same-origin");
  c.header("Cross-Origin-Embedder-Policy", "credentialless");
  c.header("Cross-Origin-Resource-Policy", "cross-origin");
});
// Rare plain-HTTP endpoints (webhooks, streaming, the Better Auth handler)
// register here with full paths, e.g. app.post("/api/webhooks/example", ...)

export default app;
