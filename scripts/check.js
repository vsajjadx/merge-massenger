const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? files(file) : file.endsWith('.js') ? [file] : [];
  });
}
const sources = [...files(path.join(__dirname, '..', 'src')), ...files(__dirname)];
for (const file of sources) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`Syntax checked ${sources.length} JavaScript files.`);
