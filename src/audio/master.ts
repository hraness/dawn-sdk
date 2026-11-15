/**
 * The song master (core/master.ts) as DSP: trim (gain staging), EQ, glue
 * compressor, tape, width, a soft clipper, a DC blocker and a true-peak
 * limiter on the summed mix, then the loudness target. Everything is
 * offline over whole buffers in float64 with a fixed order of operations,
 * so masters render deterministically.
 *
 * Loops are processed as if they played forever: the chain runs over
 * warm-up repeats and keeps one steady-state pass, so the loop seam is
 * seamless. One-shot renders start from silence.
 */
import {
  MASTER_LIMITS,
  MULTIBAND_BANDS,
  masterActive,
  TONE_BANDS,
  toneReach,
  type SongMaster,
} from "../../core/master.ts";
import type { FxValues } from "../../core/params.ts";
import {
  gainToDb,
  integratedLoudness,
  interSamplePeaks,
  truePeakGain,
} from "./loudness.ts";

export type MasterReport = Readonly<{
  /** Gain the target applied (into the limiter when it is on), dB. */
  gainDb: number;
  /** Integrated loudness after the master, LUFS. */
  integrated: number;
  /** True peak after the master, dBTP. */
  truePeak: number;
  target?: number;
  /** Whether the target was met within 0.5 LU. */
  reached?: boolean;
  /** Limiter passes the target search used (0 without one). */
  runs?: number;
}>;

export type MasterOutput = Readonly<{
  left: Float64Array;
  right: Float64Array;
  report: MasterReport;
}>;

/** Seconds of warm-up a loop gets before the pass that is kept. */
const LOOP_WARMUP_SECONDS = 2;

/**
 * How a preview's master may differ from a finished render's. Only the
 * live session asks for it (`RenderOptions.masterPreview`); `dawn render`
 * never does, so a rendered file is the full master.
 */
export type MasterPreview = Readonly<{
  /**
   * Warm a loop with this many seconds of its own tail instead of whole
   * passes of it. A finished loop repeats whole until the warm-up is at
   * least `LOOP_WARMUP_SECONDS`, which for a loop longer than that is one
   * whole extra pass: a 48 s song is mastered over 96 s. The units settle
   * in far less, so a preview of a loop longer than this is warmed by its
   * last seconds only; a shorter loop is warmed as a finished one is.
   */
  warmSeconds?: number;
}>;
const TARGET_TOLERANCE_LU = 0.05;
const TARGET_ITERATIONS = 8;
/** LU per dB of drive below which the limiter is on its plateau. */
const PLATEAU_SLOPE = 0.05;
/** Largest single step the bracketing search takes, dB. */
const MAX_TARGET_STEP = 12;
/** Extra samples so true-peak interpolation past the lookahead is real. */
const TRUE_PEAK_PAD = 18;

/**
 * Masters the first `frames` samples of a mix. Returns undefined for a
 * master that changes nothing, so callers keep the plain mix (and DAWN 0.4
 * renders stay byte-identical).
 */
export function applyMaster(
  mixL: Float64Array,
  mixR: Float64Array,
  frames: number,
  sampleRate: number,
  master: SongMaster | undefined,
  loop: boolean,
  inputPcm?: Int16Array,
  preview?: MasterPreview,
): MasterOutput | undefined {
  if (!masterActive(master) || frames <= 0) return undefined;
  const song = master!;
  const lookahead = song.limiter
    ? Math.max(
        1,
        Math.round((Number(song.limiter.lookahead) * sampleRate) / 1000),
      )
    : 0;
  // A loop is laid out as warm-up repeats, the kept pass and enough of the
  // next pass for the limiter to look ahead into; a one-shot is the mix
  // followed by silence the limiter can look into.
  const whole = loop
    ? Math.ceil((LOOP_WARMUP_SECONDS * sampleRate) / frames) * frames
    : 0;
  const tail =
    loop && preview?.warmSeconds !== undefined
      ? Math.ceil(
          Math.max(LOOP_WARMUP_SECONDS, preview.warmSeconds) * sampleRate,
        )
      : whole;
  const warm = Math.min(whole, tail);
  const length = warm + frames + lookahead + TRUE_PEAK_PAD;
  const left = new Float64Array(length);
  const right = new Float64Array(length);
  // The warm-up ends where the kept pass starts: whole passes, or the
  // loop's tail.
  const lead = (frames - (warm % frames)) % frames;
  for (let index = 0; index < length; index += 1) {
    const source = loop ? (index + lead) % frames : index;
    if (source < frames) {
      left[index] = inputPcm ? inputPcm[source * 2]! / 32767 : mixL[source]!;
      right[index] = inputPcm
        ? inputPcm[source * 2 + 1]! / 32767
        : mixR[source]!;
    }
  }
  if (song.trim)
    applyTrim(left, right, song.trim, sampleRate, warm, frames, loop);
  if (song.eq) applyEq(left, right, song.eq, sampleRate);
  if (song.tone) applyTone(left, right, song.tone, sampleRate);
  if (song.mseq) applyMsEq(left, right, song.mseq, sampleRate);
  if (song.glue) applyGlue(left, right, song.glue, sampleRate);
  if (song.multiband) applyMultiband(left, right, song.multiband, sampleRate);
  if (song.tape) applyTape(left, right, song.tape, sampleRate);
  if (song.width) applyWidth(left, right, song.width, sampleRate);
  const kept = (buffer: Float64Array) => buffer.subarray(warm, warm + frames);
  if (song.clip && song.clip.target === true && song.target !== undefined)
    return clipDrivenMaster(left, right, song, sampleRate, loop, kept, preview);
  if (song.clip) applyClip(left, right, song.clip);
  // The limiter's make-up lifts any DC with the music, so it goes first.
  if (song.limiter) blockDc(left, right, sampleRate);
  let gainDb = 0;
  let runs = 0;
  let outL: Float64Array;
  let outR: Float64Array;
  // What the report would measure again when the buffers it reads are the
  // ones already measured: the loudness of the limiter's last run, and the
  // true peak the ceiling trim found without having to scale. Over a whole
  // song each is a pass worth a tenth of a second or more.
  let measured: { gain: number; loudness: number } | undefined;
  let peakKept: number | undefined;
  if (song.limiter) {
    const limiter = new Limiter(left, right, song.limiter, sampleRate);
    const drive = Number(song.limiter.gain);
    let lastRun: number | undefined;
    const run = (gain: number) => {
      if (gain === lastRun) return;
      limiter.run(gain);
      lastRun = gain;
      runs += 1;
    };
    if (song.target === undefined) {
      gainDb = drive;
    } else {
      // The linear guess is a pure function of the mix, so the same mix
      // always solves to the same drive (and the same bytes).
      const before = integratedLoudness(
        kept(left),
        kept(right),
        sampleRate,
        loop,
      );
      gainDb = Number.isFinite(before)
        ? seekTarget(song.target, song.target - before, (gain) => {
            run(gain);
            const loudness = integratedLoudness(
              kept(limiter.left),
              kept(limiter.right),
              sampleRate,
              loop,
            );
            measured = { gain, loudness };
            return loudness;
          })
        : 0;
    }
    // The limiter's buffers hold its last run: the seek's last measure
    // stands only if that run was at the gain it settled on.
    if (measured?.gain !== lastRun || lastRun !== gainDb) measured = undefined;
    run(gainDb);
    // `limiter.dcblock`: a limiter that releases inside a bass cycle (20 ms
    // against a 25 ms period) holds the half of an asymmetric wave with the
    // higher peaks down further than the other half, which moves the wave's
    // mean: loud loops measured -36 to -41 dBFS of offset out of a limiter
    // that was fed under -86. The ceiling trim runs after this.
    if (song.limiter.dcblock === true) {
      blockDc(limiter.left, limiter.right, sampleRate);
      measured = undefined;
    }
    outL = kept(limiter.left);
    outR = kept(limiter.right);
    const trimmed = trimToCeiling(
      outL,
      outR,
      Number(song.limiter.ceiling),
      loop,
      song.limiter.truepeak !== false,
    );
    if (trimmed.scaled) measured = undefined;
    else peakKept = trimmed.truePeak;
  } else {
    outL = kept(left);
    outR = kept(right);
    if (song.target !== undefined) {
      const before = integratedLoudness(outL, outR, sampleRate, loop);
      if (Number.isFinite(before)) {
        const peak = gainToDb(truePeakGain(outL, outR, loop));
        gainDb = clampGain(
          Math.min(song.target - before, MASTER_LIMITS.safeCeiling - peak),
        );
        scale(outL, outR, 10 ** (gainDb / 20));
      }
    }
  }
  const integrated =
    measured?.loudness ?? integratedLoudness(outL, outR, sampleRate, loop);
  const report: MasterReport = {
    gainDb,
    integrated,
    truePeak: gainToDb(peakKept ?? truePeakGain(outL, outR, loop)),
    ...(song.target === undefined
      ? {}
      : {
          target: song.target,
          reached: Math.abs(integrated - song.target) <= 0.5,
        }),
    ...(song.limiter && song.target !== undefined ? { runs } : {}),
  };
  return Object.freeze({ left: outL, right: outR, report });
}

