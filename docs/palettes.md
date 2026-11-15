# Build a sound palette

A palette groups reusable instrument and effect patches with names, roles and playable ranges. Check a palette locally, export one sound, then play it through the existing TypeScript SDK. Palette files contain data; checking or exporting one runs no author code and makes no network request.

The palette commands are part of `dawn` and of the public, MIT-licensed [DAWN SDK](https://github.com/hraness/dawn-sdk), which installs them as `dawn-palette` without a renderer or composer.

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

Run `dawn check` and `dawn render preview.wav` from the project. For an exported effect, use `fxPatch(sound.patch as PatchData)` in a track's `fx: { patch: [...] }` instead of using it as an instrument. The [patch SDK source](../core/sdk/v1.ts) describes graph nodes, cables and macros.

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

## Describe your palette

Start from the example, give the palette and each sound stable IDs, and set your own author and license fields. Use an explicit license you have authority to grant. The example's license does not determine the license of your sounds.

A `dawn.palette/v1` document has `schema`, `id`, `version`, `title`, `author`, `license` and `sounds`. Each sound has `id`, `title`, `role` and `patch`; `description`, `tags` and `range` are optional. A range is `{ "min": 36, "max": 84 }` in MIDI pitches. Roles are `bass`, `bed`, `lead`, `keys`, `drums`, `texture` and `effect`.

The parser bounds strings, collections and patch complexity, rejects duplicate IDs and unknown fields, and validates the graph against DAWN's existing node definitions. Version 1 accepts self-contained synthesis and effect patches. Use the existing sample-pack facilities for sample assets; palette asset installation is not implemented.

Descriptions, roles and ranges help an author understand the sounds. They do not instruct the composer, constrain rendered notes or select a global default. Notes, progressions, section rules and executable hooks are outside this format.

The manifest is limited to 8 MiB and 64 sounds. A palette version identifies the author's content revision; the `schema` identifies the format. Export records the validating runtime's SDK version.
