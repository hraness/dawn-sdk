# @hraness/dawn-sdk

Build sounds, sound packs and community collections for
[DAWN](https://dawnav.com), and write song scores with the same TypeScript SDK
that DAWN projects use. The package is MIT licensed and has no dependencies.

A palette is a JSON file of instrument and effect patches with names, roles and
playable ranges. A collection is a catalog that points at palettes, packs,
loops, songs or albums in whatever repository layout you already have. Both are
data: checking, exporting or packing them runs no author code and makes no
network request.

## Install

Bun 1.3.14 or newer runs the tools. Install a tagged release from GitHub:

```sh
bun add github:hraness/dawn-sdk#v0.59.0
```

The same bytes are mirrored to npm as `@hraness/dawn-sdk`. Each
[GitHub Release](https://github.com/hraness/dawn-sdk/releases) carries the
package tarball and its `SHA256SUMS`, and GitHub keeps a build provenance
attestation for the tarball.

## Pack the example sounds

The package includes Glass Weather, a palette of four synthesized sounds: a
supersaw bed, a growl bass, felt keys and a chip pulse.

```sh
bunx dawn-palette check node_modules/@hraness/dawn-sdk/examples/palettes/glass-weather.json
bunx dawn-palette pack node_modules/@hraness/dawn-sdk/examples/palettes/glass-weather.json my-sounds
```

```text
palette glass-weather · 4 sounds · valid
packed glass-weather · 4 sounds · /path/to/my-sounds/pack
```

`my-sounds/pack/` now holds `patches.json`, one file per patch, the palette
metadata and `SHA256SUMS`. A DAWN project loads that folder as a patch pack.
`dawn-palette export <palette> <sound-id> <out.patch.json>` writes a single
sound instead. Neither command overwrites an existing path.

## Write your own palette

Copy the example, change the patch graphs and descriptions, and run
`dawn-palette check` until it reports `valid`. Patches use DAWN's built-in
oscillators, samplers, filters and effects; the
[palette guide](docs/palettes.md) describes every field and the limits the
checker enforces. Put your own name and license on each sound: the tools copy
them into every export and never choose a license for you.

## Start a collection

```sh
bunx dawn-collection init my-library --id my-library --title "My library" --curator "Your name"
bunx dawn-collection check my-library/dawn.collection.json
```

A catalog lives at `dawn.collection.json` by convention. Entries name a kind
(`palette`, `patch-pack`, `sample-pack`, `loop`, `song`, `album` or
`collection`), credits, licenses and a source: a local file, an HTTPS URL or a
Git repository pinned to a commit. `check` verifies local files against their
hashes and reports remote entries it did not fetch. The
[collection guide](docs/collections.md) covers sharing a catalog on GitHub and
accepting contributions.

## Write a score

`@hraness/dawn-sdk` exports the DAWN project SDK (`core/sdk/v1.ts`), the file
DAWN vendors into every project as `dawn`:

```ts
import { pattern, progression, seq, song, track } from "@hraness/dawn-sdk";

export default song({
  tempo: 120,
  key: "A minor",
  bars: 4,
  tracks: [
    track({ name: "Drums", instrument: "kit", rhythm: pattern("house") }),
    track({ name: "Bass", instrument: "bass", notes: seq("A1 . F1 . G1 .") }),
    track({
      name: "Keys",
      instrument: "piano",
      notes: progression("i VI III VII"),
    }),
  ],
});
```

The SDK builds score data. Rendering audio needs DAWN itself, which evaluates
song source in a sealed engine with no file, network, clock or randomness
access.

## What this package does not include

It has no renderer, no audio engine and no song or album generator. DAWN's
composer, which chooses melodies, harmony, arrangement and mix, stays part of
the DAWN app. The SDK does include the musical building blocks an author
selects by hand: chord parsing, progressions, voicing, strumming and Euclidean
rhythms.

## Check a release

`extension-manifest.json` lists every file with its size and SHA-256. To check
a downloaded release:

```sh
shasum -a 256 -c SHA256SUMS
gh attestation verify hraness-dawn-sdk-<version>.tgz --repo hraness/dawn-sdk
```

`bun run check` in a clone verifies the manifest and runs the palette and
collection tools end to end.

## Contributing

This repository is published from DAWN's source tree, so pull requests here are
ported rather than merged directly. Issues and palette or collection
contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md) and
[SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). Sounds and collections you make with it are yours to license.
