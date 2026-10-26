import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const html = fs.readFileSync('index.html', 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
for (const [i, m] of scripts.entries()) {
  try { new Function(m[1]); console.log(`Script ${i + 1} do frontend: sintaxe OK (${m[1].length} chars)`); }
  catch (e) { console.log(`ERRO no script ${i + 1}:`, e.message); process.exit(1); }
}

import(pathToFileURL(path.resolve('worker/src/index.js')).href)
  .then(() => console.log('Worker: módulo carregado OK'))
  .catch(e => { console.log('Worker ERRO:', e.message); process.exit(1); });
