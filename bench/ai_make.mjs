import zlib from 'node:zlib';
import fs from 'node:fs';
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const table = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  let crc = 0xffffffff; for (const b of td) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  const c = Buffer.alloc(4); c.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([len, td, c]);
}
const w = 8, h = 8;
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w,0); ihdr.writeUInt32BE(h,4); ihdr[8]=8; ihdr[9]=2;
const rows = [];
for (let y = 0; y < h; y++) { rows.push(Buffer.from([0])); for (let x = 0; x < w; x++) rows.push(Buffer.from([(x*32)%256, (y*32)%256, 128])); }
const idat = zlib.deflateSync(Buffer.concat(rows));
const params = 'masterpiece, best quality, ultra detailed, 1girl, silver hair, blue eyes, hanfu, cherry blossoms\nNegative prompt: lowres, bad anatomy, worst quality, watermark, signature\nSteps: 32, Sampler: DPM++ 2M Karras, CFG scale: 6.5, Seed: 20261120, Size: 896x1152, Model: animagineXL_v31, Model hash: 9f2b1a, Clip skip: 2';
const png = Buffer.concat([
  Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),
  chunk('IHDR', ihdr),
  chunk('tEXt', Buffer.from('parameters\0' + params, 'latin1')),
  chunk('tEXt', Buffer.from('Software\0ComfyUI', 'latin1')),
  chunk('IDAT', idat),
  chunk('IEND', Buffer.alloc(0))
]);
fs.writeFileSync('/tmp/fishtest/ai-test.png', png);
console.log('wrote ai-test.png', png.length);
