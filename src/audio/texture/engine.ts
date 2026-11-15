/**
 * The texture engine: renders a track whose instrument is `"texture"` and
 * that carries a `texture` field. Each note is one event (a bed, a whoosh,
 * a riser): pitch is ignored, velocity sets the level and the note's length
 * the bed's length, faded in over `attack` and out over `release`.
 *
 * Per voice: the type's source (`sources.ts`) writes two decorrelated raw
 * channels, then the envelope and motion, the distance stage (a low-pass
 * that darkens with distance, plus an 8x8 Hadamard FDN whose send grows
 * with it; room, city and crowd always sit in theirs), width as mid/side
 * (capped so left and right stay positively correlated), and the level.
 * The track sum goes through a DC blocker and a soft safety knee.
 *
 * Determinism: every draw comes from the voice's own generator, seeded by
 * the texture seed, the note id and its onset tick, and voices are planned
 * in onset order with the oldest stolen, so renders are byte-identical and
 * prefix-stable. A note that starts before the render window (an arranged
 * window's pre-roll) is run from its real start and the samples before the
 * window are discarded, so a window hears the bed as the full song does.
 */
import type { PerformedNote } from "../../../core/expression.ts";
import type { AutomationPoint, Track } from "../../../core/score.ts";
import {
  MAX_TEXTURE_VOICES,
  TEXTURE_ENGINE_VERSION,
  TEXTURE_LANE_PARAMS,
  textureSettings,
  textureTailSeconds,
  type TextureMotion,
  type TextureSettings,
  type TextureType,
} from "../../../core/texture.ts";
import { interpolateAutomation } from "../effects/common.ts";
import type { EngineContext, InstrumentEngine } from "../instruments.ts";
import { Fdn, Hp1, Rng, Svf } from "./dsp.ts";
import { makeSource, type Controls, type Source } from "./sources.ts";

/** Control rate: lanes, motion and source coefficients move every block. */
export const TEXTURE_BLOCK = 128;
/** Fade on a stolen voice, seconds. */
const STEAL_FADE = 0.08;

/**
 * Per-type output trim so each type's defaults land near -20 LUFS
 * (integrated, at velocity 0.8) before the preset levels. Measured with
 * `bun scripts/preset-levels.ts`; re-measure after changing a source.
 */
export const TEXTURE_TRIM: Readonly<Record<TextureType, number>> =
  Object.freeze({
    room: 0.471,
    rain: 0.882,
    wind: 1.079,
    vinyl: 3.146,
    tape: 0.658,
    hum: 0.31,
    city: 1.145,
    crowd: 1.564,
    data: 0.33,
    air: 0.374,
  });

/** Types that always sit in their FDN (the space is the sound). */
const ROOMY: ReadonlySet<TextureType> = new Set(["room", "city", "crowd"]);

/** Base FDN delays (seconds) per space; scaled by distance. */
const ROOM_DELAYS = [
  0.0071, 0.0089, 0.0107, 0.0127, 0.0149, 0.0167, 0.0193, 0.0223,
];
const STREET_DELAYS = [
  0.0197, 0.0241, 0.0293, 0.0337, 0.0389, 0.0431, 0.0503, 0.0571,
];

function fdnShape(type: TextureType, distance: number) {
  const street = type === "city";
  const delays = (street ? STREET_DELAYS : ROOM_DELAYS).map(
    (d) => d * (0.7 + 0.8 * distance),
  );
  const t60 =
    type === "room"
      ? 0.3 + 1.5 * distance
      : type === "city"
        ? 0.5 + 1.9 * distance
        : type === "crowd"
          ? 0.4 + 1.6 * distance
          : 0.3 + 2 * distance;
  const damping = 9000 * 2 ** (-2.2 * distance);
  return { delays, t60, damping };
}

/** The FDN send for a distance. */
function wetOf(type: TextureType, distance: number): number {
  return ROOMY.has(type) ? 0.35 + 0.6 * distance : 0.9 * distance * distance;
}

/** Motion over the note: the 0..1 shape at position `p`. */
function motionShape(motion: TextureMotion, p: number): number {
  switch (motion) {
    case "steady":
      return 0.5;
    case "rise":
      return p * p;
    case "fall":
      return (1 - p) * (1 - p);
    case "swell": {
      const s = Math.sin(Math.PI * p);
      return s * s;
    }
  }
}

type Lanes = ReadonlyMap<string, readonly AutomationPoint[]>;

function lanesOf(track: Track): Lanes {
  const all = track.fxAutomation as
    Readonly<Record<string, readonly AutomationPoint[]>> | undefined;
  const lanes = new Map<string, readonly AutomationPoint[]>();
  for (const { param } of TEXTURE_LANE_PARAMS) {
    const points = all?.[`texture-${param}`];
    if (points && points.length > 0) lanes.set(param, points);
  }
  return lanes;
}

type Planned = {
  note: PerformedNote;
  /** First sample (may be negative: the note began before the window). */
  start: number;
  length: number;
  /** Last sample the voice may write (exclusive). */
  end: number;
  steal: number;
};

