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
bun add github:hraness/dawn-sdk#v0.66.3
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

## Render a passage in the browser

Use `ambientVoicing(name, warmth)` from `@hraness/dawn-sdk` to play an intimate ensemble. For example, spread `...ambientVoicing("felt-piano", 0.7)` into a track and add notes and a sustain pedal. Set `calibration: SONG_CALIBRATION_LATEST` in `song()` to use the piano and wind response of a new local DAWN project. The 23 sounds include piano, electric keys, glass and wooden mallets, bowed and plucked strings, bamboo flute, vowel voices and synthesizers. `ambientVoicingNames` lists the choices. The warmth control runs from 0 to 1 and each sound expands to editable DAWN instrument parameters.

Bundle this module for a browser or a dedicated Web Worker. It renders the
same stereo samples as the CLI for the supported instruments and effects.

```ts
import { note, song, track, SONG_CALIBRATION_LATEST } from "@hraness/dawn-sdk";
import { renderBrowserPcm } from "@hraness/dawn-sdk/browser";

const score = song({
  calibration: SONG_CALIBRATION_LATEST,
  tempo: 72,
  bars: 1,
  tracks: [
    track({ name: "Keys", instrument: "felt", notes: [note("D4", 0, 2, 0.5)] }),
  ],
});
const { pcm, sampleRate, channels, musicalSeconds, tailSeconds } =
  renderBrowserPcm(score, { sampleRate: 22050 });
```

The PCM is interleaved signed 16-bit stereo. Divide each channel’s samples
by 32768 for Web Audio. Schedule the following passage at `musicalSeconds`
and let this buffer continue for `tailSeconds`. A worker can transfer
`pcm.buffer` back to its page.

