# Write a composer plug-in

A composer plug-in turns a brief (a prompt, a seed, and the key, tempo, length, form, mood, energy and sounds the user asked for) into a song. DAWN runs it in the same sealed engine as song source, checks what it returns like any `song.ts`, and writes an ordinary project the user can edit, render and share. A composer is data-safe by construction: it cannot read or write a file, reach the network, start a process or read the clock, and the same brief always gives the same song.

`dawn song` without `--composer`, or with `--composer dawn`, still runs DAWN's own composer. Plug-ins are part of `dawn` and of the public, MIT-licensed [DAWN SDK](https://github.com/hraness/dawn-sdk), which runs them as `dawn-compose`.

## Try the example

The SDK includes Euclid Pulse, a small composer in `examples/composers/euclid-pulse/`: Euclidean drums, a seeded four-chord loop, a root bass and a pentatonic top line.

```sh
dawn song night --composer examples/composers/euclid-pulse --prompt "a dark rainy groove" --seed 7 --bars 8
```

```text
composed with euclid-pulse 1.0.0 (examples/composers/euclid-pulse, sha256 fd3821c905b0) · seed 7 · 4 tracks · 8 bars · 113 BPM C minor · 76 ms
i VII VI VII in C minor · 113 BPM · 8 bars · kick E(3,16) · hat E(8,16)
wrote night (song.ts, tracks/, composer.json)
```

`night/` is a DAWN project: `song.ts`, one `tracks/<name>/track.ts` per part, and `composer.json`, which records the composer's ID, version and the SHA-256 of the files that ran, and the brief. Edit it like any song, then `dawn check` and `dawn render night.wav` from the folder.

With the SDK alone, the same command is `dawn-compose`, and `dawn-render` renders what it writes:

```sh
bunx dawn-compose night --composer node_modules/@hraness/dawn-sdk/examples/composers/euclid-pulse --seed 7
bunx dawn-render night/song.ts --out night.wav
```

`dawn-compose` writes `song.ts`, `tracks/` and `composer.json` without DAWN's project files (`dawn.json`, the vendored SDK).

## Make a composer

A composer is a folder with a manifest and at least one module:

```text
my-composer/
  dawn.composer.json
  composer.ts
  loops.ts          any other .ts, .js or .json modules it imports
  tsconfig.json     optional: maps "dawn" to the SDK for your editor
```

`dawn.composer.json`:

```json
{
  "schema": "dawn.composer-plugin/v1",
  "id": "my-composer",
  "version": "1.0.0",
  "title": "My composer",
  "author": "Your name",
  "license": "MIT",
  "entry": "composer.ts",
  "description": "What it writes, in a sentence."
}
```

`id` is a lowercase slug of up to 64 characters, `version` is `major.minor.patch`, and `entry` is a `.ts` or `.js` module inside the folder. `description` is optional. Unknown fields are refused. Put your own name and a license you can grant on the manifest.

The entry's default export is `composer()` from `dawn`, called with the brief:

```ts
import { composer, euclid, progression, seededRandom, song, track } from "dawn";

export default composer((brief) => {
  const random = seededRandom(brief.seed);
  const key = brief.key ?? (random() < 0.5 ? "A minor" : "C major");
  const bars = brief.bars ?? 8;
  return {
    song: song({
      tempo: brief.tempo ?? 110,
      key,
      bars,
      tracks: [
        track({
          name: "Drums",
          instrument: "kit",
          rhythm: [euclid("kick", 3 + Math.floor(random() * 3), 16)],
        }),
        track({
          name: "Keys",
          instrument: "piano",
          notes: progression("i VI III VII", { key }),
        }),
      ],
    }),
    summary: `${key} · ${bars} bars`,
  };
});
```

Use every SDK builder: `song`, `track`, `note`, `seq`, `progression`, `chord`, `euclid`, `grid`, patches and effects. There is no `Math.random`; `seededRandom(seed)` is a deterministic generator that gives the same sequence on every machine. The function runs synchronously; a composer that returns a promise is refused.

For type checking in your editor, copy `tsconfig.json` from the example and point its `paths` entry for `dawn` at the SDK's `core/sdk/v1.ts`. DAWN itself reads no `tsconfig.json`: `dawn` always resolves to the SDK the running DAWN ships.

## The brief

| Field      | Type                                   | Present                                                                             |
| ---------- | -------------------------------------- | ----------------------------------------------------------------------------------- |
| `protocol` | `"dawn.composer-plugin/v1"`            | always                                                                              |
| `prompt`   | string, up to 4,000 chars              | always; empty without `--prompt`                                                    |
| `seed`     | 0..4294967295                          | always; random when `--seed` is left out, and recorded in `composer.json`           |
| `key`      | for example `"A minor"`                | with `--key`                                                                        |
| `tempo`    | 20..300 BPM                            | with `--tempo`                                                                      |
| `bars`     | 1..256                                 | with `--bars`                                                                       |
| `form`     | `[{ name, bars }]`                     | with `--form "intro:4 verse:8 chorus:8"`; with `--bars`, the bars must add up to it |
| `mood`     | up to 64 characters                    | with `--mood`                                                                       |
| `energy`   | 0..1                                   | with `--energy`                                                                     |
| `sounds`   | `[{ id, title, role, range?, tags? }]` | always; the palette's instrument sounds with `--palette`, otherwise empty           |
| `score`    | a song as `song()` returns it          | with `--vary`: the project's current song                                           |

