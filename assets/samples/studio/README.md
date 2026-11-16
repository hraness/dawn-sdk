# Studio sounds

Eight small original sounds from DAWN's studio library, version 1. `dawn-render` resolves `pack:studio/<id>` sampler voices to these files, with no network access.

| ID        | Source                                              | Root       | Length |
| --------- | --------------------------------------------------- | ---------- | ------ |
| hold-on   | DAWN's alto formant voice: "hold on hold on"        | C4         | 2 s    |
| stay-up   | DAWN's tenor formant voice: "stay up stay up"       | C4         | 2 s    |
| vowel-ah  | DAWN's alto formant voice: "ah"                     | C4         | 1 s    |
| vowel-oh  | DAWN's tenor formant voice: "oh"                    | C4         | 1 s    |
| glass-hit | Additive struck partials with a seeded noise attack | C6         | 0.8 s  |
| metal-hit | Additive inharmonic partials with seeded noise      | C5         | 0.8 s  |
| tape-hit  | Saturated pitch-drop sine and seeded noise          | nominal C4 | 0.45 s |
| riser     | Rising sine and seeded noise                        | nominal C4 | 2 s    |

None of them is a recording of a person. Each is a mono 16-bit PCM WAV at 24 kHz, stored as its lossless FLAC (`<id>.flac`), which `src/audio/flac.ts` decodes back to the same WAV, byte for byte. `manifest.json` records each sound's WAV SHA-256, byte length and duration and its FLAC's SHA-256 and length, and `core/bundled-samples.ts` pins the WAV hashes; a sound whose bytes do not match is refused. The phrase syllables occupy exact quarters of their file, one bar at 120 BPM.

DAWN's full studio library also has sung hooks and vocal books. They are not part of this package, and a score that names one renders only in DAWN.

The sound files are dedicated to the public domain under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). To the extent possible under law, the DAWN contributors waive copyright and related rights in them. No attribution is required.