/**
 * The loud-master gain structure (`clip target on`): the loudness target's
 * gain goes in before the soft clipper, so the clipper shaves the transient
 * peaks and the limiter after it (at its own fixed `gain`) only takes the
 * last dB or two and the inter-sample overs. Every run re-clips from the
 * same pre-clip buffers, so the search stays a pure function of the mix.
 */
function clipDrivenMaster(
  left: Float64Array,
  right: Float64Array,
  song: SongMaster,
  sampleRate: number,
  loop: boolean,
  kept: (buffer: Float64Array) => Float64Array,
  preview?: MasterPreview,
): MasterOutput {
  const clipL = new Float64Array(left.length);
  const clipR = new Float64Array(right.length);
  const target = song.target!;
  let outL: Float64Array = kept(clipL);
  let outR: Float64Array = kept(clipR);
  let runs = 0;
  let lastRun: number | undefined;
  let limited: Limiter | undefined;
  const run = (gain: number) => {
    if (gain === lastRun) return;
    lastRun = gain;
    runs += 1;
    const scaleBy = 10 ** (gain / 20);
    for (let index = 0; index < left.length; index += 1) {
      clipL[index] = left[index]! * scaleBy;
      clipR[index] = right[index]! * scaleBy;
    }
    applyClip(clipL, clipR, song.clip!);
    if (song.limiter) {
      // As on the plain path: the clipper shifts an asymmetric wave's mean,
      // so the DC goes before the limiter.
      blockDc(clipL, clipR, sampleRate);
      const limiter = new Limiter(clipL, clipR, song.limiter, sampleRate);
      limiter.run(Number(song.limiter.gain));
      limited = limiter;
      outL = kept(limiter.left);
      outR = kept(limiter.right);
    } else {
      outL = kept(clipL);
      outR = kept(clipR);
    }
  };
  const measure = () => integratedLoudness(outL, outR, sampleRate, loop);
  const before = integratedLoudness(kept(left), kept(right), sampleRate, loop);
  const limiterGain = song.limiter ? Number(song.limiter.gain) : 0;
  let gainDb = 0;
  if (Number.isFinite(before)) {
    gainDb = seekTarget(target, target - before - limiterGain, (gain) => {
      run(gain);
      return measure();
    });
  }
  run(gainDb);
  // As on the plain path: the limiter's gain leaves an offset of its own.
  if (limited && song.limiter?.dcblock === true)
    blockDc(limited.left, limited.right, sampleRate);
  // The ceiling check reads the audio after that, so the peak it finds
  // (and the one a preview reports) is the peak of what is returned.
  let peakKept: number | undefined;
  if (song.limiter) {
    const trimmed = trimToCeiling(
      outL,
      outR,
      Number(song.limiter.ceiling),
      loop,
      song.limiter.truepeak !== false,
    );
    // A static trim scales every interpolated peak by the same factor.
    // Only a live preview uses that result after scaling: a file keeps
    // its existing final measurement, including its last rounding bits.
    if (preview) peakKept = trimmed.truePeak;
  }
  const integrated = measure();
  return Object.freeze({
    left: outL,
    right: outR,
    report: {
      gainDb,
      integrated,
      truePeak: gainToDb(peakKept ?? truePeakGain(outL, outR, loop)),
      target,
      reached: Math.abs(integrated - target) <= 0.5,
      runs,
    },
  });
}

/** Decode directly into master-owned buffers instead of holding a second float pair. */
export function applyMasterPcm(
  pcm: Int16Array,
  frames: number,
  sampleRate: number,
  master: SongMaster | undefined,
  loop: boolean,
  preview?: MasterPreview,
): MasterOutput | undefined {
  return applyMaster(
    EMPTY_INPUT,
    EMPTY_INPUT,
    frames,
    sampleRate,
    master,
    loop,
    pcm,
    preview,
  );
}
const EMPTY_INPUT = new Float64Array(0);

