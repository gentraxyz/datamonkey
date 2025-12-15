# datamonkey-mcp-sensory

Badges
- build: ![build](https://img.shields.io/badge/build-esbuild-blue)
- runtime: ![worker](https://img.shields.io/badge/runtime-Cloudflare%20Worker-lightgrey)
- license: ![MIT](https://img.shields.io/badge/license-MIT-green)

Summary
A small MCP (Model Context Protocol) sensory service implemented for Cloudflare Workers. Provides lightweight image inspection (format, width, height, size) and a worker-compatible system status RPC. The Worker is dependency-free at runtime and uses a pure-JS header parser to remain portable.

Features
- inspect_image_asset: Inspect image headers from a URL or base64 (format, width, height, size). See implementation: [`workers/entry.js`](workers/entry.js:8) and [`workers/image-parser.js`](workers/image-parser.js:105).
- get_system_status: returns timestamp, runtime, request duration and env binding names — Worker-friendly only ([`workers/entry.js`](workers/entry.js:127)).
- No native modules in runtime — native-only libs are optional for local Node tests (`sharp`, `systeminformation`) ([`package.json`](package.json:20-24)).

Quick start / Install
```bash
# Install dependencies
npm install

# Build Worker bundle (uses esbuild)
npm run build  # runs the esbuild command that bundles workers/entry.js -> dist/worker.js (see package.json)
```

Usage (examples)
- Run a local Node-only server (legacy / optional):
```bash
npm start
# runs: node index.js
```
- Run the test client against a deployed Worker:
```bash
npm run test-client https://<YOUR_WORKER_URL>
# or
WORKER_URL=https://<YOUR_WORKER_URL> npm run test-client
```
(test-client code & examples: [`test-client.js`](test-client.js:19-26), entry for target: [`test-client.js`](test-client.js:38))

Example curl calls
- get_system_status:
```bash
curl -X POST https://<YOUR_WORKER_URL> \
  -H "Content-Type: application/json" \
  -d '{"id":1,"method":"get_system_status","params":{}}'
```
- inspect_image_asset (URL):
```bash
curl -X POST https://<YOUR_WORKER_URL> \
  -H "Content-Type: application/json" \
  -d '{"id":2,"method":"inspect_image_asset","params":{"url":"https://example.com/image.jpg"}}'
```
- inspect_image_asset (base64):
```bash
curl -X POST https://<YOUR_WORKER_URL> \
  -H "Content-Type: application/json" \
  -d '{"id":3,"method":"inspect_image_asset","params":{"base64":"data:image/png;base64,iVBORw0KG..."}}'
```
(These payload shapes match what [`workers/entry.js`](workers/entry.js:5-9,107-117) expects.)

API / Endpoints
- Method: POST / (root)
  - Body: application/json
  - Shape: { "id": <number>, "method": "<methodName>", "params": { ... } }
- Supported methods:
  - get_system_status — params: {}. Response: { ok: true, result: { timestamp, requestDurationMs, runtime, envBindings } } ([`workers/entry.js`](workers/entry.js:127-138)).
  - inspect_image_asset — params: { url?: string, base64?: string } — one required. Returns format, width, height, size, mime where available ([`workers/entry.js`](workers/entry.js:107-117), parsing logic in [`workers/image-parser.js`](workers/image-parser.js:105-115)).

Development
- Source
  - Worker entry: [`workers/entry.js`](workers/entry.js:1)
  - Lightweight image parser: [`workers/image-parser.js`](workers/image-parser.js:1)
  - Local/node harness / compatibility: [`test-client.js`](test-client.js:1)
- Scripts from [`package.json`](package.json:7-12)
  - npm run build — bundles Worker: `esbuild workers/entry.js --bundle --outfile=dist/worker.js --platform=browser --target=es2020` ([`package.json`](package.json:10)).
  - npm run deploy:wrangler — publishes via wrangler and runs the build step first ([`package.json`](package.json:11)).
  - npm run test-client — runs the test client against WORKER_URL ([`package.json`](package.json:8-11) and [`test-client.js`](test-client.js:38)).
- Notes on native modules:
  - `sharp` and `systeminformation` are in `optionalDependencies` for local Node-only tests and were intentionally removed from runtime dependencies to keep the Worker portable ([`package.json`](package.json:20-24)).

Testing
- Manual test-client:
```bash
# Run against a deployed Worker URL
WORKER_URL=https://<YOUR_WORKER_URL> npm run test-client
```
- Example outputs and payloads are implemented in [`test-client.js`](test-client.js:86-95).
- CI can run build and integration smoke tests that POST to a deployed stage URL (see example CI below).

Deployment
- Wrangler config points to the bundled output `dist/worker.js` — see [`wrangler.toml`](wrangler.toml:1-3).
- Build step:
```bash
npm run build
# produces dist/worker.js (input to wrangler publish)
```
- Publish:
```bash
npm run deploy:wrangler
# runs: wrangler publish --build "npm run build" (see package.json)
```
- Wrangler notes:
  - Current `wrangler.toml` sets name and main entry: [`wrangler.toml`](wrangler.toml:1-3). Add account_id, route, and environment sections as required by your Cloudflare account.

Contributing
- Keep runtime free of native Node modules — use `optionalDependencies` for local-only helpers.
- Follow the existing pattern: Worker-compatible code must use Web APIs only (fetch, ArrayBuffer, atob, performance). See the header comment in [`workers/entry.js`](workers/entry.js:11-16).

License
- MIT — see [`package.json`](package.json:28).

Contact / Maintainers
- Maintain comments and contact info in project README or repo metadata. For immediate testing, use the `test-client` included at [`test-client.js`](test-client.js:1).

Appendix / Implementation notes
- `inspectImageBuffer` in [`workers/image-parser.js`](workers/image-parser.js:105) is the single helper used by the Worker to detect PNG/JPEG headers and sizes without full decoding.
- Worker RPC handler and validation are implemented in [`workers/entry.js`](workers/entry.js:29-42,100-124).

Suggested badges and CI snippet
```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [ main ]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 18
      - name: Install
        run: npm ci
      - name: Build worker
        run: npm run build
      - name: Run test-client (smoke)
        env:
          WORKER_URL: ${{ secrets.STAGE_WORKER_URL }} # needs to point to a deployed test stage
        run: npm run test-client
  deploy:
    needs: build
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 18
      - name: Install
        run: npm ci
      - name: Publish to Cloudflare
        env:
          CF_API_TOKEN: ${{ secrets.CF_API_TOKEN }}
        run: npm run deploy:wrangler
```

Open questions / uncertainties
- `wrangler.toml` currently lacks account-specific fields (account_id, routes, environment configs). Confirm intended Cloudflare account and routing before CI publish ([`wrangler.toml`](wrangler.toml:1-3)).  
- Is [`index.js`](index.js:1) still required for Node-only fallback local testing, or can it be removed/archived? (`index.js` is listed as the package main in [`package.json`](package.json:6)).  
- If automated tests should run without a deployed Worker, add unit tests for [`workers/image-parser.js`](workers/image-parser.js:1) to validate parsing in CI.