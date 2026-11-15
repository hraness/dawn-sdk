/**
 * Stem taps joined over a whole song: per-track (or per-group) pre-master
 * stems and the pre-master mix from one render (`renderArrangedStems`).
 * Windows add their stems at song offsets with the same seam fades the
 * mix uses, so the stems sum to the pre-master mix: exactly (to Float32)
 * for a single pass, within the windows' 16-bit rounding for long songs.
 */
import { encodeWavFloat32 } from "../measure/audio.ts";
import type { RenderedAudio, StemTaps } from "./wav.ts";

export type StemPair = { left: Float32Array; right: Float32Array };

export type ArrangedStems = Readonly<{
  sampleRate: number;
  frames: number;
  /** In the order the stems first joined the mix. */
  stems: ReadonlyMap<string, StemPair>;
  preMaster: StemPair;
}>;

/** Collects window stems at song offsets (internal to arranged renders). */
export class StemAccumulator {
  private readonly groups = new Map<string, StemPair>();
  private capacity: number;
  private length = 0;
  private premaster: StemPair | undefined;

  public constructor(
    public readonly sampleRate: number,
    private readonly group: (id: string) => string | undefined,
    capacity = 0,
  ) {
    this.capacity = Math.max(1, capacity);
  }

  private pair(name: string): StemPair {
    let pair = this.groups.get(name);
    if (!pair) {
      pair = {
        left: new Float32Array(this.capacity),
        right: new Float32Array(this.capacity),
      };
      this.groups.set(name, pair);
    }
    return pair;
  }

  private ensure(frames: number): void {
    if (frames <= this.capacity) return;
    const capacity = Math.max(frames, Math.ceil(this.capacity * 1.5));
    for (const [name, pair] of this.groups) {
      const left = new Float32Array(capacity);
      const right = new Float32Array(capacity);
      left.set(pair.left);
      right.set(pair.right);
      this.groups.set(name, { left, right });
    }
    this.capacity = capacity;
  }

  /**
   * Add `left/right[from, to)` at song frame `offset`, the first `fadeIn`
   * frames ramped in as the window join does.
   */
  public add(
    id: string,
    offset: number,
    left: Float64Array,
    right: Float64Array,
    from = 0,
    to = left.length,
    fadeIn = 0,
  ): void {
    const name = this.group(id);
    if (name === undefined || to <= from) return;
    this.ensure(offset + (to - from));
    const pair = this.pair(name);
    for (let i = from; i < to; i += 1) {
      const frame = i - from;
      const gain = frame < fadeIn ? (frame + 0.5) / fadeIn : 1;
      pair.left[offset + frame]! += left[i]! * gain;
      pair.right[offset + frame]! += right[i]! * gain;
    }
    this.length = Math.max(this.length, offset + (to - from));
  }

  /** Fade out `fade` frames ending at song frame `end` (a seam). */
  public fadeOut(end: number, fade: number): void {
    for (const pair of this.groups.values())
      for (let frame = 0; frame < fade; frame += 1) {
        const at = end - fade + frame;
        if (at < 0 || at >= this.capacity) continue;
        const gain = 1 - (frame + 0.5) / fade;
        pair.left[at]! *= gain;
        pair.right[at]! *= gain;
      }
  }

  /**
   * Fold what lies past `frames` back onto the start, as a looped mix
   * folds its tail: each stem then loops like the mix it sums to.
   */
  public fold(frames: number): void {
    if (frames <= 0 || this.length <= frames) return;
    for (const pair of this.groups.values())
      for (let at = frames; at < this.length; at += 1) {
        pair.left[at % frames]! += pair.left[at]!;
        pair.right[at % frames]! += pair.right[at]!;
        pair.left[at] = 0;
        pair.right[at] = 0;
      }
    this.length = frames;
  }

  public setPreMaster(left: ArrayLike<number>, right: ArrayLike<number>) {
    this.premaster = {
      left: Float32Array.from(left),
      right: Float32Array.from(right),
    };
  }