/**
 * Bounded audition: fixed manual limiter drive, no target normalization,
 * `trim` unit or loudness scan. Enabled post-limiter DC removal retains a
 * ceiling guard. Filter state warms in the render window's pre-roll; this
 * deliberately does not claim exact whole-song mastering.
 */
export function applyMonitorMaster(
  pcm: Int16Array,
  sampleRate: number,
  song: SongMaster | undefined,
): Int16Array {
  if (!song || !masterActive(song)) return pcm;
  const frames = pcm.length / 2;
  const left = new Float64Array(frames),
    right = new Float64Array(frames);
  for (let i = 0; i < frames; i++) {
    left[i] = pcm[i * 2]! / 32767;
    right[i] = pcm[i * 2 + 1]! / 32767;
  }
  // No loudness trim here: a window's loudness is not the song's, and a
  // per-window gain would level the sections the way the target must not.
  // A master that sets `trim monitor` gets that fixed gain instead, so its
  // dynamics see about the level they see on export.
  const monitorGain = Number(song.trim?.monitor ?? 0);
  if (monitorGain) scale(left, right, 10 ** (monitorGain / 20));
  if (song.eq) applyEq(left, right, song.eq, sampleRate);
  if (song.tone) applyTone(left, right, song.tone, sampleRate);
  if (song.mseq) applyMsEq(left, right, song.mseq, sampleRate);
  if (song.glue) applyGlue(left, right, song.glue, sampleRate);
  if (song.multiband) applyMultiband(left, right, song.multiband, sampleRate);
  if (song.tape) applyTape(left, right, song.tape, sampleRate);
  if (song.width) applyWidth(left, right, song.width, sampleRate);
  if (song.clip) applyClip(left, right, song.clip);
  if (song.limiter) blockDc(left, right, sampleRate);
  let outputL: Float64Array = left,
    outputR: Float64Array = right;
  if (song.limiter) {
    const limiter = new Limiter(left, right, song.limiter, sampleRate);
    limiter.run(Number(song.limiter.gain));
    if (song.limiter.dcblock === true) {
      blockDc(limiter.left, limiter.right, sampleRate);
      // The filter can raise peaks after limiting. This protects the ceiling
      // without solving the window to a whole-song loudness target.
      trimToCeiling(
        limiter.left,
        limiter.right,
        Number(song.limiter.ceiling),
        false,
        song.limiter.truepeak !== false,
      );
    }
    outputL = limiter.left;
    outputR = limiter.right;
  }
  const out = new Int16Array(pcm.length);
  for (let i = 0; i < frames; i++) {
    out[i * 2] = Math.round(Math.max(-1, Math.min(1, outputL[i]!)) * 32767);
    out[i * 2 + 1] = Math.round(Math.max(-1, Math.min(1, outputR[i]!)) * 32767);
  }
  return out;
}

function clampGain(gainDb: number): number {
  return Math.max(
    -MASTER_LIMITS.maxTargetGain,
    Math.min(MASTER_LIMITS.maxTargetGain, gainDb),
  );
}

/**
 * Finds the limiter drive that meets a loudness target. Loudness rises
 * monotonically (and ever more slowly) with drive, so the search first
 * brackets the target from the linear guess, stepping outward, then closes
 * the bracket with Illinois regula falsi. It stops early on the plateau
 * where the limiter is past its ceiling and more drive buys almost no
 * loudness. Every step depends only on the inputs, so the same mix always
 * solves to the same drive; the closest run wins (ties go to less drive).
 */
export function seekTarget(
  target: number,
  guess: number,
  measure: (gainDb: number) => number,
): number {
  type Point = { gain: number; loudness: number };
  const seen: Point[] = [];
  const probe = (gain: number): Point => {
    const point = { gain, loudness: measure(gain) };
    seen.push(point);
    return point;
  };
  const off = (point: Point) => Math.abs(point.loudness - target);
  const best = () =>
    seen.reduce((a, b) =>
      off(b) < off(a) || (off(b) === off(a) && b.gain < a.gain) ? b : a,
    );
  let point = probe(clampGain(guess));
  if (!Number.isFinite(point.loudness)) return 0;
  let low = point.loudness < target ? point : undefined;
  let high = point.loudness < target ? undefined : point;
  // Bracket: step away from the target side, estimating the slope from the
  // last two runs (1 dB per dB at first) and overshooting a little, since
  // the curve only flattens further out.
  while (
    seen.length < TARGET_ITERATIONS &&
    off(point) > TARGET_TOLERANCE_LU &&
    (low === undefined || high === undefined)
  ) {
    const previous = seen.length >= 2 ? seen[seen.length - 2]! : undefined;
    const slope =
      previous === undefined
        ? 1
        : (point.loudness - previous.loudness) / (point.gain - previous.gain);
    // Below the target on the plateau, more drive cannot reach it; above
    // it, a flat stretch only means a bigger step down.
    if (
      high === undefined &&
      previous !== undefined &&
      !(slope >= PLATEAU_SLOPE)
    )
      break;
    const step = Math.min(
      MAX_TARGET_STEP,
      Math.max(0.25, (1.25 * off(point)) / Math.max(slope, PLATEAU_SLOPE)),
    );
    const next = clampGain(point.gain + (high === undefined ? step : -step));
    if (next === point.gain) break;
    point = probe(next);
    if (point.loudness < target) low = point;
    else high = point;
  }
  if (
    low !== undefined &&
    high !== undefined &&
    off(point) > TARGET_TOLERANCE_LU
  ) {
    let fLow = low.loudness - target;
    let fHigh = high.loudness - target;
    let side = 0;
    while (seen.length < TARGET_ITERATIONS && high.gain - low.gain > 0.01) {
      const gain = (low.gain * fHigh - high.gain * fLow) / (fHigh - fLow);
      point = probe(gain);
      const f = point.loudness - target;
      if (Math.abs(f) <= TARGET_TOLERANCE_LU) break;
      if (f < 0) {
        low = point;
        fLow = f;
        if (side === -1) fHigh /= 2;
        side = -1;
      } else {
        high = point;
        fHigh = f;
        if (side === 1) fLow /= 2;
        side = 1;
      }
    }
  }
  return best().gain;
}

/**
 * Gain staging: one static gain that sets the kept pass to `lufs`, so the
 * units after it see the same level whatever the track faders sum to. A
 * silent mix passes unchanged.
 */
function applyTrim(
  left: Float64Array,
  right: Float64Array,
  values: FxValues,
  sampleRate: number,
  warm: number,
  frames: number,
  loop: boolean,
): void {
  const before = integratedLoudness(
    left.subarray(warm, warm + frames),
    right.subarray(warm, warm + frames),
    sampleRate,
    loop,
  );
  if (values.dcblock === true) dcBlock(left, right, sampleRate);
  if (!Number.isFinite(before)) return;
  scale(left, right, 10 ** (clampGain(Number(values.lufs) - before) / 20));
}

