/**
 * The song `bun run check` renders with `dawn-render`, and the SHA-256 of
 * the WAV DAWN itself writes for it (`dawn render out.wav` in a project
 * holding this song and `devices/fold.wasm`). DAWN's own test suite renders
 * the song with the full application and fails when that digest changes, so
 * a deliberate sound change in DAWN updates it here in the same change.
 *
 * It covers the sealed evaluator, a drum kit, a synthesized bass through a
 * WebAssembly device, a piano with a reverb send, a studio sample and the
 * master chain.
 */
export const RENDER_SONG = `import {
  fxPatch,
  hit,
  note,
  pattern,
  patch,
  progression,
  sampler,
  song,
  track,
  wasmDevice,
} from "dawn";

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
  key: "A minor",
  bars: 2,
  master: { limiter: {} },
  tracks: [
    track({ name: "Drums", instrument: "kit", rhythm: pattern("house") }),
    track({
      id: "bass",
      name: "Bass",
      instrument: patch("saw", ({ voice, osc, adsr, vca }) =>
        osc({ wave: "saw" })
          .pitch(voice.pitch)
          .to(vca().gain(adsr().gate(voice.gate))),
      ),
      fx: { patch: [folded] },
      notes: [note("A1", 0, 2), note("F1", 2, 2), note("G1", 4, 4)],
    }),
    track({
      name: "Keys",
      instrument: "piano",
      notes: progression("i VI"),
      send: { reverb: 0.4 },
    }),
    track({
      name: "Glass",
      instrument: sampler({ glass: "pack:studio/glass-hit" }),
      notes: [hit("glass", 0), hit("glass", 3)],
    }),
  ],
});
`;

/** SHA-256 of the WAV `dawn render` writes for RENDER_SONG. */
export const RENDER_WAV_SHA256 =
  "2b7209408b783ce5f99b1dae084e522977d2dc39adc5ccc690a0fb931b3c2f59";
