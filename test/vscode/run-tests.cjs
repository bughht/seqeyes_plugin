const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runTests } = require('@vscode/test-electron');

async function main() {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'seqeyes-vscode-e2e-'));

  copyFixture(repoRoot, workspacePath, 'test/seqeyes_demo_seq_files/writeEpi.seq', 'writeEpi.seq');
  copyFixture(repoRoot, workspacePath, 'test/seq/spiral_inout.seq', 'spiral_inout.seq');
  fs.writeFileSync(path.join(workspacePath, 'invalid.seq'), 'This is not a Pulseq sequence.\n', 'utf8');

  try {
    await runTests({
      version: process.env.SEQEYES_VSCODE_TEST_VERSION || '1.85.2',
      extensionDevelopmentPath: repoRoot,
      extensionTestsPath: path.resolve(__dirname, 'suite', 'index.js'),
      launchArgs: [
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
      ],
      extensionTestsEnv: {
        SEQEYES_TEST_MODE: '1',
        SEQEYES_TEST_WORKSPACE: workspacePath,
      },
    });
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
}

function copyFixture(repoRoot, workspacePath, source, target) {
  fs.copyFileSync(path.join(repoRoot, source), path.join(workspacePath, target));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