/** First-order DC blocker at 5 Hz: y = x - x[-1] + r y[-1]. */
function dcBlock(
  left: Float64Array,
  right: Float64Array,
  sampleRate: number,
): void {
  const r = Math.exp((-2 * Math.PI * 5) / sampleRate);
  for (const channel of [left, right]) {
    let x1 = 0,
      y1 = 0;
    for (let i = 0; i < channel.length; i += 1) {
      const x = channel[i]!;
      y1 = x - x1 + r * y1;
      x1 = x;
      channel[i] = y1;
    }
  }
}

/**
 * Soft clipper: `drive` dB in, linear up to the knee, then a tanh curve
 * that approaches `ceiling` and never passes it. `softness` 0 is a hard
 * clip at the ceiling; 1 puts the knee 6 dB below it. Memoryless, so it
 * is the same on every render path; the limiter after it catches the
 * inter-sample peaks the curve leaves.
 */
function applyClip(
  left: Float64Array,
  right: Float64Array,
  values: FxValues,
): void {
  const drive = 10 ** (Number(values.drive) / 20);
  const ceiling = 10 ** (Number(values.ceiling) / 20);
  const knee = ceiling * 10 ** ((-6 * Number(values.softness)) / 20);
  const room = ceiling - knee;
  const shape = (x: number) => {
    const a = Math.abs(x);
    const y =
      a <= knee
        ? a
        : room <= 0
          ? ceiling
          : knee + room * Math.tanh((a - knee) / room);
    return x < 0 ? -y : y;
  };
  if (values.oversample === true) {
    for (const channel of [left, right]) {
      for (let index = 0; index < channel.length; index += 1)
        channel[index]! *= drive;
      oversampledShape(channel, shape, knee);
    }
    return;
  }
  for (let index = 0; index < left.length; index += 1) {
    left[index] = shape(left[index]! * drive);
    right[index] = shape(right[index]! * drive);
  }
}

/** Half-length of the 4x interpolation filter in input samples. */
const OVERSAMPLE_HALF = 32;
let oversampleKernel: Float64Array | undefined;

/**
 * The 4x prototype: a Kaiser-windowed (beta 8) sinc with its cutoff at the
 * input Nyquist, so every 4th tap is zero (a Nyquist filter: the input
 * samples pass through interpolation untouched). Taps at t = -128..128 of
 * the 4x grid, normalized to unit DC gain.
 */
function oversampleFilter(): Float64Array {
  if (oversampleKernel) return oversampleKernel;
  const half = OVERSAMPLE_HALF * 4;
  const taps = new Float64Array(2 * half + 1);
  const bessel = (x: number) => {
    let sum = 1;
    let term = 1;
    for (let k = 1; k < 40; k += 1) {
      term *= (x / (2 * k)) ** 2;
      sum += term;
    }
    return sum;
  };
  const beta = 8;
  const norm = bessel(beta);
  let total = 0;
  for (let t = -half; t <= half; t += 1) {
    const x = t / 4;
    const sinc = t === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    const r = t / half;
    const window = bessel(beta * Math.sqrt(Math.max(0, 1 - r * r))) / norm;
    taps[t + half] = sinc * window;
    total += sinc * window;
  }
  for (let index = 0; index < taps.length; index += 1) taps[index]! /= total;
  oversampleKernel = taps;
  return taps;
}

/**
 * A memoryless curve at 4x without aliasing: y = x + D(f(Ux) - Ux), where
 * U is the 4x interpolator and D the matching decimating low-pass. Below
 * the curve's knee f is the identity, so the residual is exactly zero and
 * the clean signal passes bit for bit; only the distortion the curve adds
 * is band-limited, and only near the samples that reach the knee is any
 * interpolation done at all.
 */
function oversampledShape(
  channel: Float64Array,
  shape: (x: number) => number,
  knee: number,
): void {
  const taps = oversampleFilter();
  const half = OVERSAMPLE_HALF * 4;
  const n = channel.length;
  const delta = new Float64Array(n);
  const gate = knee * 0.5;
  const scatter = (m: number, e: number) => {
    // Output samples k with |4k - m| <= half.
    const first = Math.max(0, Math.ceil((m - half) / 4));
    const last = Math.min(n - 1, Math.floor((m + half) / 4));
    for (let k = first; k <= last; k += 1)
      delta[k]! += e * taps[4 * k - m + half]!;
  };
  for (let index = 0; index < n; index += 1) {
    let near = 0;
    for (let j = index - 1; j <= index + 2; j += 1)
      if (j >= 0 && j < n) near = Math.max(near, Math.abs(channel[j]!));
    if (near <= gate) continue;
    const x = channel[index]!;
    const e0 = shape(x) - x;
    if (e0 !== 0) scatter(4 * index, e0);
    for (let phase = 1; phase < 4; phase += 1) {
      // u(index + phase/4) = sum_k x[k] * 4h(4(index - k) + phase).
      let u = 0;
      const from = Math.max(0, index - OVERSAMPLE_HALF + 1);
      const to = Math.min(n - 1, index + OVERSAMPLE_HALF);
      for (let k = from; k <= to; k += 1)
        u += channel[k]! * taps[4 * (index - k) + phase + half]!;
      u *= 4;
      const e = shape(u) - u;
      if (e !== 0) scatter(4 * index + phase, e);
    }
  }
  for (let index = 0; index < n; index += 1) channel[index]! += delta[index]!;
}

/**
 * A 5 Hz DC blocker ahead of the limiter. The master's gain lifts any
 * offset the mix carries (a driven sub or a felt piano left -60..-70 dBFS
 * in our composed mixes, which came out at -47..-56 after the master),
 * and the clipper's odd curve shifts an asymmetric wave's mean.
 */
function blockDc(
  left: Float64Array,
  right: Float64Array,
  sampleRate: number,
): void {
  const pole = Math.exp((-2 * Math.PI * 5) / sampleRate);
  for (const channel of [left, right]) {
    let input = 0;
    let output = 0;
    for (let index = 0; index < channel.length; index += 1) {
      const x = channel[index]!;
      output = x - input + pole * output;
      input = x;
      channel[index] = output;
    }
  }
}

function scale(left: Float64Array, right: Float64Array, gain: number): void {
  for (let index = 0; index < left.length; index += 1) {
    left[index]! *= gain;
    right[index]! *= gain;
  }
}

