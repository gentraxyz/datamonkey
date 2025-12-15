/*
workers/image-parser.js
Pure-JS image header parser for Cloudflare Workers.

This file replaces the Node-native 'sharp' usage for lightweight image
inspection inside a Worker. It only reads image header bytes (no pixel
decoding) to detect PNG and JPEG and extract width/height and MIME-type.

Why removed native modules:
- Cloudflare Workers cannot load native Node modules (like sharp) or Node-only
  APIs. This parser uses only ArrayBuffer, DataView and Web APIs available in
  Workers, making the runtime deterministic and dependency-free.
*/

export function uint8ArrayFromBase64(base64) {
  // Accept data URI or raw base64
  const comma = base64.indexOf(',');
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

export function parsePNG(buf) {
  // buf: Uint8Array or ArrayBuffer
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
  if (bytes.length < 24) return null;
  // PNG signature
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < sig.length; i++) if (bytes[i] !== sig[i]) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // IHDR chunk starts at offset 8: length(4) 'IHDR'(4) then data
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

const JPEG_SOF_MARKERS = new Set([
  0xC0, 0xC1, 0xC2, 0xC3,
  0xC5, 0xC6, 0xC7,
  0xC9, 0xCA, 0xCB,
  0xCD, 0xCE, 0xCF
]);

export function parseJPEG(buf) {
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
  if (bytes.length < 4) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // SOI marker 0xFFD8
  if (view.getUint8(0) !== 0xFF || view.getUint8(1) !== 0xD8) return null;
  let offset = 2;
  while (offset < view.byteLength) {
    // Find marker (0xFF, marker)
    if (view.getUint8(offset) !== 0xFF) {
      offset++;
      continue;
    }
    // Skip padding FF bytes
    let marker = view.getUint8(offset + 1);
    while (marker === 0xFF) {
      offset++;
      marker = view.getUint8(offset + 1);
    }
    offset += 2;
    // Markers without length: 0xD8 (SOI) and 0xD9 (EOI) already handled; others have length
    if (marker === 0xD9) break;
    if (offset + 2 > view.byteLength) break;
    const segLen = readUint16BE(view, offset);
    if (segLen < 2) return null;
    // If this is a SOF marker, parse height/width
    if (JPEG_SOF_MARKERS.has(marker)) {
      // segment structure: length(2) | precision(1) | height(2) | width(2) | ...
      if (offset + 5 >= view.byteLength) return null;
      const precision = view.getUint8(offset + 2);
      const height = readUint16BE(view, offset + 3);
      const width = readUint16BE(view, offset + 5);
      return { format: "jpeg", width: Number(width), height: Number(height) };
    }
    // Move to next segment (segLen includes the two length bytes)
    offset += segLen;
  }
  return null;
}

/*
Main exported helper: accepts an ArrayBuffer or Uint8Array and returns:
{ format: 'png'|'jpeg'|'unknown', width: number|null, height: number|null, size: number }
*/
export function inspectImageBuffer(arrayBufferOrUint8) {
  const bytes = arrayBufferOrUint8 instanceof Uint8Array
    ? arrayBufferOrUint8
    : new Uint8Array(arrayBufferOrUint8);
  const size = bytes.byteLength;
  const png = parsePNG(bytes);
  if (png) return { format: "png", width: png.width, height: png.height, size };
  const jpg = parseJPEG(bytes);
  if (jpg) return { format: "jpeg", width: jpg.width, height: jpg.height, size };
  return { format: "unknown", width: null, height: null, size };
}