Use fixed-tempo scores with the legacy tones, oscillator synths, modeled
keys, strings, winds, modal percussion, the built-in singing voice, and synthetic textures. A short `texture("brush")` note plays the tips of a wire brush on a snare head. Hold it for alternating sweeps. Velocity brings out the tapped head and wear changes the wire sound. Use `texture("paper")` for creases or `texture("porcelain")` for a ringing ceramic tap. The browser entry also exports instrument, preset, and parameter definitions for score editors.
The score can span up to 45 seconds of music, with up to 60 seconds in
the complete buffer including release tails. Sample rates range from
8,000 to 48,000 Hz. Unsupported instruments, routing, assets, master chains
and arranged forms raise a score validation error. [Play the open-source browser example](https://sleepy.land/).

## Build a browser score editor

Import the optional editor controls and stylesheet in your browser app. The roll
uses DAWN note ticks and MIDI pitches. Each note is a button that your app can
connect to its inspector or audio transport.

```ts
import {
  createParameterControl,
  createPianoRollGrid,
  parameterIcon,
  spaceEffectParameters,
} from "@hraness/dawn-sdk/ui";
import "@hraness/dawn-sdk/ui/styles.css";

const notes = [{ startTick: 0, durationTicks: 96, pitch: 62, velocity: 0.6 }];
const host = document.createElement("div");
const roll = createPianoRollGrid(host, {
  notes,
  bars: 1,
  beatsPerBar: 4,
  ticksPerBeat: 96,
});
for (const note of notes) roll.addNote(note);

const effects = { reverb: { mix: 0.25 } };
const room = createParameterControl(document, {
  label: "Room",
  icon: parameterIcon("reverb.mix"),
  spec: spaceEffectParameters.reverb.mix,
  value: effects.reverb.mix,
  presentation: "fader",
  onChange: (mix) => {
    effects.reverb.mix = mix;
  },
});
document.body.append(host, room);
```

For an instrument label, `instrumentIcon(track)` selects the drawing from the
track’s instrument and preset. `createIcon(document, name)` returns a decorative
SVG alongside your label. `DAWN_ICON_PATHS` exposes the same drawings for a
component framework, canvas or native vector renderer.

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

## Make, check, lint, upgrade and share a project

A DAWN project is a folder: `dawn.json`, `song.ts`, one `tracks/<name>/track.ts`
per track, and a copy of this SDK in `.dawn/sdk/`. `dawn-project` holds the
commands DAWN itself uses on that folder:

```sh
bunx dawn-project init night
cd night
bunx dawn-project check
bunx dawn-project lint
bunx dawn-project link
bunx dawn-project open "https://dawnav.com/open#d1…" copy
bunx dawn-project migrate
bunx dawn-project comments add "tighten the hats" --agent my-tool
```

```text
ok · 0 tracks, 0 notes · types 110 ms · eval 83 ms · score version 1
```

- `init` writes a new project.
- `check` brings the SDK copy up to date, typechecks and evaluates the song in
  the sealed engine. It runs the TypeScript compiler you have: install
  `typescript` beside the SDK or have `tsc` on your PATH.
- `lint` reads the score without rendering it and reports what is wrong
  with the music, each finding with a rule, a place and a fix: a note
  outside the key or against the bar's chord, a clash held over the bass, a
  semitone between parts on a strong beat, a sustained low second, a sung line outside its register
  or too fast to say, a stressed syllable on a weak position, a chorus
  thinner than its verse and, with `--album <dir>`, two songs that are too
  alike. It exits 1 on an error; `--json` prints the report. A project's
  `lint.json` declares its chords, its vocal books and what it allows.
  The `harmony.low-second` warning names both pitches and tracks when a second
  with its lower note below C3 lasts at least half a beat. From C3 through B3
  it checks semitones held for a full beat. An octave change or
  a shorter overlap can separate the parts. A rule-scoped `allow` entry
  records an intentional cluster.
- `link` writes the score as a link and `open` turns a link back into a
  project. The link is the whole score: nothing is uploaded.
- `migrate` shows what an older project needs as a diff and exits 3 when
  steps are pending; `--apply` makes the changes with a backup, `--undo`
  restores it.
- `comments` reads and appends `comments.jsonl`, the project's review notes.

Each command prints its messages as DAWN does, so `dawn check` in a message
is `dawn-project check` here. The score class, the link codec, the score
diff, the lint, the comment events, MIDI export, the trace envelope and the
score document reader are also importable: `@hraness/dawn-sdk/score`,
`/link`, `/diff`, `/lint`, `/comments`, `/midi`, `/trace` and `/doc`.

```ts
import { diffScores } from "@hraness/dawn-sdk/diff";
import { lintSong } from "@hraness/dawn-sdk/lint";
import { TrackScore } from "@hraness/dawn-sdk/score";

// `before` and `after` are scores as song() returns them. The diff is the
// list of operations that turns one into the other; the lint reads a score
// against its key and the chords you declare, one per bar.
const operations = diffScores(new TrackScore(before), new TrackScore(after));
const { ok, findings } = lintSong(after, { config: { harmony: ["Am", "F"] } });
```

The lint's thresholds come from a calibration. This package's is a wide
baseline that no song was tuned on: the rules that judge taste (register,
prosody, density, repetition, sameness) rarely fire, and the sung-line ones
report warnings. A note outside the key, a clash held over the bass and a
semitone between parts on a strong beat are found under any calibration. To
hold songs to the numbers of the music you like, pass your own
`LintCalibration` to `lintSong`, or override single numbers in `lint.json`
under `style`.

Before version 1.0 a newer DAWN may render an older project differently:
`migrate` keeps a project readable, not its exact sound.

## What this package does not include

It has no song or album generator of DAWN's. DAWN's composer, which chooses
melodies, harmony, arrangement and mix, stays part of the DAWN app, as do
the lint thresholds it fits to its own songs and the recorder that writes a
project's `trace/`. The SDK
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

## Sing a vocal score

With the matching DAWN CLI installed and its local voice prepared by
`dawn setup --install`, render a score in an existing project directory.

```ts
import type { VocalScore } from "@hraness/dawn-sdk/vocals";
import { localVocals } from "@hraness/dawn-sdk/vocals/local";

const vocals = localVocals({ projectRoot: "./my-song" });
const score: VocalScore = {
  version: 1,
  bpm: 120,
  seed: 17,
  human: 0.2,
  phrases: [
    {
      id: "chorus",
      beats: 4,
      notes: [
        { syl: "read", spokenAs: "red", beat: 0, len: 1, midi: 64 },
        { syl: "~", beat: 1, len: 2, midi: 67 },
      ],
    },
  ],
};
const result = vocals.validate(score);
if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
const take = await vocals.render(score);
console.log(take.wavPath, take.sha256);
```

The portable `/vocals` entry works in browser editors. Call
`validateVocalScore(input)` there. Use `createVocals([provider])` to supply a
renderer with a list of voices and a `render(resolvedScore, signal)` method.
Each voice advertises its ID, provider version, language and supported controls.
Discover registered voices with `vocals.voices.list()`. The `/vocals/local`
entry runs the installed CLI from a native host.

Write one syllable per note, a trailing hyphen to join syllables into one word,
and `~` to carry its vowel. An optional `spokenAs` supplies the spelling read
by the voice while preserving the written lyric. A phrase ID and song seed
determine its performance seed. Set a phrase's own seed to pin a particular
variation. Take slice boundaries are fractions of WAV duration. Keep the take
and its SHA-256 for byte-exact playback across machines.
