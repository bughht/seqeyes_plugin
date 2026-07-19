# VS Code Extension E2E

Stage 5 tests launch a VS Code Extension Development Host and exercise the
custom editor integration layer. They intentionally avoid duplicating the
standalone browser pixel tests.

Run locally:

```sh
npm run test:vscode
npm run test:package
```

The Extension Host test defaults to VS Code 1.85.2. Set
`SEQEYES_VSCODE_TEST_VERSION` to exercise another downloaded test runtime, or
set `SEQEYES_VSCODE_EXECUTABLE_PATH` to use a specific installed VS Code
executable. The runner removes inherited `ELECTRON_RUN_AS_NODE` and `VSCODE_*`
variables so launching it from an integrated VS Code/Codex terminal does not
turn the child Electron process into another Node process.

`test:vscode` sets `SEQEYES_TEST_MODE=1` for the extension host. In that mode
the extension registers internal diagnostic commands used by the tests; those
commands are not contributed in `package.json` and are not visible in normal
use.

The export test uses a dialog-free internal command that writes the same
`*_ktraj_adc.txt` and `*_metadata.json` artifacts as the normal VS Code export
button.
