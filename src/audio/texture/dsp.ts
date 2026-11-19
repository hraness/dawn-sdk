// SPDX-License-Identifier: MIT
/**
 * Small building blocks for the texture engine: a sequential seeded
 * generator, pink and brown noise, filters whose coefficients can move every
 * sample, a smooth random walk and the 8x8 Hadamard feedback delay network.
 * Everything is float64 arithmetic in a fixed order, so a voice renders the
 * same bytes on every run and worker.
 */
import { seedHash } from "../dsp/rng.ts";

function mulberry(state: number): number {
  let value = Math.imul(state ^ (state >>> 15), 1 | state);
  value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
  return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
}

/**
 * mulberry32 over two 32-bit states: integer-only, identical everywhere.
 * `next` and friends draw events and slow motion; `noise` draws audio-rate
 * white noise from its own stream, so the events (drops, gusts, cars) fall
 * at the same times at any sample rate.
 */
export class Rng {
  private state: number;
  private noiseState: number;
  private readonly scale: number;

  /**
   * `sampleRate`, when given, scales `noise()` so white noise keeps the
   * same power per hertz at any rate (unit-range at 44.1 kHz): a
   * band-passed bed then measures the same at 22.05 and 48 kHz.
   */
  constructor(seed: string, sampleRate = 44_100) {
    this.state = seedHash(seed);
    this.noiseState = seedHash(`${seed}:noise`);
    this.scale = Math.sqrt(sampleRate / 44_100);
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    return mulberry(this.state);
  }

  /** One white-noise sample, uniform and rate-scaled (see the constructor). */
  noise(): number {
    this.noiseState = (this.noiseState + 0x6d2b79f5) >>> 0;
    return (2 * mulberry(this.noiseState) - 1) * this.scale;
  }

  /** Uniform in [-1, 1). */
  bi(): number {
    return 2 * this.next() - 1;
  }

  /** Uniform in [lo, hi). */
  range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.next();
  }

  /** An exponential wait with mean `1 / rate`, in the same units. */
  wait(rate: number): number {
    return -Math.log(1 - this.next()) / Math.max(1e-9, rate);
  }
}

/** Paul Kellet's economy pink filter over white noise (about 0 dB at 1 kHz). */
export class Pink {
  private b0 = 0;
  private b1 = 0;
  private b2 = 0;

  process(white: number): number {
    this.b0 = 0.99765 * this.b0 + white * 0.099046;
    this.b1 = 0.963 * this.b1 + white * 0.2965164;
    this.b2 = 0.57 * this.b2 + white * 1.0526913;
    return (this.b0 + this.b1 + this.b2 + white * 0.1848) * 0.25;
  }
}

/** Leaky-integrated brown noise, roughly unit RMS. */
export class Brown {
  private y = 0;
  private readonly leak: number;

  constructor(sampleRate: number) {
    // A 20 Hz corner: -6 dB/oct above it, flat below.
    this.leak = Math.exp((-2 * Math.PI * 20) / sampleRate);
  }

  process(white: number): number {
    this.y = this.leak * this.y + (1 - this.leak) * white;
    return this.y * 7;
  }
}

/** One-pole low-pass whose corner can change at any sample. */
export class Lp1 {
  private a = 1;
  y = 0;

  set(hz: number, sampleRate: number): void {
    const f = Math.min(Math.max(hz, 5), sampleRate * 0.49);
    this.a = 1 - Math.exp((-2 * Math.PI * f) / sampleRate);
  }

  process(x: number): number {
    this.y += this.a * (x - this.y);
    return this.y;
  }
}

/** One-pole high-pass (input minus its one-pole low-pass). */
export class Hp1 {
  private readonly lp = new Lp1();

  set(hz: number, sampleRate: number): void {
    this.lp.set(hz, sampleRate);
  }

  process(x: number): number {
    return x - this.lp.process(x);
  }
}

/**
 * Topology-preserving state-variable filter (Zavalishin): its state stays
 * valid while the cutoff and Q move, so gusts and sweeps can retune it every
 * few samples. `band` is normalized to 0 dB at the peak.
 */
export class Svf {
  private k = 1;
  private a1 = 1;
  private a2 = 0;
  private a3 = 0;
  private ic1 = 0;
  private ic2 = 0;
  low = 0;
  band = 0;
  high = 0;

  set(hz: number, q: number, sampleRate: number): void {
    const f = Math.min(Math.max(hz, 10), sampleRate * 0.45);
    const g = Math.tan((Math.PI * f) / sampleRate);
    this.k = 1 / Math.max(0.05, q);
    this.a1 = 1 / (1 + g * (g + this.k));
    this.a2 = g * this.a1;
    this.a3 = g * this.a2;
  }

  /** Runs one sample; returns the normalized band-pass. */
  process(x: number): number {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    this.low = v2;
    this.band = this.k * v1;
    this.high = x - this.k * v1 - v2;
    return this.band;
  }
}

/**
 * A smooth random walk in [0, 1]: a new target every `period` seconds on
 * average, reached along a raised-cosine path, so gusts and swells never
 * step. Read once per control block.
 */
export class Drift {
  private from: number;
  private to: number;
  private at = 0;
  private span = 1;

  constructor(
    private readonly rng: Rng,
    start = 0.5,
  ) {
    this.from = start;
    this.to = start;
  }