/**
 * A final static trim so the measured peak (true peak, or sample peak when
 * the limiter's true-peak detection is off) never passes the ceiling.
 */
function trimToCeiling(
  left: Float64Array,
  right: Float64Array,
  ceilingDb: number,
  loop: boolean,
  truePeak: boolean,
): { scaled: boolean; truePeak?: number } {
  const ceiling = 10 ** (ceilingDb / 20);
  let peak = 0;
  if (truePeak) peak = truePeakGain(left, right, loop);
  else
    for (let index = 0; index < left.length; index += 1)
      peak = Math.max(peak, Math.abs(left[index]!), Math.abs(right[index]!));
  if (peak > ceiling) {
    scale(left, right, ceiling / peak);
    return {
      scaled: true,
      ...(truePeak && Number.isFinite(peak) ? { truePeak: ceiling } : {}),
    };
  }
  // The true peak of the buffers as they are left, when it was measured.
  return { scaled: false, ...(truePeak ? { truePeak: peak } : {}) };
}

/** A biquad section, transposed direct form II. */
class Section {
  private z1 = 0;
  private z2 = 0;

  constructor(
    private readonly b0: number,
    private readonly b1: number,
    private readonly b2: number,
    private readonly a1: number,
    private readonly a2: number,
  ) {}

  process(input: number): number {
    const output = this.b0 * input + this.z1;
    this.z1 = this.b1 * input - this.a1 * output + this.z2;
    this.z2 = this.b2 * input - this.a2 * output;
    return output;
  }

  run(buffer: Float64Array): void {
    for (let index = 0; index < buffer.length; index += 1)
      buffer[index] = this.process(buffer[index]!);
  }

  /** Magnitude response at `frequency`, dB. */
  responseDb(frequency: number, sampleRate: number): number {
    const w = (2 * Math.PI * frequency) / sampleRate;
    const c1 = Math.cos(w);
    const s1 = Math.sin(w);
    const c2 = Math.cos(2 * w);
    const s2 = Math.sin(2 * w);
    const nr = this.b0 + this.b1 * c1 + this.b2 * c2;
    const ni = -(this.b1 * s1 + this.b2 * s2);
    const dr = 1 + this.a1 * c1 + this.a2 * c2;
    const di = -(this.a1 * s1 + this.a2 * s2);
    return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
  }
}

type SectionKind = "low" | "high" | "bell" | "lowpass" | "highpass" | "allpass";

/** RBJ Audio EQ Cookbook coefficients (shelves at slope S = 1). */
export function cookbook(
  kind: SectionKind,
  frequency: number,
  sampleRate: number,
  gainDb = 0,
  q = Math.SQRT1_2,
): Section {
  const f = Math.max(10, Math.min(frequency, sampleRate * 0.45));
  const w0 = (2 * Math.PI * f) / sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const a = 10 ** (gainDb / 40);
  let b0: number;
  let b1: number;
  let b2: number;
  let a0: number;
  let a1: number;
  let a2: number;
  if (kind === "bell") {
    const alpha = sin / (2 * q);
    b0 = 1 + alpha * a;
    b1 = -2 * cos;
    b2 = 1 - alpha * a;
    a0 = 1 + alpha / a;
    a1 = -2 * cos;
    a2 = 1 - alpha / a;
  } else if (kind === "low" || kind === "high") {
    const alpha = sin / Math.SQRT2;
    const root = 2 * Math.sqrt(a) * alpha;
    const sign = kind === "low" ? 1 : -1;
    b0 = a * (a + 1 - sign * (a - 1) * cos + root);
    b1 = sign * 2 * a * (a - 1 - sign * (a + 1) * cos);
    b2 = a * (a + 1 - sign * (a - 1) * cos - root);
    a0 = a + 1 + sign * (a - 1) * cos + root;
    a1 = -sign * 2 * (a - 1 + sign * (a + 1) * cos);
    a2 = a + 1 + sign * (a - 1) * cos - root;
  } else if (kind === "allpass") {
    const alpha = sin / (2 * q);
    b0 = 1 - alpha;
    b1 = -2 * cos;
    b2 = 1 + alpha;
    a0 = 1 + alpha;
    a1 = -2 * cos;
    a2 = 1 - alpha;
  } else {
    const alpha = sin / (2 * q);
    const low = kind === "lowpass";
    b0 = low ? (1 - cos) / 2 : (1 + cos) / 2;
    b1 = low ? 1 - cos : -(1 + cos);
    b2 = b0;
    a0 = 1 + alpha;
    a1 = -2 * cos;
    a2 = 1 - alpha;
  }
  return new Section(b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0);
}

/** Low shelf, two bells and a high shelf; 0 dB bands are skipped. */
function applyEq(
  left: Float64Array,
  right: Float64Array,
  values: FxValues,
  sampleRate: number,
): void {
  const value = (key: string) => Number(values[key]);
  const bands: [SectionKind, number, number, number][] = [
    ["low", value("low"), value("lowfreq"), Math.SQRT1_2],
    ["bell", value("bell1"), value("bell1freq"), value("bell1q")],
    ["bell", value("bell2"), value("bell2freq"), value("bell2q")],
    ["high", value("high"), value("highfreq"), Math.SQRT1_2],
  ];
  for (const [kind, gain, frequency, q] of bands) {
    if (gain === 0) continue;
    for (const channel of [left, right])
      cookbook(kind, frequency, sampleRate, gain, q).run(channel);
  }
}

/** Q of the tone unit's octave bells. */
const TONE_Q = 1.4;

/**
 * The tone unit's filter for octave `index`: bells, except the end octaves,
 * which are shelves cornered at their inner edge (a 16 kHz bell narrows
 * against Nyquist and a 31 Hz bell misses the octave below it, so neither
 * would move its whole octave).
 */
type ToneFilter = {
  kind: SectionKind;
  frequency: number;
  q: number;
};

function toneFilter(index: number, sampleRate: number): ToneFilter {
  const centre = Math.min(TONE_BANDS[index]![1], sampleRate * 0.45);
  if (index === 0)
    return { kind: "low", frequency: centre * Math.SQRT2, q: Math.SQRT1_2 };
  if (index === TONE_BANDS.length - 1)
    return { kind: "high", frequency: centre / Math.SQRT2, q: Math.SQRT1_2 };
  return { kind: "bell", frequency: centre, q: TONE_Q };
}

function toneSection(index: number, sampleRate: number, gain: number): Section {
  const { kind, frequency, q } = toneFilter(index, sampleRate);
  return cookbook(kind, frequency, sampleRate, gain, q);
}

