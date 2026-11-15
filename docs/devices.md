# Build a WebAssembly device

A device is a small WebAssembly module that a patch runs as one node: an effect, a synthesizer or a note transform. Use one when the built-in patch nodes cannot express the sound you want. A device can only compute. It has no imports, so it cannot read files, reach the network, read the clock or draw random numbers, and it runs under fixed budgets. The same device, settings and notes render the same bytes on every machine.

Palettes and patches stay declarative JSON. A device is the one programmable part, and DAWN checks it before it runs.

## Use a device in a patch

A patch names a device by the sha256 of its `.wasm` file. Put the file in your project's `devices/` folder under any name; DAWN finds it by hash. Get the hash with `shasum -a 256 devices/fold.wasm`.

```ts
import { fxPatch, note, patch, song, track, wasmDevice } from "dawn";

const fold = wasmDevice(
  "fx",
  "sha256:fe0563ee921a5d01c5f7780aa0471950000cc67a92be18e57c1b29c39b3ae989",
  { file: "devices/fold.wasm" },
);

const folded = fxPatch("folded", ({ input, device }) =>
  input.to(device.fx({ device: fold.device, p1: 0.5, p2: 0.8 })),
);

export default song({
  tempo: 120,
  bars: 1,
  tracks: [
    track({
      id: "bass",
      name: "Bass",
      instrument: patch("saw", ({ voice, osc, adsr, vca }) =>
        osc({ wave: "saw" })
          .pitch(voice.pitch)
          .to(vca().gain(adsr().gate(voice.gate))),
      ),
      fx: { patch: [folded] },
      notes: [note("A1", 0, 2), note("E2", 2, 2)],
    }),
  ],
});
```

The hash above is the example device, `examples/devices/fold.wasm` in the DAWN repository: a stereo wavefolder whose source is `examples/devices/fold.wat`. Copy it to `devices/fold.wasm` to try this song.

There are three node types:

| Node           | Ports                                                        | Use                                                                                          |
| -------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `device.fx`    | `left`, `right` in; `left`, `right` out; controls `p1`..`p8` | An effect, in an effect patch or after a voice. An unwired `right` takes `left`.             |
| `device.synth` | `notes` in (wire `in.notes`); `out`, `right` out; `p1`..`p8` | An instrument that plays every note of the track.                                            |
| `device.notes` | `notes` in and out; `p1`..`p8`                               | Rewrites the notes the whole patch plays: its voices and any `device.synth` play the result. |

Each control is 0..1 and accepts a value, a cable or a macro, like any other control port. A device reads its controls once per 128-frame block; a note device reads only the values set on the node. A patch holds at most one `device.notes`, and it cannot sit beside `engine.*` or nested patch nodes, which play the track's own notes. An effect patch cannot hold a synth or note device.

`dawn render` reads the `devices/` folder (at most 64 `.wasm` files, regular files only) and fails with the missing hash when a device is not there or does not pass its check. A synth device rings out for up to 2 seconds after its last note-off.

## Carry devices in a palette

A palette declares each device it uses beside its sounds:

```json
"devices": [
  {
    "id": "fold",
    "kind": "fx",
    "file": "devices/fold.wasm",
    "sha256": "fe0563ee921a5d01c5f7780aa0471950000cc67a92be18e57c1b29c39b3ae989"
  }
]
```

The file is `devices/<name>.wasm` next to the manifest, in lowercase. Every device node in a sound must name a declared device of the matching kind, and every declared device must be used. A palette holds at most 16 devices.

`dawn-palette check` reads each file, compares its hash with the declaration and checks the module against the ABI without running it. `dawn-palette export` names the device files the exported sound needs. `dawn-palette pack` copies the devices into `pack/devices/` and lists them in `SHA256SUMS`. See [Build a sound palette](./palettes.md) for the rest of the palette format.

## The ABI: `dawn.device/v1`

A device is a WebAssembly 1.0 module. It may use sign extension, saturating float-to-int conversion, multiple results and bulk memory operations. It must:

- import nothing: no functions, memory, tables or globals, so no WASI;
- define exactly one memory, export it as `memory` and declare a maximum of at most 256 pages (16 MiB); the memory may not be shared;
- export `init` and exactly one entry point;
- have no start function.

| Export      | Signature     | Kind    | Called                                                                      |
| ----------- | ------------- | ------- | --------------------------------------------------------------------------- |
| `init`      | `(f64) → i32` | all     | Once, with the sample rate. Returns the address of the device's I/O region. |
| `process`   | `(i32) → i32` | `fx`    | Once per block of 128 frames. Returns 0, or a non-zero error status.        |
| `render`    | `(i32) → i32` | `synth` | Once per block of 128 frames. Returns 0, or a non-zero error status.        |
| `transform` | `(i32) → i32` | `notes` | Once per group of up to 256 notes. Returns how many notes it wrote.         |

The I/O region belongs to the device, so it needs no allocator. It must be 8-byte aligned, above address 0 and inside memory. All values are little-endian. Before each call DAWN writes the controls and inputs; after it, DAWN reads the outputs.

**Audio devices** (`fx` and `synth`), offsets from the I/O address:

| Offset | Contents                                           |
| -----: | -------------------------------------------------- |
|      0 | `p1`..`p8`, 8 × f64                                |
|     64 | left input, 128 × f64 (zero for a synth)           |
|   1088 | right input, 128 × f64                             |
|   2112 | left output, 128 × f64 (cleared before each call)  |
|   3136 | right output, 128 × f64 (cleared before each call) |
|   4160 | event count, i32 (synth), then 4 bytes of padding  |
|   4168 | up to 64 events × 32 bytes                         |

