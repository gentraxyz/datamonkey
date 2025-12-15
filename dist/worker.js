// workers/image-parser.js
function uint8ArrayFromBase64(base64) {
  const comma = base64.indexOf(",");
  const b64 = comma >= 0 ? base64.slice(comma + 1) : base64;
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}
function readUint16BE(view, offset) {
  return view.getUint16(offset, false);
}
function readUint32BE(view, offset) {
  return view.getUint32(offset, false);
}
function parsePNG(buf) {
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
  if (bytes.length < 24) return null;
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < sig.length; i++) if (bytes[i] !== sig[i]) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunkTypeOffset = 12;
  const type = String.fromCharCode(
    view.getUint8(chunkTypeOffset),
    view.getUint8(chunkTypeOffset + 1),
    view.getUint8(chunkTypeOffset + 2),
    view.getUint8(chunkTypeOffset + 3)
  );
  if (type !== "IHDR") return null;
  const width = readUint32BE(view, 16);
  const height = readUint32BE(view, 20);
  return { format: "png", width: Number(width), height: Number(height) };
}
var JPEG_SOF_MARKERS = /* @__PURE__ */ new Set([
  192,
  193,
  194,
  195,
  197,
  198,
  199,
  201,
  202,
  203,
  205,
  206,
  207
]);
function parseJPEG(buf) {
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
  if (bytes.length < 4) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== 255 || view.getUint8(1) !== 216) return null;
  let offset = 2;
  while (offset < view.byteLength) {
    if (view.getUint8(offset) !== 255) {
      offset++;
      continue;
    }
    let marker = view.getUint8(offset + 1);
    while (marker === 255) {
      offset++;
      marker = view.getUint8(offset + 1);
    }
    offset += 2;
    if (marker === 217) break;
    if (offset + 2 > view.byteLength) break;
    const segLen = readUint16BE(view, offset);
    if (segLen < 2) return null;
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (offset + 5 >= view.byteLength) return null;
      const precision = view.getUint8(offset + 2);
      const height = readUint16BE(view, offset + 3);
      const width = readUint16BE(view, offset + 5);
      return { format: "jpeg", width: Number(width), height: Number(height) };
    }
    offset += segLen;
  }
  return null;
}
function inspectImageBuffer(arrayBufferOrUint8) {
  const bytes = arrayBufferOrUint8 instanceof Uint8Array ? arrayBufferOrUint8 : new Uint8Array(arrayBufferOrUint8);
  const size = bytes.byteLength;
  const png = parsePNG(bytes);
  if (png) return { format: "png", width: png.width, height: png.height, size };
  const jpg = parseJPEG(bytes);
  if (jpg) return { format: "jpeg", width: jpg.width, height: jpg.height, size };
  return { format: "unknown", width: null, height: null, size };
}

// workers/entry.js
function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
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
async function inspectFromUrl(url) {
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
  const contentType = resp.headers.get("content-type") || null;
  const mime = inspected.format === "png" ? "image/png" : inspected.format === "jpeg" ? "image/jpeg" : contentType;
  return {
    format: inspected.format === "unknown" ? "unknown" : inspected.format,
    width: inspected.width,
    height: inspected.height,
    size: buffer.byteLength ?? null,
    mime
  };
}
function inspectFromBase64(base64) {
  const bytes = uint8ArrayFromBase64(base64);
  const inspected = inspectImageBuffer(bytes);
  return {
    format: inspected.format === "unknown" ? "unknown" : inspected.format,
    width: inspected.width,
    height: inspected.height,
    size: inspected.size,
    mime: inspected.format === "png" ? "image/png" : inspected.format === "jpeg" ? "image/jpeg" : null
  };
}
var handler = {
  async fetch(request, env) {
    const start = globalThis.performance && performance.now && performance.now() || Date.now();
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
        if (!params || typeof params.url !== "string" && typeof params.base64 !== "string") {
          return jsonResponse({ ok: false, error: "inspect_image_asset requires either 'url' or 'base64' param" }, 400);
        }
        try {
          let result;
          if (typeof params.url === "string") {
            result = await inspectFromUrl(params.url);
          } else {
            result = inspectFromBase64(params.base64);
          }
          const duration = globalThis.performance && performance.now && performance.now() - start || Date.now() - start;
          return jsonResponse({ ok: true, result }, 200);
        } catch (err) {
          const status = err && err.status ? err.status : 400;
          const message = err && err.message ? err.message : String(err);
          return jsonResponse({ ok: false, error: message }, status);
        }
      }
      if (method === "get_system_status") {
        const end = globalThis.performance && performance.now && performance.now() || Date.now();
        const requestDurationMs = Math.max(0, Math.round((end - start) * 100) / 100);
        const envBindings = env && typeof env === "object" ? Object.keys(env).filter(Boolean) : [];
        const result = {
          timestamp: Date.now(),
          requestDurationMs,
          runtime: "Cloudflare Worker",
          envBindings
        };
        return jsonResponse({ ok: true, result }, 200);
      }
      return jsonResponse({ ok: false, error: "unknown method" }, 400);
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      return jsonResponse({ ok: false, error: `Internal error: ${message}` }, 500);
    }
  }
};
var entry_default = handler;
if (typeof globalThis !== "undefined" && !globalThis.fetch) {
  globalThis.fetch = (request, env) => handler.fetch(request, env);
}
export {
  entry_default as default
};
