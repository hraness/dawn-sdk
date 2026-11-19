// SPDX-License-Identifier: MIT
/** Sample placement and mixing shared by the offline and browser renderers. */
import type { Note, Track, TrackScore } from "../../core/score.ts";
import type { PerformedNote } from "../../core/expression.ts";
import { noteHz, type TuningTable } from "../../core/tuning.ts";
import { CONTROL_SAMPLES, interpolateAutomation } from "./effects/common.ts";
import { legacyWaveFor } from "./synth/oscillators.ts";
import { warpedSpan, type SampleWarp } from "./warp.ts";

type VoiceMixContext = Readonly<{
  score: TrackScore;
  sampleRate: number;
  samples: number;
  samplesPerTick: number;
  warp?: SampleWarp;
}>;

/** Output channel count for every render and export. */
export const RENDER_CHANNELS = 2 as const;
export const DEFAULT_SAMPLE_RATE = 22_050;

export function clampSampleRate(sampleRate?: number): number {
  return Math.max(
    8_000,
    Math.min(48_000, Math.floor(sampleRate ?? DEFAULT_SAMPLE_RATE)),
  );
}

/** One-shot renders keep this much ring-out after the last bar. */
const ONE_SHOT_TAIL_SECONDS = 0.35;

export function oneShotSeconds(
  loopSeconds: number,
  samplerTail: number,
  reverbTail: number,
  delayTail = 0,
): number {
  return (
    loopSeconds +
    Math.max(ONE_SHOT_TAIL_SECONDS, samplerTail) +
    reverbTail +
    delayTail
  );
}

/** Track volume and volume automation at a score tick (pan is applied in stereo). */
export function trackGainAt(track: Track | undefined, tick: number): number {
  const trackGain = Math.max(0, Math.min(1, track?.volume ?? 1));
  const automatedGain = interpolateAutomation(
    track?.volumeAutomation ?? [],
    tick,
    1,
  );
  return trackGain * automatedGain;
}

export function noteSpan(
  note: Note,
  context: VoiceMixContext,
): { start: number; length: number } {
  const { score, sampleRate, warp } = context;
  if (warp) return warpedSpan(warp, note.startTick, note.durationTicks);
  const start = Math.max(
    0,
    Math.floor(
      (((note.startTick / score.ticksPerBeat) * 60) / score.tempoBpm) *
        sampleRate,
    ),
  );
  const length = Math.max(
    1,
    Math.floor(
      (((note.durationTicks / score.ticksPerBeat) * 60) / score.tempoBpm) *
        sampleRate,
    ),
  );
  return { start, length };
}

export function renderToneNote(
  target: Float64Array,
  note: Note,
  track: Track | undefined,
  context: VoiceMixContext,
  tuning?: TuningTable,
): void {
  const { sampleRate, samples, samplesPerTick } = context;
  const instrument = track?.instrument ?? "sine";
  const { start, length } = noteSpan(note, context);
  const end = Math.min(samples, start + length);
  const frequency = noteHz(note.pitch, note.cents, tuning);
  if (!(frequency > 0)) return;
  const velocity = Math.max(0, Math.min(1, note.velocity));
  const performance = (note as PerformedNote).performance;
  const cents = performance?.cents;
  let bent = 0;
  const wave = legacyWaveFor(instrument);
  for (let index = start; index < end; index += 1) {
    const elapsed = index - start;
    const remaining = end - index;
    const attack = Math.min(1, elapsed / Math.max(1, sampleRate * 0.012));
    const release = Math.min(1, remaining / Math.max(1, sampleRate * 0.09));
    const envelope =
      Math.min(attack, release) *
      velocity *
      0.28 *
      trackGainAt(
        track,
        context.warp
          ? context.warp.tick(index)
          : note.startTick + elapsed / samplesPerTick,
      );
    // Plain notes keep the closed-form phase (byte-identical output).
    let phase = (frequency * elapsed) / sampleRate;
    if (cents) {
      phase = bent;
      bent +=
        (frequency * 2 ** (cents(elapsed / sampleRate) / 1200)) / sampleRate;
    }
    const damp = performance?.damp;
    const t = elapsed / sampleRate;
    const held =
      damp && t > damp.from ? Math.exp(-(t - damp.from) / damp.tau) : 1;
    target[index]! += wave(phase) * envelope * held;
  }
}

/**
 * Equal-power pan of the mono track into the stereo pair: left = cos(θ),
 * right = sin(θ) with θ = (pan + 1)·π/4, so the summed power is constant
 * and a centred track sits 3 dB down in each channel.
 */
export function applyPan(
  dry: Float64Array,
  left: Float64Array,
  right: Float64Array,
  track: Track | undefined,
  context: VoiceMixContext,
  dryRight?: Float64Array,
): void {
  const lane = track?.panAutomation ?? [];
  const staticPan = track?.pan ?? 0;
  const gains = (pan: number): [number, number] => {
    const theta = ((Math.max(-1, Math.min(1, pan)) + 1) * Math.PI) / 4;
    return [Math.cos(theta), Math.sin(theta)];
  };
  let [gainL, gainR] = gains(staticPan);
  for (let index = 0; index < dry.length; index += 1) {
    if (lane.length > 0 && index % CONTROL_SAMPLES === 0)
      [gainL, gainR] = gains(
        interpolateAutomation(
          lane,
          context.warp
            ? context.warp.tick(index)
            : index / context.samplesPerTick,
          staticPan,
        ),
      );
    const sample = dry[index]!;
    left[index] = sample * gainL;
    // A stereo voice pans its own right channel the same way.
    right[index] = (dryRight ? dryRight[index]! : sample) * gainR;
  }
}

export function toPcm(
  mixL: Float64Array,
  mixR: Float64Array,
  frames: number,
  dither = false,
): Int16Array {
  const pcm = new Int16Array(frames * RENDER_CHANNELS);
  if (dither) {
    // Triangular dither of +-1 LSB: the sum of two uniform values, from a
    // fixed-seed xorshift so every render of a score dithers the same way.
    let state = 0x9e3779b9;
    const uniform = () => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>> 0) / 4_294_967_296;
    };
    for (let index = 0; index < frames; index += 1) {
      pcm[index * 2] = clamp16(
        Math.round(mixL[index]! * 32767 + uniform() - uniform()),
      );
      pcm[index * 2 + 1] = clamp16(
        Math.round(mixR[index]! * 32767 + uniform() - uniform()),
      );
    }
    return pcm;
  }
  for (let index = 0; index < frames; index += 1) {
    pcm[index * 2] = clamp16(mixL[index]! * 32767);
    pcm[index * 2 + 1] = clamp16(mixR[index]! * 32767);
  }
  return pcm;
}

function clamp16(value: number): number {
  return Math.max(-32_768, Math.min(32_767, Math.round(value)));
}