  /** Advances `dt` seconds and returns the value. */
  step(dt: number, period: number, depth = 1): number {
    this.at += dt;
    if (this.at >= this.span) {
      this.at -= this.span;
      this.from = this.to;
      this.to = 0.5 + depth * (this.rng.next() - 0.5);
      this.span = Math.max(0.02, period * (0.5 + this.rng.next()));
      if (this.at > this.span) this.at = 0;
    }
    const x = this.at / this.span;
    return (
      this.from + (this.to - this.from) * (0.5 - 0.5 * Math.cos(Math.PI * x))
    );
  }
}

/** Number of delay lines in the FDN. */
const LINES = 8;

/**
 * An 8x8 feedback delay network (Jot and Chaigne; Stautner and Puckette)
 * with a normalized fast Hadamard mixing matrix, one-pole damping in each
 * loop and slowly modulated, linearly interpolated delays so the tail never
 * rings metallic. Lines 0-3 feed the left output, 4-7 the right, so a mono
 * input comes out as two decorrelated channels.
 */
export class Fdn {
  private readonly buffers: Float64Array[] = [];
  private readonly lengths: number[] = [];
  private readonly gains: number[] = [];
  private readonly damp: number[] = [];
  private readonly state: number[] = new Array(LINES).fill(0);
  private readonly rates: number[] = [];
  private readonly phases: number[] = [];
  private readonly depth: number;
  private readonly mask: number;
  private write = 0;
  private readonly y = new Float64Array(LINES);
  private dampA = 1;

  /**
   * `delays` are the eight base delays in seconds; `t60` the decay time;
   * `damping` the loop low-pass corner in Hz.
   */
  constructor(
    private readonly sampleRate: number,
    delays: readonly number[],
    t60: number,
    damping: number,
    rng: Rng,
  ) {
    this.depth = Math.max(1, Math.round(0.0012 * sampleRate));
    const longest =
      Math.ceil(Math.max(...delays) * sampleRate) + this.depth + 4;
    let size = 1;
    while (size < longest) size <<= 1;
    this.mask = size - 1;
    for (let i = 0; i < LINES; i += 1) {
      this.buffers.push(new Float64Array(size));
      this.lengths.push(delays[i]! * sampleRate);
      this.rates.push(rng.range(0.07, 0.6));
      this.phases.push(rng.next());
      this.damp.push(0);
    }
    this.setDecay(t60, damping);
  }

  /** Retunes the decay time and loop damping (cheap: eight pow calls). */
  setDecay(t60: number, damping: number): void {
    const t = Math.max(0.05, t60);
    this.gains.length = 0;
    for (let i = 0; i < LINES; i += 1)
      this.gains.push(10 ** ((-3 * this.lengths[i]!) / (t * this.sampleRate)));
    const f = Math.min(Math.max(damping, 200), this.sampleRate * 0.45);
    this.dampA = 1 - Math.exp((-2 * Math.PI * f) / this.sampleRate);
  }

  /** Feeds `input` and writes the two outputs into `out[0]`, `out[1]`. */
  process(input: number, out: Float64Array): void {
    const y = this.y;
    const step = 1 / this.sampleRate;
    for (let i = 0; i < LINES; i += 1) {
      let phase = this.phases[i]! + this.rates[i]! * step;
      if (phase >= 1) phase -= 1;
      this.phases[i] = phase;
      // A triangle wobble is cheaper than a sine and just as smooth here.
      const tri = phase < 0.5 ? 4 * phase - 1 : 3 - 4 * phase;
      const delay = this.lengths[i]! + 0.5 * this.depth * (1 + tri);
      const read = this.write - delay;
      const base = Math.floor(read);
      const frac = read - base;
      const buffer = this.buffers[i]!;
      const a = buffer[base & this.mask]!;
      const b = buffer[(base + 1) & this.mask]!;
      let v = a + frac * (b - a);
      // Loop damping.
      const s = this.state[i]! + this.dampA * (v - this.state[i]!);
      this.state[i] = Math.abs(s) < 1e-25 ? 0 : s;
      v = s * this.gains[i]!;
      y[i] = v;
    }
    out[0] = y[0]! + y[1]! + y[2]! + y[3]!;
    out[1] = y[4]! + y[5]! + y[6]! + y[7]!;
    // In-place fast Walsh-Hadamard transform, normalized by 1/sqrt(8).
    for (let h = 1; h < LINES; h <<= 1)
      for (let i = 0; i < LINES; i += h << 1)
        for (let j = i; j < i + h; j += 1) {
          const p = y[j]!;
          const q = y[j + h]!;
          y[j] = p + q;
          y[j + h] = p - q;
        }
    const norm = 0.3535533905932738;
    const w = this.write & this.mask;
    for (let i = 0; i < LINES; i += 1)
      this.buffers[i]![w] = y[i]! * norm + (i & 1 ? -input : input);
    this.write += 1;
  }
}

/** The PolyBLEP correction for a naive sawtooth at phase `t` (0..1). */
export function polyBlep(t: number, dt: number): number {
  if (t < dt) {
    const x = t / dt;
    return x + x - x * x - 1;
  }
  if (t > 1 - dt) {
    const x = (t - 1) / dt;
    return x * x + x + x + 1;
  }
  return 0;
}