An event is: frame within the block (i32), type (i32: 1 note-on, 0 note-off), voice (i32, the same for a note's on and off), MIDI note (i32), velocity 0..1 (f64), frequency in Hz with the track's tuning (f64). Events are sorted by frame, offs before ons. If more than 64 fall in one block, the rest arrive at frame 0 of the next. The region is 6,216 bytes.

**Note devices**, offsets from the I/O address:

| Offset | Contents                             |
| -----: | ------------------------------------ |
|      0 | `p1`..`p8`, 8 × f64                  |
|     64 | input notes, up to 256 × 40 bytes    |
|  10304 | output notes, up to 1,024 × 40 bytes |

A note is: start in frames (f64), length in frames (f64), MIDI pitch, which may be fractional (f64), velocity 0..1 (f64), source (i32), then 4 reserved bytes. Notes arrive in start order. An input note's source is its index in the track; an output note's source names the input note it came from, which may be from this call or an earlier one. A rewritten note keeps its source's tuning and moves by the change in pitch. The region is 51,264 bytes.

Samples are f64 because DAWN renders in f64. The block size is fixed: `process` and `render` always receive 128, and DAWN pads the last block of a render with silence.

## Limits

| Bound                  | Value                                                     | When it is passed                          |
| ---------------------- | --------------------------------------------------------- | ------------------------------------------ |
| Module size            | 1 MiB                                                     | The check fails.                           |
| Memory                 | 256 pages (16 MiB), declared maximum                      | The check fails; `memory.grow` returns -1. |
| Functions, types       | 8,192 functions, 4,096 types, 1 table                     | The check fails.                           |
| Locals per function    | 4,096, parameters included                                | The check fails.                           |
| `init` budget          | 67,108,864 instructions                                   | The render fails.                          |
| Block budget           | 4,194,304 instructions per `process` or `render`          | The render fails.                          |
| Transform budget       | 16,777,216 instructions per `transform`                   | The render fails.                          |
| Call depth             | 4,096 units; a call costs 1 unit per 8 locals, at least 1 | The render fails.                          |
| Notes from a transform | 1,024 per call, 65,536 per render                         | The render fails.                          |
| Output samples         | ±16 (+24 dBFS); NaN and infinity become 0                 | Clamped.                                   |

A trap (an out-of-bounds access, a division by zero, `unreachable`), a non-zero status or an invalid note also fails the render, naming the node. A device that fails stays failed; DAWN does not retry it.

## Determinism

DAWN rewrites each module before compiling it:

- **Instruction budget.** Each function entry and loop iteration subtracts its instruction count from a counter, and `memory.fill`, `memory.copy` and `memory.init` subtract one unit per 16 bytes. A call that runs out traps. The budget counts work, so a device that fits on one machine fits on every machine; it is not a timer.
- **Call depth.** Each call adds its frame weight to a depth counter, so recursion stops at the same depth everywhere rather than when the host's stack runs out.
- **NaN.** WebAssembly leaves the bits of some NaN results to the hardware: x86 and ARM disagree. After every arithmetic, rounding, `min`, `max`, `promote` and `demote` operation, DAWN replaces any NaN with the canonical quiet NaN. `abs`, `neg`, `copysign`, loads, stores and reinterpretation are already exact.

SIMD, threads, atomics, exception handling, tail calls, multiple memories and table bulk operations are refused. Relaxed SIMD in particular is defined to differ between machines.

Every render starts each device node from a fresh instance with zeroed memory and the module's data segments, initialized at the render's sample rate. DAWN feeds it the same blocks, controls and events in the same order every time.

What remains:

- **The engine.** The guarantee rests on Bun's WebAssembly implementation (JavaScriptCore) computing IEEE-754 arithmetic exactly, which the WebAssembly specification requires. A bug in the engine or in DAWN's rewriter is the remaining risk.
- **The host stack.** The depth limit is chosen to stay well inside a normal native stack, but a host with an unusually small stack could still run out first. That fails the render rather than changing its sound.
- **Memory growth.** A host out of memory could refuse `memory.grow` below the declared maximum.
- **Cost.** A device can use its whole budget on every block. The budgets bound a device's work but make no promise that a render is fast.

## Build a device

Any language that compiles to WebAssembly without imports works. The example is written in WebAssembly text (WAT) because it needs no compiler, runtime or allocator, its source shows the whole ABI in a few lines, and its output is small and reproducible. To assemble it, install [wabt](https://github.com/WebAssembly/wabt) and run:

```sh
wat2wasm fold.wat -o fold.wasm
shasum -a 256 fold.wasm
```

DAWN's tests assemble the example with wabt 1.0.39 and require the bytes to equal the committed `fold.wasm`, so you can use that file without installing anything.

The example's I/O region starts at byte 1024 of its one-page memory. Its `process` reads `p1` (drive) and `p2` (mix), folds each input sample back into -1..1 with a triangle fold and writes the result:

```wat
(func (export "process") (param $frames i32) (result i32)
  ;; for each frame i: out[i] = in[i] + mix × (fold(in[i] × gain) − in[i])
  ...
  (i32.const 0))
```

For a larger device:

- **Rust:** build a `#![no_std]` `cdylib` for `wasm32-unknown-unknown`, with `panic = "abort"`. Export `init` and the entry point with `#[no_mangle] pub extern "C"`, and return the address of a `static mut` I/O struct from `init`. Link with `-C link-arg=--max-memory=16777216` (at most 256 pages) and do not enable the `simd128` target feature. Check the output with `wasm-objdump -x` for an empty import section.
- **AssemblyScript:** compile with `--runtime stub --maximumMemory 256 --use abort=` so that the module imports no `env.abort` and has a bounded memory, and export the functions from the entry file.

`dawn-palette check` reports the first rule a module breaks. A device built with a general-purpose toolchain commonly imports a function for panics or logging. Remove that import and the check passes.
