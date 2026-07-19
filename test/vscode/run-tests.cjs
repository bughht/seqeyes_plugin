const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runTests } = require('@vscode/test-electron');

async function main() {
  // Codex/VS Code-integrated terminals can inherit Extension Host variables.
  // They must not leak into the fresh desktop process under test.
  for (const key of Object.keys(process.env)) {
    if (key === 'ELECTRON_RUN_AS_NODE' || key.startsWith('VSCODE_')) delete process.env[key];
  }
  const repoRoot = path.resolve(__dirname, '..', '..');
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'seqeyes-vscode-e2e-'));

  copyFixture(repoRoot, workspacePath, 'test/seqeyes_demo_seq_files/writeEpi.seq', 'writeEpi.seq');
  copyFixture(repoRoot, workspacePath, 'test/seq/spiral_inout.seq', 'spiral_inout.seq');
  copyFixture(repoRoot, workspacePath, 'test/pulseq/binary/gre.bseq', 'gre.bseq');
  fs.writeFileSync(path.join(workspacePath, 'invalid.seq'), 'This is not a Pulseq sequence.\n', 'utf8');
  fs.writeFileSync(path.join(workspacePath, 'invalid.bseq'), 'This is not a binary Pulseq sequence.\n', 'utf8');

  try {
    const testOptions = {
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
    };
    if (process.env.SEQEYES_VSCODE_EXECUTABLE_PATH) {
      testOptions.vscodeExecutablePath = process.env.SEQEYES_VSCODE_EXECUTABLE_PATH;
      delete testOptions.version;
    }
    await runTests(testOptions);
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
