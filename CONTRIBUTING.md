# Contributing

`@hraness/dawn-sdk` is exported from DAWN's source tree by
`scripts/export-extension-sdk.ts`, which admits an explicit list of files and
records each one's hash in `extension-manifest.json`. Every release replaces
the tree with a fresh export, so a change made only here would be lost.

- **Bugs and requests:** open an issue with the command, the input file and
  the output you expected.
- **Code changes:** open a pull request if it helps explain the fix. A
  maintainer ports it into DAWN, and it arrives here with the next export,
  credited to you.
- **Palettes and collections:** you don't need this repository. Publish your
  own repository with a `dawn.collection.json`, and run `dawn-collection check`
  before you share it. See [docs/collections.md](docs/collections.md).

Run `bun run check` before you open a pull request. It verifies the manifest
and runs the palette and collection tools on the bundled example.

## Releases

A maintainer bumps `version` in `package.json` on `main`. Once CI passes, the
tag workflow creates `v<version>` and the release workflow:

1. checks that the tag matches `package.json`, is on `main` and is newer than
   every earlier tag;
2. runs `bun run check` and packs the tarball once;
3. publishes an immutable GitHub Release with the tarball, `SHA256SUMS` and a
   build provenance attestation;
4. publishes the same tarball to npm through trusted publishing, so no npm
   token is stored anywhere.

npm only accepts trusted publishing for a package that already exists, so the
npm job warns and skips until a maintainer does this once:

1. Download the first release's tarball, check it against `SHA256SUMS`, and
   publish it by hand: `npm publish hraness-dawn-sdk-<version>.tgz --access public`.
2. Let the workflow publish from then on:
   `npm trust github @hraness/dawn-sdk --repo hraness/dawn-sdk --file release.yml --allow-publish --yes`
   (npm 11.16 or newer).
3. In the package settings on npmjs.com, require two-factor authentication and
   disallow tokens.