/**
 * Solves the tone unit's filter gains so the cascade's response at every
 * octave centre is exactly the asked gain: overlapping bells add up, so a
 * plain graphic EQ overshoots a smooth curve. A linear solve on the
 * per-dB interaction matrix, then two Newton-style refinements on the
 * real (slightly nonlinear) bell responses. Pure: the same values give
 * the same bells.
 */
export function solveTone(
  values: FxValues,
  sampleRate: number,
): (ToneFilter & { index: number; gain: number })[] {
  // Octaves out of reach at this rate (crowded under Nyquist) are dropped:
  // their asks would make the system singular.
  const reach = toneReach(sampleRate);
  const want = reach.map((i) => Number(values[TONE_BANDS[i]![0]] ?? 0));
  if (want.every((gain) => gain === 0)) return [];
  const freqs = reach.map((i) =>
    Math.min(TONE_BANDS[i]![1], sampleRate * 0.45),
  );
  const n = freqs.length;
  const response = (gains: number[]) =>
    freqs.map((f) =>
      gains.reduce(
        (sum, gain, j) =>
          gain === 0
            ? sum
            : sum +
              toneSection(reach[j]!, sampleRate, gain).responseDb(
                f,
                sampleRate,
              ),
        0,
      ),
    );
  const matrix = freqs.map((f) =>
    reach.map((index) =>
      toneSection(index, sampleRate, 1).responseDb(f, sampleRate),
    ),
  );
  const solve = (rhs: number[]) => {
    const a = matrix.map((row, i) => [...row, rhs[i]!]);
    for (let col = 0; col < n; col += 1) {
      let pivot = col;
      for (let row = col + 1; row < n; row += 1)
        if (Math.abs(a[row]![col]!) > Math.abs(a[pivot]![col]!)) pivot = row;
      [a[col], a[pivot]] = [a[pivot]!, a[col]!];
      for (let row = 0; row < n; row += 1) {
        if (row === col) continue;
        const factor = a[row]![col]! / a[col]![col]!;
        for (let k = col; k <= n; k += 1) a[row]![k]! -= factor * a[col]![k]!;
      }
    }
    return a.map((row, i) => row[n]! / row[i]!);
  };
  let gains = solve(want).map((gain) => Math.max(-15, Math.min(15, gain)));
  for (let pass = 0; pass < 2; pass += 1) {
    const got = response(gains);
    const step = solve(want.map((w, i) => w - got[i]!));
    gains = gains.map((gain, i) =>
      Math.max(-15, Math.min(15, gain + step[i]!)),
    );
  }
  return gains
    .map((gain, j) => {
      const index = reach[j]!;
      return { index, ...toneFilter(index, sampleRate), gain };
    })
    .filter(({ gain }) => Math.abs(gain) > 1e-6);
}

/** Tonal balance: the solved octave bells on both channels. */
function applyTone(
  left: Float64Array,
  right: Float64Array,
  values: FxValues,
  sampleRate: number,
): void {
  for (const { index, gain } of solveTone(values, sampleRate))
    for (const channel of [left, right])
      toneSection(index, sampleRate, gain).run(channel);
}

/** The tone unit's dB response at each of `hz` (what applyTone does). */
export function toneResponseDb(
  values: FxValues,
  sampleRate: number,
  hz: readonly number[] | Float64Array,
): Float64Array {
  const out = new Float64Array(hz.length);
  for (const { index, gain } of solveTone(values, sampleRate)) {
    const section = toneSection(index, sampleRate, gain);
    for (let i = 0; i < hz.length; i += 1)
      out[i]! += section.responseDb(hz[i]!, sampleRate);
  }
  return out;
}

/** RMS detector time constant per multiband band, ms (low to air). */
const MULTIBAND_RMS_MS = [12, 6, 3, 1.5];

/**
 * Four-band compressor. Linkwitz-Riley 4th-order crossovers in a tree
 * (split at the mid crossover, then each half at its own), with the
 * matching all-passes on the other branch so the four bands sum to a pure
 * all-pass: with every band below threshold the magnitude is flat.
 * Each band has a stereo-linked RMS detector, a soft-knee gain computer
 * (as glue), attack/release smoothing of the reduction, a `range` cap and
 * a static gain after.
 */
function applyMultiband(
  left: Float64Array,
  right: Float64Array,
  values: FxValues,
  sampleRate: number,
): void {
  const value = (key: string) => Number(values[key]);
  const f1 = value("lowfreq");
  const f2 = Math.max(f1 * 1.5, value("midfreq"));
  const f3 = Math.max(f2 * 1.5, value("highfreq"));
  const knee = value("knee");
  const range = value("range");
  const coefficient = (ms: number) =>
    Math.exp(-1 / Math.max(1, (ms / 1000) * sampleRate));
  const bands = MULTIBAND_BANDS.map((band, i) => ({
    threshold: value(`${band}threshold`),
    slope: 1 - 1 / value(`${band}ratio`),
    attack: coefficient(value(`${band}attack`)),
    release: coefficient(value(`${band}release`)),
    makeup: 10 ** (value(`${band}gain`) / 20),
    rms: coefficient(MULTIBAND_RMS_MS[i]!),
    power: 0,
    reduction: 0,
  }));
  const lr4 = (kind: "lowpass" | "highpass", f: number) => [
    cookbook(kind, f, sampleRate),
    cookbook(kind, f, sampleRate),
  ];
  const run = (sections: Section[], x: number) => {
    for (const section of sections) x = section.process(x);
    return x;
  };
  const filters = () => ({
    lo2: lr4("lowpass", f2),
    hi2: lr4("highpass", f2),
    ap3: [cookbook("allpass", f3, sampleRate)],
    lo1: lr4("lowpass", f1),
    hi1: lr4("highpass", f1),
    ap1: [cookbook("allpass", f1, sampleRate)],
    lo3: lr4("lowpass", f3),
    hi3: lr4("highpass", f3),
  });
  const fl = filters();
  const fr = filters();
  const split = (f: ReturnType<typeof filters>, x: number, out: number[]) => {
    const low = run(f.ap3, run(f.lo2, x));
    const high = run(f.ap1, run(f.hi2, x));
    out[0] = run(f.lo1, low);
    out[1] = run(f.hi1, low);
    out[2] = run(f.lo3, high);
    out[3] = run(f.hi3, high);
  };
  const bl = [0, 0, 0, 0];
  const br = [0, 0, 0, 0];
  for (let index = 0; index < left.length; index += 1) {
    split(fl, left[index]!, bl);
    split(fr, right[index]!, br);
    let outL = 0;
    let outR = 0;
    for (let b = 0; b < 4; b += 1) {
      const band = bands[b]!;
      const l = bl[b]!;
      const r = br[b]!;
      band.power =
        band.rms * band.power + (1 - band.rms) * ((l * l + r * r) / 2);
      // RMS reads 3 dB under a sine's peak; +3 keeps thresholds peak-like.
      const level = 10 * Math.log10(band.power + 1e-24) + 3.01;
      const over = level - band.threshold;
      let target = 0;
      if (2 * over >= knee) target = band.slope * over;
      else if (knee > 0 && 2 * over > -knee)
        target = (band.slope * (over + knee / 2) ** 2) / (2 * knee);
      if (target > range) target = range;
      band.reduction =
        target > band.reduction
          ? band.attack * band.reduction + (1 - band.attack) * target
          : band.release * band.reduction + (1 - band.release) * target;
      const gain = 10 ** (-band.reduction / 20) * band.makeup;
      outL += l * gain;
      outR += r * gain;
    }
    left[index] = outL;
    right[index] = outR;
  }
}

