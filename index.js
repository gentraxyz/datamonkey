/*
Run: npm install && npm start
This entrypoint used to provide a stdio MCP server for Node. It has been
refactored so its core functionality can be invoked as plain async functions
from a Cloudflare Worker (or any ESM-compatible environment) without using
Node-only APIs (fs, path, readline, child_process, process, os, systeminformation,
sharp, etc).

Notes:
- Node-only behavior (stdio loop, process lifecycle handlers, native modules)
  has been removed and replaced with comments / safe fallbacks so the module
  can be imported in Worker builds.
- If you need the original Node stdio server behavior, see the inline comments
  pointing to the removed sections and how to restore them.
*/

const ok = (data) => ({ success: true, data });
const fail = (message) => ({ success: false, error: String(message) });

function normalizeFormat(format) {
  if (!format) return format;
  const f = String(format).toLowerCase();
  if (f === "jpeg" || f === "jpg") return "jpg";
  if (f === "png") return "png";
  return f;
}

/* =========================================================================
   Compatibility shims & removed Node-specific blocks

   The original file imported Node-only APIs and started a long-lived stdin/stdout
   MCP server loop. Those blocks were removed so the remaining exports are safe
   to import in Cloudflare Workers and other non-Node runtimes.

   Removed imports (original lines: index.js:9-11):
     import fs from "fs/promises";
     import path from "path";
     import readline from "readline";
   Reason: Workers cannot use Node fs/path/readline. To restore Node behavior,
   re-add these imports and the server startup (see removed main() below).

   Removed process lifecycle handlers and shutdown (original lines: index.js:29-38, 40-62):
     process.on("unhandledRejection", ...)
     process.on("uncaughtException", ...)
     async function shutdown(signal) { ... }
     process.on("SIGINT", ...) etc
   Replacement: We throw Errors for fatal conditions. To restore:
     re-add process.on handlers and call process.exit as before.

   Removed fallback stdio transport and MCP server implementation (original lines: index.js:64-148)
   Reason: These classes use process.stdin/process.stdout and readline which are Node-specific.
   To restore: re-create the classes from the original file and wire up server.start().

   Removed SDK loading, dynamic 'main' startup and tool registration (original lines: index.js:150-394,
   plus SDKLooksLikeTransport and final await main() lines: index.js:396-406).
   Reason: Those perform dynamic imports of 'sharp', 'systeminformation', and the MCP SDK,
   and they register handlers into a long-lived server. Those were removed and replaced
   with exported plain functions below.

   IMPORTANT: All removed sections are preserved in source control history (or in your
   original backup). If you need the exact original code, refer to the previous version
   and reintroduce the blocks noted above.
   ========================================================================= */

/* Helper: compute approximate byte size of a base64 data string without decoding.
   Accepts either a raw base64 string or a data URI with a comma.
*/
function base64ByteSize(base64) {
  if (!base64 || typeof base64 !== "string") return 0;
  const comma = base64.indexOf(",");
  const s = comma >= 0 ? base64.slice(comma + 1) : base64;
  if (!s) return 0;
  // Count padding
  const padding = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  return Math.floor((s.length * 3) / 4) - padding;
}

/* Helper: convert an ArrayBuffer to a base64 data URI.
   Uses Web APIs available in Workers (btoa). If btoa is not available in the
   host environment, this will throw — that's intentional to avoid pulling Node
   polyfills into the Worker build.
*/
function arrayBufferToBase64DataUri(arrayBuffer, mime = "application/octet-stream") {
  const bytes = new Uint8Array(arrayBuffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    // String.fromCharCode on a typed array works in Workers
    binary += String.fromCharCode.apply(null, chunk);
  }
  // btoa is available in Cloudflare Workers; in Node it may not be available depending on version
  const b64 = btoa(binary);
  return `data:${mime};base64,${b64}`;
}

