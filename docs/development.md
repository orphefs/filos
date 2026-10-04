# Developing Filos

Product vision, decisions and open questions live in [CLAUDE.md](../CLAUDE.md).

## Build and test

```bash
npm install
npm run build        # dist/extension.js, dist/webview.js
npm run typecheck
npm run test:unit    # contracts, risk, providers (fake CLIs), review model
npm run test:e2e     # real VS Code, headless under xvfb, with fake agent and gh CLIs
npm run validate:fixture     # the sample graph against the graph contract
npm run validate:questions   # the sample questions against the question-set contract
npm run harness      # the webview alone in a browser, with a mocked host
npm run package      # dist/filos.vsix
```

Live checks against the real CLIs cost money or plan usage, so they are separate scripts: `npm run smoke:claude` and `npx tsx scripts/smoke-codex.ts`.

## Specs

- [Review-graph contract](graph-contract.md): what the comprehension pass returns.
- [Question-set contract](questions-contract.md): the questions and their comment seeds.
- [Questionnaire, comments and didactic mode](review-and-didactic.md).
- [Agent providers](agent-provider.md): how `claude` and `codex` are invoked and locked down.
- [Dependency index](dependency-index.md): draft format.

## Publishing

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
