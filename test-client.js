#!/usr/bin/env node
// test-client.js — HTTP test client for the Worker RPC endpoints
//
// This replaces the old stdio-based harness which spawned a local Node
// process (node index.js) and communicated over stdin/stdout. That approach
// relied on Node-only process APIs and native modules (e.g. sharp, systeminformation).
//
// New behavior:
// - Sends JSON RPC-style POST requests to the Worker HTTP endpoint provided
//   on the command line or via the WORKER_URL environment variable.
// - Prints formatted JSON responses to stdout.
//
// Requirements:
// - Requires Node 18+ (global fetch). If using older Node, provide a fetch polyfill
//   (for example: node --experimental-fetch or install 'node-fetch' and run a small loader).
//   This script explicitly avoids child_process/readline usages so it is portable
//   and safe to run outside a Node-only environment.
//
// Usage:
//   node test-client.js https://<YOUR_WORKER_URL>
//   or
//   WORKER_URL=https://<YOUR_WORKER_URL> node test-client.js
//
// Example payloads sent (JSON):
//   { "id": 1, "method": "get_system_status", "params": {} }
//   { "id": 2, "method": "inspect_image_asset", "params": { "url": "https://example.com/img.jpg" } }
//
// Notes on removed runtime deps:
// - sharp and systeminformation were removed from runtime "dependencies" because they
//   rely on native Node APIs and native binaries which are incompatible with Cloudflare
//   Workers and other edge runtimes. If you still need them for local Node-only testing,
//   install them locally with `npm install --save-optional sharp systeminformation` or
//   re-add them to a Node-only package.json used for local testing. They are intentionally
//   not part of the Worker runtime build to keep the Worker bundle portable.
//
// This file is ESM and uses only portable APIs (process.env / fetch).

const target = process.argv[2] || process.env.WORKER_URL;

if (!target) {
  console.error("Usage: node test-client.js https://<YOUR_WORKER_URL>");
  console.error("Or set WORKER_URL environment variable.");
  process.exit(1);
}

const baseUrl = target.replace(/\/$/, ""); // strip trailing slash
let nextId = 1;

/**
 * Perform a JSON-RPC style POST to the Worker.
 * Assumes Worker accepts JSON bodies in the shape { id, method, params }.
 */
async function rpc(method, params = {}) {
  const id = nextId++;
  const payload = { id, method, params };
  const url = baseUrl; // send to root; adjust if your Worker expects a specific path

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const text = await res.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { httpStatus: res.status, body: text };
    }

    const out = {
      request: payload,
      response: parsed,
      httpStatus: res.status,
    };
    console.log(JSON.stringify(out, null, 2));
    return parsed;
  } catch (err) {
    console.error("Network or fetch error:", err && err.message);
    throw err;
  }
}

async function runExamples() {
  console.log("Calling get_system_status...");
  await rpc("get_system_status", {});

  console.log("\nCalling inspect_image_asset with an example URL...");
  await rpc("inspect_image_asset", {
    // Replace with a publicly accessible image URL for real testing
    url: "https://example.com/image.jpg",
  });
}

runExamples().catch((err) => {
  console.error("Error running test client:", err && err.message);
  process.exit(1);
});