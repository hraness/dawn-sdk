# Build a sound palette

A palette groups reusable instrument and effect patches with names, roles and playable ranges. Check a palette locally, export one sound, then play it through the existing TypeScript SDK. Palette files contain data; checking or exporting one runs no author code and makes no network request.

The palette commands are part of `dawn` and of the public, MIT-licensed [DAWN SDK](https://github.com/hraness/dawn-sdk), which installs them as `dawn-palette` beside its renderer, `dawn-render`, and without the composer.

## Export a sound

Copy the example palette, `examples/palettes/glass-weather.json`, to your working folder. It contains four synthesized sounds: a supersaw bed, a growl bass, felt keys and a chip pulse.

```sh
dawn-palette check glass-weather.json
dawn-palette export glass-weather.json supersaw-bed bed.patch.json
```

Choose a new output filename each time. Export refuses an existing file, including a symlink. The output directory must exist. Add `--json` for a machine-readable success result. Invalid input or a failed export exits with code 2 and writes the reason to stderr.

The exported JSON has `sdk`, `patch`, `author`, `license` and optional `tags`, matching DAWN's patch-library format. To play it you need DAWN itself. Create a project with `dawn init palette-demo`, then copy the export into `palette-demo/bed.patch.json`. Replace `palette-demo/song.ts` with:

```ts
import { note, patch, song, track, type PatchData } from "dawn";
import sound from "./bed.patch.json";

export default song({
  tempo: 120,
  bars: 1,
  tracks: [
    track({
      id: "bed",
      name: "Bed",
      instrument: patch(sound.patch as PatchData),
      notes: [note("C4", 0, 3.5)],
    }),
  ],
});
```

The type assertion restores literal types widened by the JSON import. Use it with the validated export; `dawn check` also validates the resulting score.

Run `dawn check` and `dawn render preview.wav` from the project, or `dawn-render song.ts --out preview.wav` with the SDK alone; both write the same bytes. For an exported effect, use `fxPatch(sound.patch as PatchData)` in a track's `fx: { patch: [...] }` instead of using it as an instrument. The [patch SDK source](../core/sdk/v1.ts) describes graph nodes, cables and macros.

## Build a whole sound pack

Export every sound at once:

```sh
dawn-palette pack glass-weather.json glass-weather-pack
```

Choose a new output directory whose parent already exists. The completed pack is `glass-weather-pack/pack/`. It contains:

- `patches.json`, the manifest used by DAWN's existing patch-pack loader.
- `patches/<sound-id>.json`, one reusable patch per sound, including its author, license and tags.
- `palette.json`, the validated palette with its title, version, roles and playable ranges.
- `SHA256SUMS`, checksums for every payload file except the checksum file itself.

On macOS, verify the files from inside the `pack/` directory with `shasum -a 256 -c SHA256SUMS`. The patch files work as local project imports just like the single-sound export above. Packing makes no network request and does not install or publish anything.

For your own sounds, you can place the contents of `pack/` at the root of a GitHub repository you control. The existing patch loader accepts `github:<owner>/<repository>/<sound-id>` after publication. Pack creation does not establish licensing authority.

Pack sound IDs must be at most 48 characters to fit the existing loader's names. Longer IDs remain valid for palette checking and single-sound export; packing rejects them without truncation. Choose shorter IDs before packing.

Add `--json` for the completed pack path and sound count. The command reserves the output directory and exposes `pack/` only after its files are complete. Existing directories, files and symlinks are refused. If writing fails, the reserved directory may retain a partial staging folder; inspect it and choose a new output path for another attempt. A checksum verifies file integrity, not authorship or a trusted publisher.

## Voice a song with a palette

Pass a palette to `dawn song`. Voicing needs DAWN's composer, so it is part of `dawn` and not of the SDK's `dawn-palette`.

```sh
dawn song night-drive --style ballad --seed 11 --palette glass-weather.json
```

`--palette` also takes an entry installed with `dawn-collection install`, written `<collection>/<entry>`. DAWN looks it up in `collections.lock.json` in the song's folder, then in the working folder. An installed palette is used only while its file still matches the lock.

The composer writes the song as it would without a palette. Then each part plays the palette sound whose role it has:

| Part                                  | Role      |
| ------------------------------------- | --------- |
| Bass                                  | `bass`    |
| Bed and bed stabs                     | `bed`     |
| Keys and fill keys                    | `keys`    |
| Top line                              | `lead`    |
| Shimmer                               | `texture` |
| Kick (with its rolls), snare and hats | `drums`   |

The rules:

- **Several sounds with one role.** The seed picks one for the song, so the same seed always picks the same sound. When the composer writes a second sound for a role, that part takes the next sound in the palette.
- **No sound for a role.** The part keeps the composer's own sound, and the command says so.
- **Ranges.** A part moves by whole octaves to put the most notes inside its sound's range. When two moves are equally good, the smaller one wins, then the upward one. Notes still outside the range are counted and reported, and are played anyway.
- **Drums.** A `drums` sound replaces the kit piece its ID or tags name (`kick`, `snare` or `hat`) and plays that piece's General MIDI pitch. A drums sound that names no piece is reported unused.
- **Effects.** An `effect` sound is inserted on the parts its tags name: `bass`, `bed`, `keys`, `lead`, `texture` or `drums`. An effect tagged `drums` works as the kit's bus. Effects apply in palette order. An effect that names no part is reported unused.
- **Placement.** A voiced part keeps the composer's volume, pan, filter, effects, sends, ducking and automation. Only its instrument changes.

The vocal, its doubles and the composer's one-off layers (risers, arpeggios, music boxes and the like) keep their sounds.

**Levels.** Each voiced part is matched to the loudness of the sound it replaces. DAWN takes the part's busiest 8 bars and renders them twice: once with the composer's sound and once with the palette's. It measures both with K-weighting, counting only the 400 ms blocks within 20 dB of the part's loudest. The difference goes to the track's level stage; if that is not enough, it goes to the patch's own `level` stage and then to the fader. DAWN renders again until the two are within 0.1 dB, at most three times, because a compressor inside a sound reacts less than one-for-one to a level change. A part that still cannot be matched is reported with how far off it is.

The command prints one line for each part: the sound, any octave move, notes out of range and the level change. `style.resolved.json` keeps the same information under `voicing`, together with the palette's ID, version and SHA-256 and each part's measured levels. The same seed and palette always write the same bytes, so you can compose the song again from those records. The palette's devices that the voiced sounds use are copied into the song's `devices/` folder.

Matching evens out loudness, not tone. A sound brighter or darker than the one it replaces changes the mix's balance. A level matched over 8 bars can also be off elsewhere in the song when a sound's own compressor reacts to how busy the part is. Compare a render with `dawn mixqa` and `dawn measure` before keeping it.

## Describe your palette

Start from the example, give the palette and each sound stable IDs, and set your own author and license fields. Use an explicit license you have authority to grant. The example's license does not determine the license of your sounds.

A `dawn.palette/v1` document has `schema`, `id`, `version`, `title`, `author`, `license` and `sounds`. Each sound has `id`, `title`, `role` and `patch`; `description`, `tags` and `range` are optional. A range is `{ "min": 36, "max": 84 }` in MIDI pitches. Roles are `bass`, `bed`, `lead`, `keys`, `drums`, `texture` and `effect`.

The parser bounds strings, collections and patch complexity, rejects duplicate IDs and unknown fields, and validates the graph against DAWN's existing node definitions. Version 1 accepts self-contained synthesis and effect patches, which may run WebAssembly devices the palette declares and carries in `devices/` ([Build a WebAssembly device](./devices.md)). Use the existing sample-pack facilities for sample assets; palette asset installation is not implemented.

Descriptions help an author understand the sounds. Roles and ranges also tell the composer which part each sound plays when you [voice a song with the palette](#voice-a-song-with-a-palette). Without `--palette` they change nothing, and a palette never selects a global default. Notes, progressions, section rules and executable hooks are outside this format.

The manifest is limited to 8 MiB and 64 sounds. A palette version identifies the author's content revision; the `schema` identifies the format. Export records the validating runtime's SDK version.