A field the user did not set is absent, so the composer chooses its own default. The types are `ComposerBrief`, `ComposerSound` and `ComposerSection` in the SDK.

## What a composer returns

A `Composition`: `{ song, voices?, summary? }`, or the `song()` alone.

- `song` is validated exactly like the result of a `song.ts`: the same score format, the same limits (`SCORE_LIMITS`) and the same messages. An invalid score is refused with the reason.
- The song names no file. Samples, wavetables, clips, impulse responses and granular sources must be `builtin:` sources or one of the bundled studio sounds; a tuning is written inline, not as a `.scl` or `.kbm` file; and a patch runs no WebAssembly device. A composer ships no audio and needs nothing beside the song.
- `voices` maps a track ID to the ID of a sound the brief offered. DAWN replaces that track's instrument with the sound's patch, so the user's palette plays the part, and copies any device the sound runs into the song's `devices/` folder. A voice must name a track of the song and an offered sound, and cannot voice a `kit` track. Drum and effect sounds are not offered in this version.
- `summary` is up to 500 characters with no control or bidirectional-override characters; DAWN prints it and keeps it in `composer.json`. A composer's error messages are printed with such characters escaped.

Anything else, more than 8 MiB of JSON, or unknown top-level fields are refused.

## What a composer can do

A composer runs in the [sealed song engine](./design/song-sandbox.md): QuickJS compiled to WebAssembly.

- **No authority.** The global object holds the standard JavaScript built-ins only. There is no `process`, `Bun`, `require`, `fetch`, `console`, timer, `performance` or `WebAssembly`, and `Date` and `Math.random` throw.
- **No file system.** DAWN reads the composer's `.ts`, `.mts`, `.js`, `.mjs` and `.json` files into memory before it runs; hidden files, `node_modules` and links are not read. The engine resolves imports against those files only: `dawn` (the SDK this DAWN ships) and relative paths inside the folder. `node:*`, `bun:*`, package names, absolute paths, URLs and paths that leave the folder are refused with the file and line of the import.
- **Deterministic.** The same composer files and the same brief give the same song, byte for byte, on every machine.

| Bound           | Value                                   |
| --------------- | --------------------------------------- |
| Files           | 256 modules, 1 MiB each, 4 MiB together |
| Engine memory   | 256 MiB                                 |
| Engine stack    | 1 MiB                                   |
| Wall time       | 10 s (`--timeout-ms`, up to 60 s)       |
| Brief           | 8 MiB of JSON, with the score to vary   |
| What it returns | 8 MiB of JSON                           |

A composer that throws, loops, or runs out of memory or stack ends with a diagnostic naming the composer file and line, and nothing is written.

## Command options

```sh
dawn song [dir] --composer <folder|collection/entry> [--prompt "<text>"] [--seed <n>] [--key "<key>"] [--tempo <bpm>] [--bars <n>] [--form "<name:bars ...>"] [--mood <word>] [--energy <0..1>] [--palette <palette.json|collection/entry>] [--vary] [--force] [--json]
```

- `--composer` takes a folder, its `dawn.composer.json`, or an installed entry written `<collection>/<entry>`. A name of that shape is looked up in `collections.lock.json` first; write `./a/b` for a folder that is spelled the same. `dawn` selects DAWN's own composer, which takes its own options (`dawn song --help`).
- `--palette` offers the palette's `bass`, `bed`, `lead`, `keys` and `texture` sounds in the brief ([Build a sound palette](./palettes.md)).
- `--vary` passes the project's current song as `brief.score`, for a composer that writes a variation of it. It replaces the song, so it needs `--force`.
- A folder whose `song.ts` already has tracks is not replaced without `--force`.
- `--json` prints the folder, seed, composer identity, track and note counts, bars, tempo, key, voices and summary.

Invalid arguments and a composer that fails or returns an invalid song exit with code 2 and say why on stderr; an existing song without `--force` exits with code 1.

## Share a composer

Add the folder to a [collection](./collections.md) like any other entry. `collection add` recognizes a folder with `dawn.composer.json` as a `composer` and lists its files with their digests:

```sh
dawn-collection add dawn.collection.json composers/my-composer --credit "Your name" --license software=MIT --apply
```

Others install it into a project and compose with it by name:

```sh
dawn-collection install https://github.com/OWNER/REPOSITORY my-composer
dawn song . --composer my-library/my-composer --seed 3
```

An installed composer runs from its locked files only. Each must still hold the bytes `collections.lock.json` records, or the command refuses it and says how to restore it, and a file the lock does not list is never read, so nothing added beside the entry can be imported. Like a song, a locked composer changes on `dawn-collection update` only when you name it.

## Why the song engine

DAWN has two sealed runtimes: the song engine for TypeScript and WebAssembly [devices](./devices.md) for sound. Composers use the song engine because a composer's work is the SDK's: chords, progressions, rhythms and tracks, written as TypeScript an author can read. A WebAssembly composer would have to rebuild those in another language and hand back raw score JSON. The engine already enforces what a composer needs, without a new runtime to review. A WebAssembly composer interface may follow if one is needed.

## What this does not cover

- **DAWN's composer.** The built-in composer is not a plug-in and is not in the SDK; it stays the default.
- **Cost.** A valid song can still be expensive to render within the score limits.
- **Words.** A composer writes notes, sounds and structure. DAWN's lyric drafting, voicing level match and render checks belong to its own composer.
- **Trust in the author.** Checksums identify bytes, not who wrote them. The sandbox bounds what a composer can do; it does not judge whether its music is any good.
