# Release Process

How a release works **today**. This is the 3.x pipeline and it is going to be
replaced in the 4.0 release week (trusted publishing instead of `NPM_TOKEN`,
draft → publish, the move to the `CodeepDev` organisation). Rewrite this file
then.

There are no 3.x releases before 4.0; fixes go into 4.0.

## What a release is

Pushing a tag `v<version>` runs `.github/workflows/release-binaries.yml`, which
runs three jobs in order. Each needs the one before, so a failure stops the
chain:

1. **build** — compiles binaries (`codeep-darwin-aarch64`, `codeep-darwin-x86_64`,
   `codeep-linux-x86_64`, `codeep-linux-aarch64`), packs each as a `.tar.gz` and
   attaches them to a GitHub Release. The release body is the matching
   `## [version]` section of `CHANGELOG.md`, or GitHub's generated notes if
   there is none.
2. **publish-npm** — `npm publish` (uses the `NPM_TOKEN` secret).
3. **update-homebrew** — waits for the tarball on the npm registry, then bumps
   `Formula/codeep.rb` in `homebrew-codeep` (uses `HOMEBREW_TAP_TOKEN`).

Nothing is published by hand.

## Steps

1. Add a `## [x.y.z] — YYYY-MM-DD` section to `CHANGELOG.md`, with a one-line
   `> TL;DR` under the heading (the website's RSS feed reads it), and commit it.
2. If commands changed, regenerate what the website shows and commit the JSON in
   the web repo:

   ```bash
   npm run export:commands   # → Codeep-web/src/data/commands.json
   npm run export:catalogue  # → Codeep-web/src/data/catalogue.json
   ```

3. Run the release script from a clean working tree:

   ```bash
   npm run release patch   # or minor | major | x.y.z
   ```

   It refuses a dirty tree or a missing CHANGELOG section, runs `npm test`, runs
   `npm version` (which bumps `package.json`, regenerates `src/version.ts`,
   commits and tags), checks the baked version, then pushes the commit and the tag.

4. Watch the workflow: `gh run watch -R VladoIvankovic/Codeep`.
5. Deploy the website **after** the npm publish, so it never documents a command
   or default the published CLI does not have yet.

## Users update

```bash
npm update -g codeep      # npm
brew update && brew upgrade codeep   # Homebrew
```

## Rollback

Unpublishing is discouraged; publish a patch version instead. If you must, npm
allows it within 72 hours: `npm unpublish codeep@x.y.z`.

## Version numbering

[Semantic Versioning](https://semver.org/): major for breaking changes, minor for
new features, patch for fixes.
