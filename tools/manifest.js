'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const EXCLUDED_DIRS = new Set(['test', 'tools', 'logs', 'node_modules', '.git']);
const EXCLUDED_FILES = new Set(['manifest.json', '.gitignore', '.gitattributes', 'glossary.json', 'config.json', 'package-lock.json']);

function collect(dir, out) {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) collect(full, out);
    } else if (!EXCLUDED_FILES.has(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function build() {
  const files = {};
  const problems = [];
  for (const full of collect(root, [])) {
    const rel = path.relative(root, full).split(path.sep).join('/');
    const data = fs.readFileSync(full);
    if (data.includes(13)) problems.push(`${rel} contains CRLF line endings`);
    files[rel] = crypto.createHash('sha256').update(data).digest('hex');
  }
  return { manifest: { files }, problems };
}

function render(manifest) {
  return JSON.stringify(manifest, null, 2) + '\n';
}

function main() {
  const check = process.argv.includes('--check');
  const target = path.join(root, 'manifest.json');
  const { manifest, problems } = build();
  const expected = render(manifest);
  let current = '';
  try { current = fs.readFileSync(target, 'utf8'); } catch (e) { current = ''; }

  if (check) {
    if (current !== expected) problems.push('manifest.json is out of date, run "npm run manifest"');
    if (problems.length) {
      console.error(problems.join('\n'));
      process.exit(1);
    }
    console.log(`manifest OK (${Object.keys(manifest.files).length} files)`);
    return;
  }

  if (problems.length) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
  fs.writeFileSync(target, expected);
  console.log(`manifest.json written (${Object.keys(manifest.files).length} files)`);
}

if (require.main === module) main();

module.exports = { build, render };
