// Post-build: writes maximum-quality .br and .gz siblings for text assets in web/dist,
// so the server can serve them pre-compressed (no per-request compression CPU).
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const root = path.resolve('web/dist');
const COMPRESSIBLE = /\.(js|css|html|svg|json|txt|map)$/;
let files = 0;
let before = 0;
let afterBr = 0;

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name);
    if (statSync(file).isDirectory()) walk(file);
    else if (COMPRESSIBLE.test(name)) {
      const data = readFileSync(file);
      if (data.length < 512) continue;
      const br = zlib.brotliCompressSync(data, {
        params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT },
      });
      writeFileSync(`${file}.br`, br);
      writeFileSync(`${file}.gz`, zlib.gzipSync(data, { level: 9 }));
      files++;
      before += data.length;
      afterBr += br.length;
    }
  }
}

walk(root);
console.log(`precompressed ${files} files: ${(before / 1024).toFixed(0)} KB → ${(afterBr / 1024).toFixed(0)} KB (brotli)`);