/**
 * Mid/side EQ: encode M = (L+R)/2 and S = (L-R)/2, run the mid and side
 * bands on each, decode. Without any side band the side passes untouched,
 * and the other way round, so a side shelf never moves the center.
 */
export function applyMsEq(
  left: Float64Array,
  right: Float64Array,
  values: FxValues,
  sampleRate: number,
): void {
  const value = (key: string) => Number(values[key] ?? 0);
  const bands = (prefix: string): [SectionKind, number, number, number][] => [
    ["low", value(`${prefix}low`), value(`${prefix}lowfreq`), Math.SQRT1_2],
    [
      "bell",
      value(`${prefix}bell`),
      value(`${prefix}bellfreq`),
      value(`${prefix}bellq`) || 1,
    ],
    ["high", value(`${prefix}high`), value(`${prefix}highfreq`), Math.SQRT1_2],
  ];
  const mid = bands("mid").filter(([, gain]) => gain !== 0);
  const side = bands("side").filter(([, gain]) => gain !== 0);
  if (mid.length === 0 && side.length === 0) return;
  const m = new Float64Array(left.length),
    s = new Float64Array(left.length);
  for (let i = 0; i < left.length; i += 1) {
    m[i] = (left[i]! + right[i]!) / 2;
    s[i] = (left[i]! - right[i]!) / 2;
  }
  for (const [kind, gain, frequency, q] of mid)
    cookbook(kind, frequency, sampleRate, gain, q).run(m);
  for (const [kind, gain, frequency, q] of side)
    cookbook(kind, frequency, sampleRate, gain, q).run(s);
  for (let i = 0; i < left.length; i += 1) {
    left[i] = m[i]! + s[i]!;
    right[i] = m[i]! - s[i]!;
  }
}

/**
 * Stereo-linked feed-forward bus compressor (Giannoulis, Massberg & Reiss,
 * JAES 2012): peak level of the louder channel (optionally high-passed so
 * the bass does not pump the mix), a soft-knee gain computer in dB and
 * attack/release smoothing of the gain reduction, then make-up and a
 * parallel dry/wet mix.
 */
function applyGlue(
  left: Float64Array,
  right: Float64Array,
  values: FxValues,
  sampleRate: number,
): void {
  const threshold = Number(values.threshold);
  const ratio = Number(values.ratio);
  const knee = Number(values.knee);
  const mix = Number(values.mix);
  const hpf = Number(values.hpf);
  const slope = 1 - 1 / ratio;
  // Auto make-up: half the static reduction a full-scale peak gets, a fixed
  // estimate of the average, so glue on/off compares near level-matched and
  // the result does not depend on the buffer (loops stay periodic).
  const auto =
    values.auto !== false ? (slope * Math.max(0, -threshold)) / 2 : 0;
  const makeup = 10 ** ((Number(values.makeup) + auto) / 20);
  const coefficient = (ms: number) =>
    Math.exp(-1 / Math.max(1, (ms / 1000) * sampleRate));
  const attack = coefficient(Number(values.attack));
  const release = coefficient(Number(values.release));
  const sideL = hpf > 0 ? cookbook("highpass", hpf, sampleRate) : undefined;
  const sideR = hpf > 0 ? cookbook("highpass", hpf, sampleRate) : undefined;
  let reduction = 0;
  for (let index = 0; index < left.length; index += 1) {
    const l = left[index]!;
    const r = right[index]!;
    const detectL = sideL ? sideL.process(l) : l;
    const detectR = sideR ? sideR.process(r) : r;
    const level =
      20 * Math.log10(Math.max(Math.abs(detectL), Math.abs(detectR)) + 1e-12);
    const over = level - threshold;
    let target = 0;
    if (2 * over >= knee) target = slope * over;
    else if (knee > 0 && 2 * over > -knee)
      target = (slope * (over + knee / 2) ** 2) / (2 * knee);
    reduction =
      target > reduction
        ? attack * reduction + (1 - attack) * target
        : release * reduction + (1 - release) * target;
    const gain = 10 ** (-reduction / 20) * makeup;
    left[index] = l * (1 - mix) + l * gain * mix;
    right[index] = r * (1 - mix) + r * gain * mix;
  }
}

/** ln(cosh(u)), the antiderivative of tanh, without overflow. */
function logCosh(u: number): number {
  const a = Math.abs(u);
  return a + Math.log1p(Math.exp(-2 * a)) - Math.LN2;
}

/**
 * Tape-style saturation: tanh(drive·x + bias), centred and scaled so full
 * scale stays full scale (quiet parts come up, peaks stay put). First-order
 * antiderivative anti-aliasing (Parker et al., DAFx 2016; Bilbao et al.,
 * IEEE SPL 2017) keeps the harmonics from folding back, a 5 Hz DC blocker
 * removes the offset the bias leaves, and `tone` rolls off the top
 * (20 kHz is off: the stage is flat to 0.4 fs).
 */
/** Pole of the filter that flattens the tape stage's ADAA top end. */
const TAPE_COMPENSATION = 0.85;