function span(
  note: PerformedNote,
  context: EngineContext,
): { start: number; length: number } {
  if (context.warp) {
    const from = context.warp.sample(note.startTick);
    const to = context.warp.sample(note.startTick + note.durationTicks);
    return {
      start: Math.floor(from),
      length: Math.max(1, Math.floor(to - from)),
    };
  }
  const perTick =
    (60 * context.sampleRate) / (context.tempoBpm * context.ticksPerBeat);
  return {
    start: Math.floor(note.startTick * perTick),
    length: Math.max(1, Math.floor(note.durationTicks * perTick)),
  };
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** One sounding texture event. */
class Voice {
  private readonly source: Source;
  private readonly fdn: Fdn | undefined;
  private readonly toneA = new Svf();
  private readonly toneB = new Svf();
  private readonly a = new Float64Array(TEXTURE_BLOCK);
  private readonly b = new Float64Array(TEXTURE_BLOCK);
  private readonly wet = new Float64Array(2);
  private readonly controls: Controls = {
    density: 0.5,
    wear: 0.3,
    distance: 0.3,
    sweep: 1,
    shape: 0.5,
  };
  private readonly attack: number;
  private readonly release: number;
  private readonly level: number;
  /** The previous block's level: each block ramps from it, so lanes and steals never step. */
  private last = -1;

  constructor(
    private readonly settings: TextureSettings,
    private readonly plan: Planned,
    velocity: number,
    private readonly sr: number,
    seed: string,
    withFdn: boolean,
  ) {
    const rng = new Rng(seed, sr);
    this.source = makeSource(settings.type, rng, sr, settings.mains);
    const shape = fdnShape(settings.type, settings.distance);
    // The FDN draws from its own stream so the source's draws never shift.
    this.fdn = withFdn
      ? new Fdn(
          sr,
          shape.delays,
          shape.t60,
          shape.damping,
          new Rng(`${seed}:fdn`),
        )
      : undefined;
    this.attack = Math.max(1, Math.round(settings.attack * sr));
    this.release = Math.max(1, Math.round(settings.release * sr));
    this.level = velocity * TEXTURE_TRIM[settings.type];
  }

  /** Samples after `start` at which the envelope reaches zero. */
  get silentAt(): number {
    return this.plan.length + this.release;
  }

  /**
   * Adds `n` samples starting at voice-relative sample `at` into `left` and
   * `right` at `offset`; samples outside the buffers are computed (so the
   * blocks, and every later sample, never depend on the render length)
   * but not written.
   */
  render(
    left: Float64Array,
    right: Float64Array,
    offset: number,
    at: number,
    n: number,
    values: Readonly<Record<string, number>>,
    gain: number,
  ): void {
    const s = this.settings;
    const c = this.controls;
    const p = clamp01(at / this.plan.length);
    const shape = motionShape(s.motion, p);
    const moving = s.motion !== "steady";
    c.density = clamp01(values.density ?? s.density);
    c.wear = clamp01(values.wear ?? s.wear);
    c.distance = clamp01(values.distance ?? s.distance);
    c.shape = shape;
    c.sweep = moving ? 2 ** (3 * (shape - 0.6)) : 1;
    const motionLevel = moving ? 0.15 + 0.85 * shape : 1;
    const width = 0.85 * clamp01(values.width ?? s.width);
    const widthNorm = Math.sqrt(2 / (1 + width * width));
    const level =
      this.level * gain * motionLevel * Math.max(0, values.gain ?? s.gain);
    const from = this.last < 0 ? level : this.last;
    this.last = level;
    const ramp = (level - from) / n;
    const wetSend = wetOf(s.type, c.distance);
    const dryLevel = 1 - 0.55 * wetSend;
    const tone = Math.min(
      this.sr * 0.45,
      16000 * 2 ** (-3.2 * c.distance) * Math.min(1.5, c.sweep),
    );
    this.toneA.set(tone, 0.6, this.sr);
    this.toneB.set(tone, 0.6, this.sr);
    // The generator stops once the envelope has closed; the FDN rings on.
    const sounding = at < this.silentAt;
    if (sounding) this.source.render(this.a, this.b, n, c);
    const fdn = this.fdn;
    const out = this.wet;
    const length = this.plan.length;
    for (let j = 0; j < n; j += 1) {
      const t = at + j;
      let env = 0;
      if (sounding) {
        env =
          t < this.attack
            ? 0.5 - 0.5 * Math.cos((Math.PI * t) / this.attack)
            : 1;
        if (t >= length) {
          const r = (t - length) / this.release;
          env *= r >= 1 ? 0 : 0.5 + 0.5 * Math.cos(Math.PI * r);
        }
      }
      this.toneA.process(env > 0 ? this.a[j]! * env : 0);
      this.toneB.process(env > 0 ? this.b[j]! * env : 0);
      const x = this.toneA.low;
      const y = this.toneB.low;
      let l = x * dryLevel;
      let r = y * dryLevel;
      if (fdn) {
        fdn.process((x + y) * 0.5 * wetSend, out);
        l += out[0]! * 0.5;
        r += out[1]! * 0.5;
      }
      const mid = 0.5 * (l + r);
      const side = 0.5 * (l - r) * width;
      const index = offset + j;
      if (index < 0 || index >= left.length) continue;
      const g = (from + ramp * (j + 1)) * widthNorm;
      left[index]! += (mid + side) * g;
      right[index]! += (mid - side) * g;
    }
  }
}

/** Track-level safety knee: linear to 0.6, then a tanh shoulder under 0.9. */
function knee(x: number): number {
  const a = Math.abs(x);
  if (a <= 0.6) return x;
  return Math.sign(x) * (0.6 + 0.3 * Math.tanh((a - 0.6) / 0.3));
}

/** Renders a texture track's performed notes into `left` and `right`. */
export function renderTextureTrack(
  left: Float64Array,
  right: Float64Array,
  notes: readonly PerformedNote[],
  track: Track,
  context: EngineContext,
): void {
  const { sampleRate: sr, samples } = context;
  const tickAt = (index: number): number =>
    context.warp ? context.warp.tick(index) : index / context.samplesPerTick;
  const base = textureSettings(track.texture);
  const lanes = lanesOf(track);
  const volumeLane = track.volumeAutomation ?? [];
  const volume = Math.max(0, Math.min(1, track.volume ?? 1));
  const seedTick = context.seedTick ?? 0;
  const distanceLane = lanes.has("distance");
  const withFdn = distanceLane || wetOf(base.type, base.distance) > 0.005;
  // After the release: the FDN's ring, or a few ms of the tone filter.
  const ring = Math.round(
    (withFdn
      ? textureTailSeconds(track.texture, distanceLane) - base.release
      : 0.05) * sr,
  );
  const planned: Planned[] = notes
    .map((note) => {
      const { start, length } = span(note, context);
      const release = Math.max(1, Math.round(base.release * sr));
      return {
        note,
        start,
        length,
        end: start + length + release + ring,
        steal: Infinity,
      };
    })
    .filter((entry) => entry.start < samples && entry.end > 0)
    .sort(
      (a, b) =>
        a.start - b.start ||
        a.note.pitch - b.note.pitch ||
        (a.note.id < b.note.id ? -1 : a.note.id > b.note.id ? 1 : 0),
    );
  const fade = Math.max(1, Math.round(STEAL_FADE * sr));
  const sounding: number[] = [];
  for (let i = 0; i < planned.length; i += 1) {
    const { start } = planned[i]!;
    for (let k = sounding.length - 1; k >= 0; k -= 1)
      if (planned[sounding[k]!]!.end <= start) sounding.splice(k, 1);
    while (sounding.length >= MAX_TEXTURE_VOICES) {
      const oldest = planned[sounding.shift()!]!;
      oldest.steal = start;
      oldest.end = Math.min(oldest.end, start + fade);
    }
    sounding.push(i);
  }
  const values: Record<string, number> = {};
  for (const plan of planned) {
    const settings = base;
    const voice = new Voice(
      settings,
      plan,
      plan.note.velocity,
      sr,
      `${settings.seed}:${plan.note.id}:${plan.note.startTick + seedTick}:texture`,
      withFdn,
    );
    const stop = Math.min(samples, plan.end);
    let at = plan.start;
    while (at < stop) {
      // Whole blocks only: the block grid never depends on the render length.
      const n = TEXTURE_BLOCK;
      const tick = tickAt(Math.max(0, at));
      for (const key of Object.keys(values)) delete values[key];
      for (const [param, points] of lanes)
        values[param] = interpolateAutomation(
          points,
          tick,
          settings[param as keyof TextureSettings] as number,
        );
      let gain =
        volume *
        (volumeLane.length > 0
          ? interpolateAutomation(volumeLane, tick, 1)
          : 1);
      // A steal fades along the block's ramp (its end value lands here).
      if (at + n > plan.steal) {
        const k = (at + n - plan.steal) / fade;
        gain *= k >= 1 ? 0 : 0.5 + 0.5 * Math.cos(Math.PI * k);
      }
      voice.render(left, right, at, at - plan.start, n, values, gain);
      at += n;
    }
  }
  // DC blocker and the safety knee: causal, so the output is prefix-stable.
  const dcL = new Hp1();
  const dcR = new Hp1();
  dcL.set(12, sr);
  dcR.set(12, sr);
  for (let i = 0; i < samples; i += 1) {
    left[i] = knee(dcL.process(left[i]!));
    right[i] = knee(dcR.process(right[i]!));
  }
}

/** The texture engine as registered in `src/audio/instruments.ts`. */
export const TEXTURE_ENGINE: InstrumentEngine = Object.freeze({
  id: "texture",
  field: "texture",
  render(dry, dryR, notes, track, context) {
    const right = dryR ?? new Float64Array(dry.length);
    renderTextureTrack(dry, right, notes, track, context);
    if (!dryR)
      for (let i = 0; i < dry.length; i += 1)
        dry[i] = 0.5 * (dry[i]! + right[i]!);
  },
  tailSeconds: (track: Track) =>
    textureTailSeconds(track.texture, lanesOf(track).has("distance")),
  stereo: () => true,
  assetDigests: () => [`texture:${TEXTURE_ENGINE_VERSION}`],
});
