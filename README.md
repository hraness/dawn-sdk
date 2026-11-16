# @hraness/dawn-sdk

Build sounds, sound packs, composers and community collections for
[DAWN](https://dawnav.com), write song scores with the same TypeScript SDK
that DAWN projects use, and render them to audio with DAWN's own renderer. The
package is MIT licensed. Its one runtime dependency is the QuickJS engine
(`quickjs-emscripten`, MIT) that runs song source in a sealed sandbox.

A palette is a JSON file of instrument and effect patches with names, roles and
playable ranges. A collection is a catalog that points at palettes, packs,
loops, songs or albums in whatever repository layout you already have. Both are
data: checking, exporting, packing or building them runs no author code and
makes no network request. Installing an entry fetches only its declared files,
verifies them and runs none of them.

## Install

Bun 1.3.14 or newer runs the tools. Install a tagged release from GitHub:

```sh
bun add github:hraness/dawn-sdk#v0.61.0
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
(`palette`, `patch-pack`, `sample-pack`, `loop`, `song`, `album`, `composer`
or `collection`), credits, licenses and a source: a local file, an HTTPS URL or a
Git repository pinned to a commit. `add` proposes an entry from a manifest or a
project folder, `check` verifies local files against their hashes, and `build`
writes a portable copy with an integrity inventory and an optional static page.

```sh
bunx dawn-collection install https://github.com/OWNER/REPOSITORY warm-keys
bunx dawn-collection update --dry-run
```

`install` pins the repository's current commit, copies the selected entries'
files into `collections/` and records every digest in `collections.lock.json`;
later installs work offline from the cache. The
[collection guide](docs/collections.md) covers sharing a catalog on GitHub,
accepting contributions and updating installed entries.

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

## Render a score

`dawn-render` turns a song into a WAV file:

```sh
bunx dawn-render song.ts --out song.wav
bunx dawn-render song.ts --out song.wav --stems stems
bunx dawn-render score.json --out song.wav
```

```text
rendered · song.wav · 8.35 s · 22050 Hz · 736516 bytes · 794cdceb…
```

It is the renderer DAWN uses, so a song renders to the same bytes as
`dawn render` writes for it, on any machine. `song.ts` runs in the same sealed
engine as in DAWN: it can import `dawn` and files beside it, and has no file,
network, process, clock or randomness access. `score.json` is a score as
`song()` returns it, written with `JSON.stringify`. Patches and palettes are
part of the score; samples, WebAssembly devices (in `devices/`) and a
`mix.patch.json` are read from the song's folder. `--stems` also writes one
WAV per track and the premaster. `--rate` sets the sample rate; by default a
song with a master renders at 48 kHz and one without at 22,050 Hz.

The renderer never opens an audio device and never changes your files. It
writes the output, the stems and a cache of decoded samples under the song's
`.dawn/assets/`. A song that uses `pack:` samples from a sample-pack URL
downloads those files on first use; the eight studio sounds in
`assets/samples/studio/` are included and need no network. DAWN's sung hooks
and vocal books are not included.

Rendering takes the reference TypeScript DSP path. DAWN can also load a native
reverb kernel, which produces the same samples faster; the SDK ships no native
code.

## Write a composer

A composer plug-in turns a brief (a prompt, a seed, and the key, tempo, form,
mood, energy and palette sounds the user asked for) into a song. It is a folder
with a `dawn.composer.json` manifest and TypeScript that uses this SDK:

```ts
import { composer, euclid, seededRandom, song, track } from "dawn";

export default composer((brief) => {
  const random = seededRandom(brief.seed);
  return song({
    tempo: brief.tempo ?? 110,
    bars: brief.bars ?? 4,
    tracks: [
      track({
        name: "Drums",
        instrument: "kit",
        rhythm: [euclid("kick", 3 + Math.floor(random() * 3), 16)],
      }),
    ],
  });
});
```

A composer imports the SDK as `"dawn"`; the example's `tsconfig.json` maps it
for your editor. `dawn-compose` runs one in the same sealed engine as song source, with no file,
network, clock or randomness access, checks the song it returns and writes
`song.ts` and `tracks/`:

```sh
bunx dawn-compose night --composer node_modules/@hraness/dawn-sdk/examples/composers/euclid-pulse --seed 7
bunx dawn-render night/song.ts --out night.wav
```

DAWN runs the same composers with `dawn song --composer`, and installs them
from collections. The [composer guide](docs/composers.md) describes the brief,
what a composer may return and the limits.

## What this package does not include

It has no song or album generator of DAWN's. DAWN's composer, which chooses
melodies, harmony, arrangement and mix, stays part of the DAWN app. The SDK
does include the musical building blocks an author selects by hand: chord
parsing, progressions, voicing, strumming and Euclidean rhythms, and the
composer plug-in interface for writing your own.

## Check a release

`extension-manifest.json` lists every file with its size and SHA-256. To check
a downloaded release:

```sh
shasum -a 256 -c SHA256SUMS
gh attestation verify hraness-dawn-sdk-<version>.tgz --repo hraness/dawn-sdk
```

`bun install --frozen-lockfile` and then `bun run check` in a clone verify the
manifest, run the palette and collection tools end to end and render a test
song, whose WAV must match the SHA-256 that DAWN's own render of it has.

## Contributing

This repository is published from DAWN's source tree, so pull requests here are
ported rather than merged directly. Issues and palette or collection
contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md) and
[SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). Sounds and collections you make with it are yours to license.
