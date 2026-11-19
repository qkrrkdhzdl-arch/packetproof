/*
 * zip.js — read and write ZIP archives in the browser, with no dependencies.
 *
 * Reading walks the central directory (not the local headers), so archives
 * produced by macOS "Compress", Windows Explorer, 7-Zip and JSZip all parse
 * the same way, including those that use data descriptors (bit 3 of the flags).
 * Stored (method 0) entries are sliced out; deflated (method 8) entries go
 * through the browser's own DecompressionStream("deflate-raw"), so no
 * third-party inflate code is shipped.
 */

const EOCD = 0x06054b50;
const CEN = 0x02014b50;
const LOC = 0x04034b50;

const utf8 = new TextDecoder('utf-8');

export class ZipError extends Error {}

/** List and decompress every entry of a ZIP archive. */
export async function readZip(buffer) {
  const bytes = toBytes(buffer);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(dv, bytes.length);
  if (eocd < 0) throw new ZipError('not a ZIP archive (no end-of-central-directory record)');

  const total = dv.getUint16(eocd + 10, true);
  const cenSize = dv.getUint32(eocd + 12, true);
  const cenOff = dv.getUint32(eocd + 16, true);
  // ZIP64 keeps the real numbers in its own records; refuse rather than guess.
  if (total === 0xffff || cenSize === 0xffffffff || cenOff === 0xffffffff) {
    throw new ZipError('ZIP64 archives are not supported');
  }

  const out = [];
  let p = cenOff;
  for (let i = 0; i < total; i++) {
    if (p + 46 > bytes.length || dv.getUint32(p, true) !== CEN) {
      throw new ZipError('corrupt central directory');
    }
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true);
    const elen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    const name = utf8.decode(bytes.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + elen + clen;

    if (name.endsWith('/')) {
      out.push({ name, dir: true, data: new Uint8Array(0), size: 0 });
      continue;
    }
    if (lho + 30 > bytes.length || dv.getUint32(lho, true) !== LOC) {
      throw new ZipError(`corrupt local header for ${name}`);
    }
    const lnlen = dv.getUint16(lho + 26, true);
    const lelen = dv.getUint16(lho + 28, true);
    const start = lho + 30 + lnlen + lelen;
    if (start + csize > bytes.length) throw new ZipError(`truncated entry ${name}`);
    const raw = bytes.subarray(start, start + csize);

    let data;
    if (method === 0) data = raw.slice();
    else if (method === 8) data = await inflateRaw(raw);
    else throw new ZipError(`unsupported compression method ${method} for ${name}`);

    out.push({ name, dir: false, data, size: usize || data.length, flags });
  }
  return out;
}

/** Inflate raw DEFLATE bytes using the platform stream. */
export async function inflateRaw(bytes) {
  if (typeof DecompressionStream === 'undefined') {
    throw new ZipError('this browser has no DecompressionStream');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Deflate bytes (used by the fixtures in tests.js). */
export async function deflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Build a ZIP archive in memory.
 * entries: [{ name, text? , bytes?, store?: boolean }]
 */
export async function makeZip(entries) {
  const encoder = new TextEncoder();
  const files = [];
  let offset = 0;
  const chunks = [];

  for (const e of entries) {
    const data = e.bytes || encoder.encode(e.text ?? '');
    const store = e.store ?? false;
    const body = store ? data : await deflateRaw(data);
    const nameBytes = encoder.encode(e.name);
    const crc = crc32(data);

    const local = new Uint8Array(30 + nameBytes.length);
    const ldv = new DataView(local.buffer);
    ldv.setUint32(0, LOC, true);
    ldv.setUint16(4, 20, true);
    ldv.setUint16(6, 0x0800, true); // UTF-8 names
    ldv.setUint16(8, store ? 0 : 8, true);
    ldv.setUint32(14, crc, true);
    ldv.setUint32(18, body.length, true);
    ldv.setUint32(22, data.length, true);
    ldv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);

    files.push({ nameBytes, crc, csize: body.length, usize: data.length, offset, store });
    chunks.push(local, body);
    offset += local.length + body.length;
  }

  const cenParts = [];
  let cenLen = 0;
  for (const f of files) {
    const rec = new Uint8Array(46 + f.nameBytes.length);
    const d = new DataView(rec.buffer);
    d.setUint32(0, CEN, true);
    d.setUint16(4, 20, true);
    d.setUint16(6, 20, true);
    d.setUint16(8, 0x0800, true);
    d.setUint16(10, f.store ? 0 : 8, true);
    d.setUint32(16, f.crc, true);
    d.setUint32(20, f.csize, true);
    d.setUint32(24, f.usize, true);
    d.setUint16(28, f.nameBytes.length, true);
    d.setUint32(42, f.offset, true);
    rec.set(f.nameBytes, 46);
    cenParts.push(rec);
    cenLen += rec.length;
  }

  const eocdRec = new Uint8Array(22);
  const edv = new DataView(eocdRec.buffer);
  edv.setUint32(0, EOCD, true);
  edv.setUint16(8, files.length, true);
  edv.setUint16(10, files.length, true);
  edv.setUint32(12, cenLen, true);
  edv.setUint32(16, offset, true);

  const all = [...chunks, ...cenParts, eocdRec];
  const total = all.reduce((n, c) => n + c.length, 0);
  const archive = new Uint8Array(total);
  let at = 0;
  for (const c of all) { archive.set(c, at); at += c.length; }
  return archive;
}

function findEocd(dv, length) {
  const floor = Math.max(0, length - 0xffff - 22);
  for (let i = length - 22; i >= floor; i--) {
    if (dv.getUint32(i, true) === EOCD) return i;
  }
  return -1;
}

let crcTable = null;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function toBytes(buffer) {
  if (buffer instanceof Uint8Array) return buffer;
  if (buffer instanceof ArrayBuffer) return new Uint8Array(buffer);
  if (ArrayBuffer.isView(buffer)) return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  throw new ZipError('expected an ArrayBuffer or Uint8Array');
}
