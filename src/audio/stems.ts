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

/**
 * Where an arranged render puts its stems as its windows join
 * (`ArrangedRenderOptions.stemSink`): `StemAccumulator` keeps them whole,
 * `StemStream` writes them out as they settle.
 */
export interface StemSink {
  add(
    id: string,
    offset: number,
    left: Float64Array,
    right: Float64Array,
    from?: number,
    to?: number,
    fadeIn?: number,
  ): void;
  fadeOut(end: number, fade: number): void;
  setPreMaster(left: ArrayLike<number>, right: ArrayLike<number>): void;
  setPreMasterPcm(pcm: Int16Array, frames: number): void;
}

/** Collects window stems at song offsets (internal to arranged renders). */
export class StemAccumulator implements StemSink {
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

/** Where `StemStream` sends a stem's settled frames, in order. */
export type StemWriter = {
  write(left: Float32Array, right: Float32Array): void;
};

type Tail = {
  out: StemWriter;
  /** Song frame of `left[0]`; every frame before it is written. */
  base: number;
  left: Float32Array;
  right: Float32Array;
  /** The first frame a later window may still change. */
  settled: number;
};

/**
 * `StemAccumulator`'s arithmetic, written out as it goes instead of kept:
 * the same Float32 sums in the same order, so each stem's frames are the
 * accumulator's, bit for bit, but a song of stems is never held at once.
 *
 * Windows join in song order and a window touches nothing before its own
 * offset, its seam fade-in reaching at most `hold` frames before the end of
 * the window before it. So once a track's stem for a window is added, all
 * but its last `hold` frames are final and go to its writer. That needs
 * each id added once a window (a render's taps are), so `StemStream` takes
 * no grouping. A write into frames already written is an error, never
 * different audio.
 */
export class StemStream implements StemSink {
  private readonly tails = new Map<string, Tail>();
  private premaster: StemWriter | undefined;
  private ended = false;

  public constructor(
    public readonly sampleRate: number,
    private readonly open: (name: string) => StemWriter,
    private readonly hold: number,
  ) {}

  /** Stems in the order they first joined the mix. */
  public get names(): readonly string[] {
    return [...this.tails.keys()];
  }

  private tail(name: string): Tail {
    let tail = this.tails.get(name);
    if (!tail) {
      tail = {
        out: this.open(name),
        base: 0,
        left: new Float32Array(0),
        right: new Float32Array(0),
        settled: 0,
      };
      this.tails.set(name, tail);
    }
    return tail;
  }

  /** Room for song frames up to `end` in `tail`'s buffer. */
  private reach(tail: Tail, end: number): void {
    const need = end - tail.base;
    if (need <= tail.left.length) return;
    const size = Math.max(need, Math.ceil(tail.left.length * 1.5));
    const left = new Float32Array(size);
    const right = new Float32Array(size);
    left.set(tail.left);
    right.set(tail.right);
    tail.left = left;
    tail.right = right;
  }

  /** Write `tail`'s frames before song frame `until` and drop them. */
  private flush(tail: Tail, until: number): void {
    const count = until - tail.base;
    if (count <= 0) return;
    this.reach(tail, until);
    tail.out.write(tail.left.slice(0, count), tail.right.slice(0, count));
    tail.left.copyWithin(0, count);
    tail.right.copyWithin(0, count);
    tail.left.fill(0, tail.left.length - count);
    tail.right.fill(0, tail.right.length - count);
    tail.base = until;
  }

  public add(
    id: string,
    offset: number,
    left: Float64Array,
    right: Float64Array,
    from = 0,
    to = left.length,
    fadeIn = 0,
  ): void {
    if (this.ended) throw new Error("stems added after the stream ended");
    if (to <= from) return;
    const tail = this.tail(id);
    if (offset < tail.base)
      throw new Error(
        `stem ${id} changes frame ${offset}, already written (to ${tail.base})`,
      );
    const end = offset + (to - from);
    this.reach(tail, end);
    const at = offset - tail.base;
    const outL = tail.left;
    const outR = tail.right;
    for (let i = from; i < to; i += 1) {
      const frame = i - from;
      const gain = frame < fadeIn ? (frame + 0.5) / fadeIn : 1;
      outL[at + frame]! += left[i]! * gain;
      outR[at + frame]! += right[i]! * gain;
    }
    tail.settled = Math.max(tail.settled, end - this.hold);
    this.flush(tail, tail.settled);
  }

  public fadeOut(end: number, fade: number): void {
    for (const [name, tail] of this.tails)
      for (let frame = 0; frame < fade; frame += 1) {
        const at = end - fade + frame;
        if (at < 0) continue;
        if (at < tail.base)
          throw new Error(
            `stem ${name} fades frame ${at}, already written (to ${tail.base})`,
          );
        const index = at - tail.base;
        if (index >= tail.left.length) continue;
        const gain = 1 - (frame + 0.5) / fade;
        tail.left[index]! *= gain;
        tail.right[index]! *= gain;
      }
  }

  private writePremaster(
    frames: number,
    sample: (frame: number, channel: 0 | 1) => number,
  ): void {
    if (this.premaster) throw new Error("the pre-master mix was written twice");
    this.premaster = this.open("premaster");
    const chunk = 1 << 16;
    for (let start = 0; start < frames; start += chunk) {
      const n = Math.min(chunk, frames - start);
      const left = new Float32Array(n);
      const right = new Float32Array(n);
      for (let i = 0; i < n; i += 1) {
        left[i] = sample(start + i, 0);
        right[i] = sample(start + i, 1);
      }
      this.premaster.write(left, right);
    }
  }

  public setPreMaster(left: ArrayLike<number>, right: ArrayLike<number>) {
    this.writePremaster(left.length, (i, c) => (c === 0 ? left : right)[i]!);
  }

  public setPreMasterPcm(pcm: Int16Array, frames: number): void {
    this.writePremaster(frames, (i, c) => pcm[2 * i + c]! / 32767);
  }

  /**
   * The song is `frames` long: write what each stem still holds, cut or
   * padded with silence to exactly that length, as `result` makes it.
   */
  public finish(frames: number): void {
    if (this.ended) return;
    this.ended = true;
    for (const [name, tail] of this.tails) {
      if (tail.base > frames)
        throw new Error(
          `stem ${name} was written to frame ${tail.base}, past the song's ${frames}`,
        );
      this.flush(tail, frames);
    }
    // A render without a pre-master mix has a silent one, as `result` gives.
    if (!this.premaster) this.writePremaster(frames, () => 0);
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
