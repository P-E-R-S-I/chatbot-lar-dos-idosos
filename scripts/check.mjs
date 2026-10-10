import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function files(directory) {
  return readdirSync(directory).flatMap(name => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}
for (const file of [...files('backend'), ...files('src'), ...files('scripts')].filter(path => path.endsWith('.mjs'))) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(1);
}
if (!readFileSync('content/documento.md', 'utf8').trim()) throw new Error('Documento institucional vazio');
const toml = readFileSync('netlify.toml', 'utf8');
if (!toml.includes('"content/documento.md"')) throw new Error('Documento ausente do bundle de funções');
console.log('Funções Netlify e documento institucional validados. Nenhuma API foi chamada.');