/*
export async function inspectImageAsset(params)

- Accepts: { url?: string, base64?: string }
- Must NOT use Node-only APIs (no fs, no sharp).
- Behavior:
  - If params.base64 is provided, returns an object containing the base64 data (unchanged),
    its computed size in bytes, and placeholders for metadata (format,width,height) so the
    caller (Worker) can delegate actual parsing to its own parser (e.g. workers/image-parser.js).
  - If params.url is provided and global fetch is available (Worker), the function will fetch
    the resource, convert to a base64 data URI, and return it along with size, letting the
    caller perform header parsing.
  - If fetch is not available in this environment, the function returns a failure describing
    that fetch is unavailable.
*/
export async function inspectImageAsset(params) {
  if (!params || (typeof params.url !== "string" && typeof params.base64 !== "string")) {
    throw new Error("inspectImageAsset requires either params.url (string) or params.base64 (string).");
  }

  // Handle base64 input: return raw base64 and size so caller can parse headers
  if (typeof params.base64 === "string") {
    const b64 = params.base64;
    const size = base64ByteSize(b64);
    return ok({
      // NOTE: We intentionally do not re-parse headers here. The Worker environment
      // already has a small, pure-JS parser (workers/image-parser.js). To avoid
      // duplicating parsing logic and avoid native modules like 'sharp', we return
      // the raw base64 and size so the caller can decode/inspect it.
      source: "base64",
      base64: b64,
      size,
      // metadata placeholders: format,width,height left null to indicate parsing is required
      format: null,
      width: null,
      height: null,
    });
  }

  // Handle URL input: attempt to fetch and return base64 + size.
  if (typeof params.url === "string") {
    if (typeof fetch !== "function") {
      // fetch is not available in this environment (typical Node <18). We purposely
      // avoid pulling in node-fetch so this module stays Worker-friendly.
      return fail("fetch() is unavailable in this environment. In Node, reintroduce a fetch polyfill or fetch externally.");
    }

    try {
      const resp = await fetch(params.url);
      if (!resp.ok) {
        return fail(`Failed to fetch URL: ${resp.status} ${resp.statusText}`);
      }
      const arrayBuffer = await resp.arrayBuffer();
      const contentType = resp.headers ? (resp.headers.get && resp.headers.get("content-type")) || null : null;
      const dataUri = arrayBufferToBase64DataUri(arrayBuffer, contentType || "application/octet-stream");
      const size = arrayBuffer.byteLength;
      return ok({
        source: "url",
        url: params.url,
        base64: dataUri,
        size,
        format: null,
        width: null,
        height: null,
        mime: contentType,
      });
    } catch (err) {
      return fail(`Failed to fetch or read URL: ${err && err.message ? err.message : String(err)}`);
    }
  }

  // Should not reach here
  return fail("Invalid parameters for inspectImageAsset");
}

/*
export async function getSystemStatus(params)

- Returns lightweight, Worker-compatible status info only.
- Removed Node-only 'systeminformation' calls (original lines: index.js:185-189, 314-341).
  Those calls were used to populate cpu, memory, and process lists.
  To restore full Node behavior, re-import 'systeminformation' and reintroduce the logic:
    const si = await import('systeminformation');
    const loadData = await si.currentLoad();
    const mem = await si.mem();
    const procData = await si.processes();
  This file returns a descriptive placeholder so Workers can show basic runtime info.
*/
export async function getSystemStatus(/* params */) {
  const start = (globalThis.performance && performance.now && performance.now()) || Date.now();
  const timestamp = Date.now();
  const end = (globalThis.performance && performance.now && performance.now()) || Date.now();
  const requestDurationMs = Math.max(0, Math.round((end - start) * 100) / 100);

  // Worker-compatible minimal payload
  const result = {
    timestamp,
    requestDurationMs,
    // Indicate this was built to be Worker-compatible; in Node you might return "Node.js"
    runtime: typeof globalThis?.process === "undefined" ? "Cloudflare Worker (or Web-like runtime)" : "Unknown (non-Worker)",
    // envBindings is Worker-specific; populate if caller provides env-like object via params (not implemented here)
    envBindings: [],
    // The original implementation used 'systeminformation' to provide:
    //   - cpu.loadPercent, memory.total/free/used, and a list of javaProcesses
    // Those values have been removed to keep this module portable to Workers.
    // TODO: If running in Node and you need full system info, import 'systeminformation'
    // and populate cpu/memory/javaProcesses as in the previous implementation.
    note: "Detailed system metrics removed for portability. To restore in Node, import 'systeminformation' and re-add the original calls.",
  };

  return ok(result);
}

/* Export a small helper set for callers that want to reuse normalization logic */
export { normalizeFormat };

/* End of module.
   Removed the SDK-based MCP server startup and tool registration so this file
   only exposes plain async functions that accept JSON-like params and return
   serializable results.

   Removed sections (for reference to original file):
   - Imports removed: index.js:9-11
   - Process handlers + shutdown: index.js:29-38, 40-62
   - FallbackStdioTransport and FallbackMCPServer: index.js:71-148
   - Dynamic imports of zod/sharp/systeminformation + SDK loading + tool registration + main(): index.js:154-394
   - SDKLooksLikeTransport and final await main(): index.js:396-406

   Recommended next steps:
   - In your Worker code (workers/entry.js), call these exported functions or directly
     use the Worker-local parser (workers/image-parser.js) to decode the returned base64
     payloads and extract format/width/height/size.
   - If you need to keep the Node stdio MCP server, reintroduce the removed main()
     and classes and restore the process.on handlers; see the original file history.
*/