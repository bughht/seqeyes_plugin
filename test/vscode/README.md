# VS Code Extension E2E

Stage 5 tests launch a VS Code Extension Development Host and exercise the
custom editor integration layer. They intentionally avoid duplicating the
standalone browser pixel tests.

Run locally:

```sh
npm run test:vscode
npm run test:package
```

`test:vscode` sets `SEQEYES_TEST_MODE=1` for the extension host. In that mode
the extension registers internal diagnostic commands used by the tests; those
commands are not contributed in `package.json` and are not visible in normal
use.

The export test uses a dialog-free internal command that writes the same
`*_ktraj_adc.txt` and `*_metadata.json` artifacts as the normal VS Code export
button.