function applyTape(
  left: Float64Array,
  right: Float64Array,
  values: FxValues,
  sampleRate: number,
): void {
  const drive = 10 ** (Number(values.drive) / 20);
  const bias = Number(values.bias);
  const tone = Number(values.tone);
  const mix = Number(values.mix);
  const centre = Math.tanh(bias);
  const norm = Math.max(
    Math.tanh(drive + bias) - centre,
    centre - Math.tanh(bias - drive),
  );
  const dcPole = Math.exp((-2 * Math.PI * 5) / sampleRate);
  const toneOn = tone < Math.min(20_000, sampleRate * 0.45);
  for (const channel of [left, right]) {
    let previousU = bias;
    let previousF = logCosh(bias);
    let previousX = 0;
    let compensated = 0;
    let dcIn = 0;
    let dcOut = 0;
    const lowpass = toneOn ? cookbook("lowpass", tone, sampleRate) : undefined;
    for (let index = 0; index < channel.length; index += 1) {
      const x = channel[index]!;
      const u = drive * x + bias;
      const f = logCosh(u);
      const delta = u - previousU;
      const shaped =
        Math.abs(delta) > 1e-9
          ? (f - previousF) / delta
          : Math.tanh((u + previousU) / 2);
      previousU = u;
      previousF = f;
      let wet = (shaped - centre) / norm;
      // DC blocker: y[n] = x[n] - x[n-1] + R·y[n-1].
      const blocked = wet - dcIn + dcPole * dcOut;
      dcIn = wet;
      dcOut = blocked;
      wet = lowpass ? lowpass.process(blocked) : blocked;
      // The dry path gets the same half-sample delay the ADAA stage has.
      const dry = (x + previousX) / 2;
      previousX = x;
      // Both paths carry the two-tap average ADAA amounts to in its linear
      // region (|cos(pi f/fs)|: -6 dB at fs/3); a one-pole compensator
      // (1 + r)/(1 + r z^-1) undoes it to within 0.3 dB up to 0.4 fs.
      const mixed = dry * (1 - mix) + wet * mix;
      compensated =
        (1 + TAPE_COMPENSATION) * mixed - TAPE_COMPENSATION * compensated;
      channel[index] = compensated;
    }
  }
}

/**
 * Mid/side width with mono bass: the side signal is scaled by `width` and
 * high-passed at `mono` with a 4th-order Linkwitz-Riley filter; the mid
 * runs through the matching all-pass so both keep the same phase.
 */
function applyWidth(
  left: Float64Array,
  right: Float64Array,
  values: FxValues,
  sampleRate: number,
): void {
  const width = Number(values.width);
  const mono = Number(values.mono);
  if (width === 1 && mono === 0) return;
  const crossover = mono > 0;
  const lr4 = (kind: "lowpass" | "highpass") => [
    cookbook(kind, mono, sampleRate),
    cookbook(kind, mono, sampleRate),
  ];
  const midLow = crossover ? lr4("lowpass") : [];
  const midHigh = crossover ? lr4("highpass") : [];
  const sideHigh = crossover ? lr4("highpass") : [];
  for (let index = 0; index < left.length; index += 1) {
    let mid = (left[index]! + right[index]!) / 2;
    let side = ((left[index]! - right[index]!) / 2) * width;
    if (crossover) {
      mid =
        midLow[1]!.process(midLow[0]!.process(mid)) +
        midHigh[1]!.process(midHigh[0]!.process(mid));
      side = sideHigh[1]!.process(sideHigh[0]!.process(side));
    }
    left[index] = mid + side;
    right[index] = mid - side;
  }
}

/**
 * Brickwall limiter. Offline, so the lookahead reads the future directly:
 * the gain each sample needs (ceiling over its peak, with true peaks from
 * the 4x interpolator on both sides of the sample) is held as a minimum
 * over the next `lookahead` samples, released exponentially and smoothed
 * by a moving average of the same length. Every sample under the average
 * window carries its own requirement, so the result never overshoots and
 * the gain ramps down smoothly before each peak. Peaks are found once;
 * `run` can then try different drives cheaply (the loudness target).
 */
class Limiter {
  readonly left: Float64Array;
  readonly right: Float64Array;
  private readonly peaks: Float64Array;
  private readonly window: number;
  private readonly release: number;
  private readonly ceiling: number;

  constructor(
    private readonly inputL: Float64Array,
    private readonly inputR: Float64Array,
    values: FxValues,
    sampleRate: number,
  ) {
    const n = inputL.length;
    this.left = new Float64Array(n);
    this.right = new Float64Array(n);
    this.ceiling = 10 ** (Number(values.ceiling) / 20);
    this.window = Math.max(
      1,
      Math.round((Number(values.lookahead) * sampleRate) / 1000),
    );
    this.release = Math.exp(
      -1 / Math.max(1, (Number(values.release) / 1000) * sampleRate),
    );
    this.peaks = new Float64Array(n);
    if (values.truepeak !== false) {
      interSamplePeaks(inputL, false, this.peaks);
      interSamplePeaks(inputR, false, this.peaks);
      // A sample's gain shapes the waveform on both sides of it.
      for (let index = n - 1; index > 0; index -= 1)
        if (this.peaks[index - 1]! > this.peaks[index]!)
          this.peaks[index] = this.peaks[index - 1]!;
    } else {
      for (let index = 0; index < n; index += 1)
        this.peaks[index] = Math.max(
          Math.abs(inputL[index]!),
          Math.abs(inputR[index]!),
        );
    }
  }

  /** Limits the input driven by `gainDb` into `left` and `right`. */
  run(gainDb: number): void {
    const drive = 10 ** (gainDb / 20);
    const n = this.inputL.length;
    const { peaks, window, ceiling } = this;
    // Sliding minimum of the needed gain over [i, i + window - 1]: a
    // monotonic deque in a ring buffer, `window` samples ahead of the output.
    const capacity = window + 1;
    const slots = new Int32Array(capacity);
    const values = new Float64Array(capacity);
    let head = 0;
    let size = 0;
    const history = new Float64Array(window);
    let released = 1;
    let sum = 0;
    for (let ahead = 0; ahead < n + window - 1; ahead += 1) {
      const index = ahead - window + 1;
      while (size > 0 && slots[head]! < index) {
        head = (head + 1) % capacity;
        size -= 1;
      }
      const peak = ahead < n ? peaks[ahead]! * drive : 0;
      const need = peak > ceiling ? ceiling / peak : 1;
      while (size > 0 && values[(head + size - 1) % capacity]! >= need)
        size -= 1;
      const slot = (head + size) % capacity;
      slots[slot] = ahead;
      values[slot] = need;
      size += 1;
      if (index < 0) continue;
      const target = values[head]!;
      if (index === 0) {
        released = target;
        history.fill(target);
        sum = window * target;
      }
      released =
        target < released
          ? target
          : target - this.release * (target - released);
      const at = index % window;
      sum += released - history[at]!;
      history[at] = released;
      const gain = Math.min(1, sum / window) * drive;
      this.left[index] = this.inputL[index]! * gain;
      this.right[index] = this.inputR[index]! * gain;
    }
  }
}
