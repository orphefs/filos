# Developing Filos

Product vision, decisions and open questions live in [CLAUDE.md](../CLAUDE.md).

## Build and test

```bash
npm install
npm run build        # dist/extension.js, dist/webview.js
npm run typecheck
npm run test:unit    # contracts, risk, providers (fake CLIs), review model
npm run test:e2e     # real VS Code with fake agent and gh CLIs (Linux: headless under xvfb; macOS: windows open on screen)
npm run validate:fixture     # the sample graph against the graph contract
npm run validate:questions   # the sample questions against the question-set contract
npm run harness      # the webview alone in a browser, with a mocked host
npm run package      # dist/filos.vsix
```

Live checks against the real CLIs cost money or plan usage, so they are separate scripts: `npm run smoke:claude` and `npx tsx scripts/smoke-codex.ts`.

## Continuous integration

GitHub Actions (`.github/workflows/ci.yml`) builds Filos and runs its tests on Linux and macOS. The test job uses the fake agent and gh CLIs only. Two more jobs install the current Codex CLI and run `npm run probe:codex-sandbox`, which checks with `codex sandbox` that Filos's permission profile confines Codex's commands: it needs no login and makes no model call. CI never spends money. Windows isn't covered.

- `npm run probe:codex-sandbox` runs the same probe locally. `--codex <path>` picks the CLI, `--decoy-auth` puts a stand-in `auth.json` in CODEX_HOME when there is none (a real one is read with its output discarded), and `--skip-if-unavailable` exits 0 when the sandbox can't start at all.
- `FILOS_E2E_DOWNLOAD=1 npm run test:e2e` runs the stable VS Code that CI downloads, instead of one installed at `/usr/share/code`. `FILOS_E2E_VSCODE_VERSION=1.108.2` runs that version. The workflow's `FILOS_E2E_VSCODE_VERSION` pins it in CI.

## Specs

- [Review-graph contract](graph-contract.md): what the comprehension pass returns.
- [Question-set contract](questions-contract.md): the questions and their comment seeds.
- [Questionnaire, comments and didactic mode](review-and-didactic.md).
- [Agent providers](agent-provider.md): how `claude` and `codex` are invoked and locked down.
- [Dependency index](dependency-index.md): draft format.

## Releasing on GitHub

This is how 0.1.0 is shared before the Marketplace: a pre-release on GitHub Releases with the `.vsix` attached. People can only download it once the repository is public.

1. Set the version in `package.json` and record it in [CHANGELOG.md](../CHANGELOG.md).
2. Check that CI is green on Linux and macOS for the commit you'll release.
3. Build the package from a clean checkout of that commit, and name it with the version, as the README's Install section does:

   ```bash
   npm ci
   npm run package:pre-release
   cp dist/filos.vsix dist/filos-0.1.0.vsix
   ```

4. Try the package once: `code --install-extension dist/filos-0.1.0.vsix`, then run **Filos: Review Sample PR (bundled example)**. `npm run test:e2e:vsix` runs the e2e suite against a fresh package.
5. Write the release notes to a file outside the repository's tracked files, for example `dist/release-notes.md`: the version's CHANGELOG section and the README's Install steps.
6. Tag the commit and create the release:

   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   gh release create v0.1.0 dist/filos-0.1.0.vsix --verify-tag --prerelease \
     --title "Filos 0.1.0 (preview)" --notes-file dist/release-notes.md
   ```

   The asset's name is the file's name, so upload `filos-0.1.0.vsix`, not `filos.vsix`.

## Publishing to the Marketplace

1. Make the repository public and push `main`. Relative image links in README.md resolve to `https://github.com/orphefs/philos/raw/HEAD/…` on the Marketplace.
2. Create the `orphefs` publisher at <https://marketplace.visualstudio.com/manage> and get a Personal Access Token with the Marketplace › Manage scope.
3. Log in once (it asks for the token), then publish a pre-release:

   ```bash
   npx vsce login orphefs
   npm run publish:pre-release
   ```

   Or build the package with `npm run package:pre-release` and upload `dist/filos.vsix` on the manage page.
4. Optionally, publish to [Open VSX](https://open-vsx.org) for VSCodium, Cursor and Windsurf users: `npx ovsx publish dist/filos.vsix -p <token>`.

Version numbers follow VS Code's convention: odd minor versions for pre-releases (0.1.x), even ones for releases (0.2.x). Record each version in [CHANGELOG.md](../CHANGELOG.md).