  public setPreMasterPcm(pcm: Int16Array, frames: number): void {
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    for (let i = 0; i < frames; i += 1) {
      left[i] = pcm[2 * i]! / 32767;
      right[i] = pcm[2 * i + 1]! / 32767;
    }
    this.premaster = { left, right };
  }

  public result(frames: number): ArrangedStems {
    const stems = new Map<string, StemPair>();
    for (const [name, pair] of this.groups) {
      // The accumulator's own samples when they reach `frames`: a stem is
      // held once.
      if (pair.left.length >= frames) {
        stems.set(name, {
          left: pair.left.subarray(0, frames),
          right: pair.right.subarray(0, frames),
        });
        continue;
      }
      const left = new Float32Array(frames);
      const right = new Float32Array(frames);
      left.set(pair.left);
      right.set(pair.right);
      stems.set(name, { left, right });
    }
    return {
      sampleRate: this.sampleRate,
      frames,
      stems,
      preMaster: this.premaster ?? {
        left: new Float32Array(frames),
        right: new Float32Array(frames),
      },
    };
  }
}

/** Float WAV bytes of one stem pair. */
export function stemWav(pair: StemPair, sampleRate: number): Uint8Array {
  // The encoder writes 32-bit floats: the pair's own samples, no copy.
  return encodeWavFloat32({ sampleRate, left: pair.left, right: pair.right });
}

/** A file-name-safe stem name. */
export function stemFileName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, "_") || "_";
}

/**
 * One window's stem tap, packed for the trip from a worker: only the
 * frames the join reads. The seam head (where a fade-in sums onto the
 * previous window) stays Float64; the body, which lands on silent
 * accumulator frames, is Float32, exactly what the accumulator stores.
 */
export type PackedStem = Readonly<{
  id: string;
  /** Length of the window's stem (the join's `until` reads it). */
  length: number;
  /** First frame of `headLeft`; the body starts at `headFrom + head length`. */
  headFrom: number;
  headLeft: Float64Array;
  headRight: Float64Array;
  bodyLeft: Float32Array;
  bodyRight: Float32Array;
}>;

/** A window rendered elsewhere: its audio and its stems in tap order. */
export type TappedWindow = Readonly<{
  audio: RenderedAudio;
  stems: readonly PackedStem[];
}>;

/** Pack a window's stem: frames [keep.from - keep.seam, keep.to) only. */
export function packWindowStem(
  id: string,
  left: Float64Array,
  right: Float64Array,
  keep: Readonly<{ from: number; to?: number; seam: number }>,
): PackedStem {
  const length = left.length;
  const from = Math.max(0, Math.min(length, keep.from));
  const headFrom = Math.max(0, from - keep.seam);
  const to = Math.max(from, Math.min(length, keep.to ?? length));
  return {
    id,
    length,
    headFrom,
    headLeft: left.slice(headFrom, from),
    headRight: right.slice(headFrom, from),
    bodyLeft: Float32Array.from(left.subarray(from, to)),
    bodyRight: Float32Array.from(right.subarray(from, to)),
  };
}

/** Buffers a packed stem holds, for a transfer list. */
export function packedBuffers(stems: readonly PackedStem[]): ArrayBuffer[] {
  return stems.flatMap((s) =>
    [s.headLeft, s.headRight, s.bodyLeft, s.bodyRight].map(
      (a) => a.buffer as ArrayBuffer,
    ),
  );
}

/**
 * Feed a tapped window's stems to `taps` as its render would have. Frames
 * outside the packed span are zero; the join never reads them.
 */
export function replayWindowStems(window: TappedWindow, taps: StemTaps): void {
  for (const stem of window.stems) {
    const left = new Float64Array(stem.length);
    const right = new Float64Array(stem.length);
    left.set(stem.headLeft, stem.headFrom);
    right.set(stem.headRight, stem.headFrom);
    const body = stem.headFrom + stem.headLeft.length;
    left.set(stem.bodyLeft, body);
    right.set(stem.bodyRight, body);
    taps.stem(stem.id, left, right);
  }
}
