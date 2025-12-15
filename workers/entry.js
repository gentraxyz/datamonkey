/*
workers/entry.js

Cloudflare Worker entrypoint providing a minimal RPC over HTTP POST.
- Exports a default fetch handler.
- Accepts only POST with JSON body: { "method": "<methodName>", "params": { ... } }.
- Implements two RPCs:
  - "inspect_image_asset": accepts { url } or { base64 } and returns format/width/height/size.
  - "get_system_status": returns Worker-compatible runtime info.

Notes on native modules:
- Original Node code used native modules (sharp, systeminformation) which cannot run in
  Cloudflare Workers. This file (and workers/image-parser.js) replace native image
  parsing with a tiny pure-JS header parser and return limited system info suitable
  for Workers. No native or Node-only APIs are used here; only Web APIs available in
  Cloudflare Workers (fetch, ArrayBuffer, TextDecoder, atob, performance).
*/

import { inspectImageBuffer, uint8ArrayFromBase64 } from "./image-parser.js";

/* Helper: JSON response */
function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/* Validate that the request has a JSON body and parse it */
async function parseJsonRequest(request) {
  const ct = request.headers.get("content-type") || "";
  if (!ct.includes("application/json")) {
    throw { status: 400, message: "Content-Type must be application/json" };
  }
  let payload;
  try {
    payload = await request.json();
  } catch (err) {
    throw { status: 400, message: "Invalid JSON body" };
  }
  return payload;
}

/* Inspect image from fetched URL (uses fetch available in Workers) */
async function inspectFromUrl(url) {
  // Basic URL validation
  try {
    new URL(url);
  } catch {
    throw { status: 400, message: "Invalid URL" };
  }

  const resp = await fetch(url);
  if (!resp.ok) {
    throw { status: 400, message: `Failed to fetch resource: ${resp.status} ${resp.statusText}` };
  }
  const buffer = await resp.arrayBuffer();
  const inspected = inspectImageBuffer(buffer);
  // Try to populate mime-type from response headers if unknown
  const contentType = resp.headers.get("content-type") || null;
  const mime = inspected.format === "png" ? "image/png" : inspected.format === "jpeg" ? "image/jpeg" : contentType;
  return {
    format: inspected.format === "unknown" ? "unknown" : inspected.format,
    width: inspected.width,
    height: inspected.height,
    size: buffer.byteLength ?? null,
    mime: mime,
  };
}

/* Inspect image from base64 string */
function inspectFromBase64(base64) {
  // Accept data URI or raw base64
  const bytes = uint8ArrayFromBase64(base64);
  const inspected = inspectImageBuffer(bytes);
  return {
    format: inspected.format === "unknown" ? "unknown" : inspected.format,
    width: inspected.width,
    height: inspected.height,
    size: inspected.size,
    mime: inspected.format === "png" ? "image/png" : inspected.format === "jpeg" ? "image/jpeg" : null,
  };
}

export default {
  async fetch(request, env) {
    const start = (globalThis.performance && performance.now && performance.now()) || Date.now();
    try {
      if (request.method !== "POST") {
        return jsonResponse({ ok: false, error: "Only POST requests are allowed" }, 405);
      }

      let body;
      try {
        body = await parseJsonRequest(request);
      } catch (err) {
        return jsonResponse({ ok: false, error: err.message || "Invalid request" }, err.status || 400);
      }

      const method = body && body.method;
      const params = body && body.params;

      if (!method || typeof method !== "string") {
        return jsonResponse({ ok: false, error: "Missing or invalid 'method' field" }, 400);
      }

      if (method === "inspect_image_asset") {
        if (!params || (typeof params.url !== "string" && typeof params.base64 !== "string")) {
          return jsonResponse({ ok: false, error: "inspect_image_asset requires either 'url' or 'base64' param" }, 400);
        }
        try {
          let result;
          if (typeof params.url === "string") {
            result = await inspectFromUrl(params.url);
          } else {
            result = inspectFromBase64(params.base64);
          }
          const duration = (globalThis.performance && performance.now && performance.now() - start) || (Date.now() - start);
          return jsonResponse({ ok: true, result }, 200);
        } catch (err) {
          const status = err && err.status ? err.status : 400;
          const message = err && err.message ? err.message : String(err);
          return jsonResponse({ ok: false, error: message }, status);
        }
      }

      if (method === "get_system_status") {
        // Worker-compatible info — do not attempt to call Node-only system libs.
        const end = (globalThis.performance && performance.now && performance.now()) || Date.now();
        const requestDurationMs = Math.max(0, Math.round((end - start) * 100) / 100);
        const envBindings = env && typeof env === "object" ? Object.keys(env).filter(Boolean) : [];
        const result = {
          timestamp: Date.now(),
          requestDurationMs,
          runtime: "Cloudflare Worker",
          envBindings,
        };
        return jsonResponse({ ok: true, result }, 200);
      }

      // Unknown method
      return jsonResponse({ ok: false, error: "unknown method" }, 400);
    } catch (err) {
      // Catch-all
      const message = err && err.message ? err.message : String(err);
      return jsonResponse({ ok: false, error: `Internal error: ${message}` }, 500);
    }
  },
};