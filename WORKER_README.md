# Worker build, test and deploy — datamonkey-mcp-sensory

This repository is prepared for Cloudflare Worker deployment. Key Worker entry and pure‑JS image parser files:

- [`workers/entry.js`](workers/entry.js:1) — Worker HTTP RPC entrypoint (exports default fetch handler).
- [`workers/image-parser.js`](workers/image-parser.js:1) — Pure-JS PNG/JPEG header parser used by the Worker.
- [`index.js`](index.js:1) — Node-friendly library exports (no Node-only runtime calls). Intended for reuse outside the Worker; the Worker uses the local parser instead of native modules.
- [`test-client.js`](test-client.js:1) — Simple Node-based test client that posts RPCs to the running Worker.

Quick commands
- Build: npm run build
- Local dev with Wrangler: wrangler dev --local or wrangler dev
- Deploy with Wrangler (build step included): npm run deploy:wrangler
  - Equivalent: wrangler publish --build "npm run build"

How to build
1. Install dependencies (for development): npm install
2. Build the Worker bundle with esbuild (bundles `workers/entry.js` -> `dist/worker.js`):
   - npm run build

How to test locally
- Start a local Worker with Wrangler:
  - wrangler dev
  - By default Wrangler serves the Worker at a URL it prints (e.g. http://127.0.0.1:8787). Use that URL for test requests.

- Example curl requests (RPCs accepted by the Worker):
  - get_system_status
    - curl -X POST -H "Content-Type: application/json" --data '{"id":1,"method":"get_system_status","params":{}}' https://<YOUR_WORKER_URL>/
  - inspect_image_asset by URL
    - curl -X POST -H "Content-Type: application/json" --data '{"id":2,"method":"inspect_image_asset","params":{"url":"https://example.com/image.jpg"}}' https://<YOUR_WORKER_URL>/
  - inspect_image_asset by base64 (data URI)
    - curl -X POST -H "Content-Type: application/json" --data '{"id":3,"method":"inspect_image_asset","params":{"base64":"data:image/png;base64,<BASE64_DATA_HERE>"}}' https://<YOUR_WORKER_URL>/

- You can also use the included test client:
  - node test-client.js https://<YOUR_WORKER_URL>
  - Or: WORKER_URL=https://<YOUR_WORKER_URL> node test-client.js

What the Worker returns
- inspect_image_asset returns an object like:
  {
    "format": "png" | "jpeg" | "unknown",
    "width": <number|null>,
    "height": <number|null>,
    "size": <number>,       // bytes
    "mime": <string|null>
  }
- get_system_status returns Worker-safe runtime info:
  {
    "timestamp": <ms-since-epoch>,
    "requestDurationMs": <ms-approx>,
    "runtime": "Cloudflare Worker",
    "envBindings": [ ... ]
  }

Known limitations
- No native modules in the Worker: sharp and systeminformation are not used in the Worker bundle.
- The image parser in [`workers/image-parser.js`](workers/image-parser.js:1) only supports PNG and JPEG and performs header inspection only (no pixel decoding).
- Detailed system metrics (CPU, RAM, process lists) are intentionally removed from the Worker payload because they require the Node-only `systeminformation` package.

Notes about Node-only behavior and restoring native features
- The project keeps native dependencies in `optionalDependencies` (local development) but they are not included in the Worker bundle. Do NOT add native modules to runtime dependencies intended for Workers.
- To re-enable full Node-only behavior (local server with `sharp` / `systeminformation`):
  1. Use a Node-only environment (not a Worker edge runtime).
  2. Reinstall native packages if needed:
     - npm install --save-optional sharp systeminformation
  3. Reintroduce the Node-specific startup and system calls described in [`index.js`](index.js:1)'s comments:
     - Import and call `systeminformation` (e.g. const si = await import('systeminformation'); const mem = await si.mem();)
     - If you need sharp-based image parsing, import `sharp` in the Node runtime and call it instead of the Worker parser.
  4. Run the Node server (previous behavior used a stdio-based MCP server). See the comments inside [`index.js`](index.js:1) for exact guidance on the removed sections to restore.

Why these changes
- Cloudflare Workers (and many edge runtimes) cannot load native Node modules or rely on Node-only APIs (fs, child_process, process metrics). The Worker entrypoint uses only Web APIs (fetch, ArrayBuffer, TextDecoder, atob/btoa, performance). The image parsing is implemented in pure JS header sniffing to keep the Worker bundle dependency-free and small.

Files to review
- [`workers/entry.js`](workers/entry.js:1) — Worker entry RPC handler (reads URL/base64, fetches via fetch(), converts to ArrayBuffer and uses `inspectImageBuffer`).
- [`workers/image-parser.js`](workers/image-parser.js:1) — Pure-JS PNG/JPEG parser.
- [`index.js`](index.js:1) — Library exports safe for importing into Worker builds; Node-only behavior is documented and commented out.
- [`package.json`](package.json:1) — build script and devDependencies (esbuild) are present.
- [`wrangler.toml`](wrangler.toml:1) — points to `dist/worker.js` and has compatibility_date set.

If you want, I can:
- Run a quick lint-style pass to remove any leftover Node-only globals from bundle candidates, or
- Add a minimal GitHub Actions workflow that builds and validates the Worker bundle (esbuild + basic node-based smoke tests).