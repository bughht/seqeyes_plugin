const fs = require('node:fs');
const path = require('node:path');

const packagePath = path.resolve(process.argv[2] || 'seqeyes-web.vsix');
const entries = readZipEntries(packagePath);
const entrySet = new Set(entries);

const requiredEntries = [
  'extension/package.json',
  'extension/out/extension.js',
  'extension/out/editor/seqEditorProvider.js',
  'extension/out/editor/webviewContent.js',
  'extension/out/editor/webview/assets/template.html',
  'extension/out/editor/webview/assets/styles.css',
  'extension/out/editor/webview/assets/state.js',
  'extension/out/editor/webview/assets/drawing.js',
  'extension/out/editor/webview/assets/kspace.js',
  'extension/out/editor/webview/assets/interaction.js',
  'extension/images/logo.png',
  'extension/LICENSE.txt',
  'extension/README.md',
];

const forbiddenPrefixes = [
  'extension/src/',
  'extension/test/',
  'extension/.github/',
  'extension/.vscode/',
  'extension/.vscode-test/',
  'extension/node_modules/',
  'extension/matlab/',
  'extension/web/',
];

const forbiddenEntries = [
  'extension/tsconfig.json',
  'extension/web/pulseq-browser.ts',
];

for (const required of requiredEntries) {
  assert(entrySet.has(required), `Missing required VSIX entry: ${required}`);
}

for (const entry of entries) {
  for (const prefix of forbiddenPrefixes) {
    assert(!entry.startsWith(prefix), `VSIX should not include ${prefix}: ${entry}`);
  }
  assert(!entry.endsWith('.mltbx'), `VSIX should not include MATLAB toolbox artifacts: ${entry}`);
}

for (const entry of forbiddenEntries) {
  assert(!entrySet.has(entry), `VSIX should not include development file: ${entry}`);
}

console.log(`VSIX package smoke passed for ${path.basename(packagePath)} (${entries.length} entries)`);

function readZipEntries(filePath) {
  const data = fs.readFileSync(filePath);
  const eocdOffset = findEndOfCentralDirectory(data);
  const totalEntries = data.readUInt16LE(eocdOffset + 10);
  let offset = data.readUInt32LE(eocdOffset + 16);
  const names = [];

  for (let i = 0; i < totalEntries; i++) {
    const signature = data.readUInt32LE(offset);
    assert(signature === 0x02014b50, `Invalid central directory signature at offset ${offset}`);
    const fileNameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    const nameStart = offset + 46;
    const nameEnd = nameStart + fileNameLength;
    names.push(data.subarray(nameStart, nameEnd).toString('utf8'));
    offset = nameEnd + extraLength + commentLength;
  }

  return names;
}

function findEndOfCentralDirectory(data) {
  const minOffset = Math.max(0, data.length - 65_557);
  for (let offset = data.length - 22; offset >= minOffset; offset--) {
    if (data.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error('Could not find ZIP end-of-central-directory record');
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
