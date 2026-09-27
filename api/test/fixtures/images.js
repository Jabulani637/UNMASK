'use strict';
/**
 * A genuine PNG and a genuine JPEG, both of which every stage that stores a
 * picture has to be able to accept.
 *
 * These are built rather than read from a file so a checkout of this repository
 * can run its tests without a binary in git. The PNG is a real one — a browser
 * renders it — because "the API stores what you gave it" is a claim about bytes,
 * and a header padded with zeros proves nothing about a decoder. The pixel data
 * is pseudo-random so it does not deflate down under the 1 KB floor the upload
 * route enforces.
 */

const zlib = require('node:zlib');

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(width = 40, height = 40) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour, no alpha

  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    for (let i = 1; i < row.length; i += 1) row[i] = (i * 37 + y * 11) % 251;
    rows.push(row);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows), { level: 0 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function jpeg() {
  const body = Buffer.alloc(2048, 0x5a);
  body[0] = 0xff;
  body[1] = 0xd8;
  body[2] = 0xff;
  body[body.length - 2] = 0xff;
  body[body.length - 1] = 0xd9;
  return body;
}

module.exports = { png, jpeg };
