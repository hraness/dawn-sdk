/**
 * The song master: optional mastering units applied to the whole mix after
 * the track and orbit-bus sum (DSP in src/audio/master.ts), and a loudness
 * target in LUFS (ITU-R BS.1770-4) that renders and exports normalize to.
 * One table per unit drives validation, the SDK printer, the menu, the
 * `master` prompt command and the agent tools, like core/fx.ts.
 *
 * No master, or a master with nothing on, is a bypass: renders stay
 * byte-identical to DAWN 0.4.
 */
import {
  FxValidationError,
  isRecord,
  normalizeParams,
  type FxValues,
  type NumberParam,
  type ParamSpec,
} from "./params.ts";

/** Units in processing order. */
export const MASTER_UNITS = Object.freeze([
  "trim",
  "eq",
  "tone",
  "mseq",
  "glue",
  "multiband",
  "tape",
  "width",
  "clip",
  "limiter",
] as const);
export type MasterUnit = (typeof MASTER_UNITS)[number];

export type MasterUnitSpec = Readonly<{
  label: string;
  doc: string;
  /** Parameters in display order; `simple` are the menu's top level. */
  params: Readonly<Record<string, ParamSpec>>;
  simple: readonly string[];
}>;

/** The stored master. Every field is optional; absent means off. */
export type SongMaster = Readonly<{
  trim?: FxValues;
  eq?: FxValues;
  tone?: FxValues;
  mseq?: FxValues;
  glue?: FxValues;
  multiband?: FxValues;
  tape?: FxValues;
  width?: FxValues;
  clip?: FxValues;
  limiter?: FxValues;
  /** Integrated loudness target in LUFS; renders normalize to it. */
  target?: number;
}>;

export const MASTER_LIMITS = Object.freeze({
  minTarget: -40,
  maxTarget: -3,
  /** Largest gain the target may add or remove, dB. */
  maxTargetGain: 48,
  /** Ceiling for a target without the limiter, dBTP. */
  safeCeiling: -1,
});

const db = (
  min: number,
  max: number,
  fallback: number,
  doc: string,
  step = 0.5,
): NumberParam => ({
  kind: "number",
  min,
  max,
  default: fallback,
  step,
  unit: "dB",
  doc,
});

const hz = (
  min: number,
  max: number,
  fallback: number,
  doc: string,
): NumberParam => ({
  kind: "number",
  min,
  max,
  default: fallback,
  step: "log",
  unit: "Hz",
  doc,
});

const q = (doc: string): NumberParam => ({
  kind: "number",
  min: 0.1,
  max: 10,
  default: 1,
  step: 0.1,
  doc,
});

/** Octave centres of the tone unit's bands, Hz (ISO 266 nominal). */
export const TONE_BANDS = Object.freeze([
  ["b31", 31.5],
  ["b63", 63],
  ["b125", 125],
  ["b250", 250],
  ["b500", 500],
  ["b1k", 1_000],
  ["b2k", 2_000],
  ["b4k", 4_000],
  ["b8k", 8_000],
  ["b16k", 16_000],
] as const);

/**
 * The tone octaves a render at `sampleRate` can place, as indices into
 * TONE_BANDS: those whose centre sits at or under 0.45 x the rate. A
 * centre held down under Nyquist crowds the octave below it (at 16 kHz
 * the 8 and 16 kHz octaves would both land on 7.2 kHz, and no filter
 * gains meet both asks), so octaves past it are left out. All ten are
 * kept from 35.6 kHz up.
 */
export function toneReach(sampleRate: number): number[] {
  const out: number[] = [];
  TONE_BANDS.forEach(([, centre], index) => {
    if (centre <= sampleRate * 0.45) out.push(index);
  });
  return out;
}

/** The multiband compressor's bands, low to high. */
export const MULTIBAND_BANDS = Object.freeze([
  "low",
  "mid",
  "high",
  "air",
] as const);

const ms = (
  min: number,
  max: number,
  fallback: number,
  doc: string,
  step = 1,
): NumberParam => ({
  kind: "number",
  min,
  max,
  default: fallback,
  step,
  unit: "ms",
  doc,
});

const ratio = (fallback: number, doc: string): NumberParam => ({
  kind: "number",
  min: 1,
  max: 10,
  default: fallback,
  step: 0.1,
  doc,
});

/** Per band: threshold, ratio, attack, release and gain (defaults by band). */
const MULTIBAND_DEFAULTS: Record<
  (typeof MULTIBAND_BANDS)[number],
  [number, number, number, number, string]
> = {
  low: [-20, 2, 30, 160, "below the low crossover: kick and sub"],
  mid: [-20, 1.5, 20, 200, "low crossover to mid crossover: body and chords"],
  high: [
    -24,
    1.5,
    8,
    120,
    "mid crossover to high crossover: presence, voice and harshness",
  ],
  air: [-30, 2, 3, 80, "above the high crossover: hats, sibilance and air"],
};

function multibandParams(): Record<string, ParamSpec> {
  const params: Record<string, ParamSpec> = {
    lowfreq: hz(40, 400, 120, "crossover between the low and mid bands"),
    midfreq: hz(400, 4_000, 1_000, "crossover between the mid and high bands"),
    highfreq: hz(
      2_000,
      16_000,
      6_000,
      "crossover between the high and air bands",
    ),
  };
  for (const band of MULTIBAND_BANDS) {
    const [threshold, r, attack, release, doc] = MULTIBAND_DEFAULTS[band];
    params[`${band}threshold`] = db(
      -60,
      0,
      threshold,
      `${band} band (${doc}): level where compression starts`,
      1,
    );
    params[`${band}ratio`] = ratio(
      r,
      `${band} band input:output above threshold`,
    );
    params[`${band}attack`] = ms(0.5, 100, attack, `${band} band attack`, 0.5);
    params[`${band}release`] = ms(
      20,
      1_000,
      release,
      `${band} band release`,
      10,
    );
    params[`${band}gain`] = db(
      -12,
      12,
      0,
      `${band} band gain after compression`,
    );
  }
  params.knee = db(0, 12, 6, "soft-knee width of every band", 1);
  params.range = db(0, 24, 6, "most gain reduction any band may apply", 0.5);
  return params;
}

export const MASTER_SPECS: Readonly<Record<MasterUnit, MasterUnitSpec>> =
  Object.freeze({
    trim: {
      label: "trim",
      doc: "gain staging: sets the raw mix to a loudness before the other units, so glue and tape see the same level however loud the tracks are",
      simple: ["lufs"],
      params: {
        lufs: {
          kind: "number",
          min: -40,
          max: -6,
          default: -16,
          step: 0.5,
          unit: "LUFS",
          doc: "integrated loudness the mix is set to before eq, glue and tape",
        },
        monitor: {
          kind: "number",
          min: 0,
          max: 40,
          default: 0,
          step: 0.5,
          unit: "dB",
          doc: "fixed gain progressive monitoring windows use in place of the loudness trim (they cannot measure the song); 0 leaves them untrimmed",
        },
        dcblock: {
          kind: "boolean",
          default: false,
          doc: "remove DC and sub-5 Hz drift (first-order high-pass) before the units, so it does not eat headroom",
        },
      },
    },
    eq: {
      label: "EQ",
      doc: "low shelf, two bells and a high shelf; 0 dB bands are skipped",
      simple: ["low", "bell1", "bell2", "high"],
      params: {
        low: db(-12, 12, 0, "low shelf gain"),
        lowfreq: hz(20, 1000, 100, "low shelf corner"),
        bell1: db(-12, 12, 0, "first bell gain"),
        bell1freq: hz(40, 16_000, 400, "first bell center"),
        bell1q: q("first bell width: higher is narrower"),
        bell2: db(-12, 12, 0, "second bell gain"),
        bell2freq: hz(200, 18_000, 3_000, "second bell center"),
        bell2q: q("second bell width: higher is narrower"),
        high: db(-12, 12, 0, "high shelf gain"),
        highfreq: hz(1_000, 20_000, 10_000, "high shelf corner"),
      },
    },
    tone: {
      label: "tone",
      doc: "tonal balance: an octave graphic EQ (bells, with shelves for the 31 Hz and 16 kHz octaves) solved so each octave centre gets exactly its gain (balance matching toward a target curve)",
      simple: TONE_BANDS.map(([key]) => key),
      params: Object.fromEntries(
        TONE_BANDS.map(([key, centre]) => [
          key,
          db(-8, 8, 0, `gain at ${centre} Hz`, 0.1),
        ]),
      ),
    },
    mseq: {
      label: "M/S EQ",
      doc: "mid/side shelves and bells: shapes the center and the sides apart, so the top can widen without moving the lead or the bass; 0 dB bands are skipped",
      simple: ["midlow", "midhigh", "sidelow", "sidehigh"],
      params: {
        midlow: db(-12, 12, 0, "mid low shelf gain"),
        midlowfreq: hz(20, 1000, 100, "mid low shelf corner"),
        midbell: db(-12, 12, 0, "mid bell gain"),
        midbellfreq: hz(200, 18_000, 2_500, "mid bell center"),
        midbellq: q("mid bell width: higher is narrower"),
        midhigh: db(-12, 12, 0, "mid high shelf gain"),
        midhighfreq: hz(1_000, 20_000, 10_000, "mid high shelf corner"),
        sidelow: db(-12, 12, 0, "side low shelf gain"),
        sidelowfreq: hz(20, 1000, 200, "side low shelf corner"),
        sidebell: db(-12, 12, 0, "side bell gain"),
        sidebellfreq: hz(200, 18_000, 3_000, "side bell center"),
        sidebellq: q("side bell width: higher is narrower"),
        sidehigh: db(-12, 12, 0, "side high shelf gain"),
        sidehighfreq: hz(1_000, 20_000, 6_000, "side high shelf corner"),
      },
    },
    glue: {
      label: "glue",
      doc: "stereo-linked bus compressor that holds the mix together",
      simple: ["threshold", "ratio", "attack", "release", "makeup", "auto"],
      params: {
        threshold: db(-40, 0, -18, "level where compression starts", 1),
        ratio: {
          kind: "number",
          min: 1,
          max: 10,
          default: 2,
          step: 0.5,
          doc: "input:output above threshold (2 and 4 are the classic bus settings)",
        },
        attack: {
          kind: "number",
          min: 0.1,
          max: 30,
          default: 10,
          step: 0.5,
          unit: "ms",
          doc: "how fast it clamps down; slower lets transients through",
        },
        release: {
          kind: "number",
          min: 50,
          max: 1_200,
          default: 300,
          step: 50,
          unit: "ms",
          doc: "how fast it lets go; set it to breathe with the tempo",
        },
        knee: db(0, 12, 6, "soft-knee width", 1),
        makeup: db(0, 24, 0, "gain after compression (on top of auto)"),
        auto: {
          kind: "boolean",
          default: true,
          doc: "automatic make-up (half the reduction at 0 dBFS) so on/off compares near level-matched",
        },
        mix: {
          kind: "number",
          min: 0,
          max: 1,
          default: 1,
          step: 0.05,
          doc: "dry/wet: below 1 is parallel compression",
        },
        hpf: {
          kind: "number",
          min: 0,
          max: 400,
          default: 0,
          step: 10,
          unit: "Hz",
          doc: "sidechain high-pass so the bass does not pump the mix; 0 is off",
        },
      },
    },
    multiband: {
      label: "multiband",
      doc: "four-band compressor: Linkwitz-Riley crossovers that sum flat, a stereo-linked RMS detector, soft knee and range per band",
      simple: [
        "lowfreq",
        "midfreq",
        "highfreq",
        "lowthreshold",
        "midthreshold",
        "highthreshold",
        "airthreshold",
      ],
      params: multibandParams(),
    },
    tape: {
      label: "tape",
      doc: "tape-style saturation: soft clipping with bias, peaks held in place",
      simple: ["drive", "mix"],
      params: {
        drive: db(0, 24, 6, "push into the curve: denser and louder"),
        bias: {
          kind: "number",
          min: 0,
          max: 0.5,
          default: 0.1,
          step: 0.05,
          doc: "asymmetry: adds even harmonics",
        },
        tone: hz(
          2_000,
          20_000,
          20_000,
          "high-frequency roll-off after the curve; 20000 is off",
        ),
        mix: {
          kind: "number",
          min: 0,
          max: 1,
          default: 1,
          step: 0.05,
          doc: "dry/wet",
        },
      },
    },
    width: {
      label: "width",
      doc: "mid/side stereo width with mono bass below a cutoff",
      simple: ["width", "mono"],
      params: {
        width: {
          kind: "number",
          min: 0,
          max: 2,
          default: 1,
          step: 0.05,
          doc: "side level: 0 is mono, 1 unchanged, 2 twice as wide",
        },
        mono: {
          kind: "number",
          min: 0,
          max: 300,
          default: 120,
          step: 10,
          unit: "Hz",
          doc: "below this the mix is mono (keeps bass centered); 0 is off",
        },
      },
    },
    clip: {
      label: "clip",
      doc: "soft clipper before the limiter: shaves transient peaks so the limiter holds less and sections keep their shape",
      simple: ["drive", "ceiling", "softness"],
      params: {
        drive: db(0, 18, 3, "push into the clipper (louder, more clipped)"),
        ceiling: {
          kind: "number",
          min: -12,
          max: 0,
          default: -1,
          step: 0.1,
          unit: "dBFS",
          doc: "level the clipper never exceeds",
        },
        softness: {
          kind: "number",
          min: 0,
          max: 1,
          default: 0.5,
          step: 0.05,
          doc: "0 clips hard at the ceiling; 1 starts rounding 6 dB below it",
        },
        oversample: {
          kind: "boolean",
          default: false,
          doc: "run the curve at 4x so its harmonics do not fold back as aliasing",
        },
        target: {
          kind: "boolean",
          default: false,
          doc: "the loudness target drives into the clipper (the limiter keeps its own gain) instead of into the limiter",
        },
      },
    },
    limiter: {
      label: "limiter",
      doc: "true-peak brickwall limiter with lookahead",
      simple: ["ceiling", "gain", "release"],
      params: {
        ceiling: {
          kind: "number",
          min: -12,
          max: 0,
          default: -1,
          step: 0.1,
          unit: "dBTP",
          doc: "highest true peak out",
        },
        gain: db(0, 24, 0, "drive into the limiter (a target sets it itself)"),
        release: {
          kind: "number",
          min: 1,
          max: 1_000,
          default: 100,
          step: 10,
          unit: "ms",
          doc: "recovery time; short is louder, long is cleaner",
        },
        lookahead: {
          kind: "number",
          min: 0.5,
          max: 10,
          default: 5,
          step: 0.5,
          unit: "ms",
          doc: "how early gain reduction starts before a peak",
        },
        truepeak: {
          kind: "boolean",
          default: true,
          doc: "catch peaks between samples (4x oversampled detection)",
        },
        dcblock: {
          kind: "boolean",
          default: false,
          doc: "remove the offset the limiter's own gain leaves (5 Hz high-pass after it; the ceiling is trimmed after that)",
        },
      },
    },
  });

/**
 * Named loudness targets: integrated LUFS, the limiter ceiling (dBTP) and,
 * for loud targets, the limiter preset whose faster release gets there.
 */
export const LOUDNESS_TARGETS = Object.freeze({
  streaming: {
    lufs: -14,
    ceiling: -1,
    doc: "Spotify, YouTube, Tidal and Amazon play back near -14",
  },
  apple: { lufs: -16, ceiling: -1, doc: "Apple Music Sound Check level" },
  podcast: { lufs: -16, ceiling: -1, doc: "spoken word" },
  broadcast: { lufs: -23, ceiling: -1, doc: "EBU R 128 broadcast level" },
  club: {
    lufs: -8,
    // Masters louder than -14 LUFS stay under -2 dBTP: lossy encoding of
    // dense, loud material makes inter-sample overs (Spotify's guidance).
    ceiling: -2,
    limiter: "loud",
    doc: "club and DJ masters: trance, DnB, techno",
  },
  loud: {
    lufs: -6,
    ceiling: -2,
    limiter: "brick",
    doc: "loud hyperpop, gabber and hardcore masters",
  },
  classical: { lufs: -20, ceiling: -1, doc: "classical: keeps the dynamics" },
  ambient: { lufs: -18, ceiling: -1, doc: "ambient and drone" },
} satisfies Record<
  string,
  { lufs: number; ceiling: number; limiter?: string; doc: string }
>);
export type LoudnessTargetName = keyof typeof LOUDNESS_TARGETS;
export const LOUDNESS_TARGET_NAMES = Object.freeze(
  Object.keys(LOUDNESS_TARGETS) as LoudnessTargetName[],
);

export function isLoudnessTargetName(name: string): name is LoudnessTargetName {
  return Object.prototype.hasOwnProperty.call(LOUDNESS_TARGETS, name);
}

/** Starting points per unit; every value stays editable. */
export const MASTER_PRESETS: Readonly<
  Record<MasterUnit, Readonly<Record<string, FxValues>>>
> = Object.freeze({
  trim: {
    quiet: { lufs: -20 },
    staged: { lufs: -16 },
    hot: { lufs: -12 },
  },
  tone: {
    flat: {},
    tilt: {
      b31: 1,
      b63: 0.8,
      b125: 0.5,
      b250: 0.2,
      b2k: -0.2,
      b4k: -0.5,
      b8k: -0.8,
      b16k: -1,
    },
    smile: { b31: 1, b63: 1, b125: 0.5, b2k: -0.5, b4k: -0.5, b16k: 1 },
  },
  mseq: {
    open: { sidehigh: 2.5, sidehighfreq: 6_000 },
    tight: { sidelow: -3, sidelowfreq: 250 },
    presence: { midbell: 1, midbellfreq: 2_500, midbellq: 0.7 },
    "wide-top": { sidehigh: 3, sidehighfreq: 6_000 },
    "tight-low": { sidelow: -4, sidelowfreq: 200 },
  },
  multiband: {
    gentle: {},
    tame: { highthreshold: -28, highratio: 2, airthreshold: -34, airratio: 3 },
    dense: {
      lowthreshold: -24,
      midthreshold: -24,
      midratio: 2,
      highthreshold: -28,
      highratio: 2,
    },
  },
  eq: {
    air: { high: 2, highfreq: 12_000 },
    warm: { low: 1.5, lowfreq: 120, high: -1.5, highfreq: 8_000 },
    "mud-cut": { bell1: -2.5, bell1freq: 300, bell1q: 1.2 },
    smile: { low: 2, high: 2, bell1: -1.5, bell1freq: 800, bell1q: 0.7 },
  },
  glue: {
    gentle: { threshold: -16, ratio: 2, attack: 30, release: 300 },
    glue: { threshold: -20, ratio: 4, attack: 10, release: 100 },
    pump: {
      threshold: -26,
      ratio: 10,
      attack: 0.1,
      release: 200,
      hpf: 0,
    },
  },
  tape: {
    warm: { drive: 3, bias: 0.15, tone: 16_000 },
    hot: { drive: 9, bias: 0.2, tone: 14_000 },
    crush: { drive: 18, bias: 0.3, tone: 9_000 },
  },
  width: {
    narrow: { width: 0.7, mono: 150 },
    wide: { width: 1.4, mono: 120 },
    vinyl: { width: 1, mono: 150 },
  },
  clip: {
    gentle: { drive: 2, softness: 0.7 },
    rave: { drive: 5, softness: 0.4 },
    hard: { drive: 8, softness: 0 },
  },
  limiter: {
    transparent: { release: 300, lookahead: 5 },
    loud: { release: 60, lookahead: 2 },
    brick: { release: 20, lookahead: 1 },
  },
});

export function isMasterUnit(name: string): name is MasterUnit {
  return (MASTER_UNITS as readonly string[]).includes(name);
}

/** A unit's full default values, as `master <unit> on` stores them. */
export function masterDefaults(unit: MasterUnit): FxValues {
  return normalizeParams(MASTER_SPECS[unit].params, {}, `master ${unit}`);
}

/** Whether the master changes anything (some unit on or a target). */
export function masterActive(master: SongMaster | undefined): boolean {
  return (
    master !== undefined &&
    (master.target !== undefined ||
      MASTER_UNITS.some((unit) => master[unit] !== undefined))
  );
}

/**
 * Validates a master: units fill every default, unknown keys are rejected
 * so typos never pass silently. An empty master normalizes to `undefined`.
 */
export function normalizeMaster(input: unknown): SongMaster | undefined {
  if (input === undefined || input === null) return undefined;
  if (!isRecord(input)) throw new FxValidationError("master must be an object");
  for (const key of Object.keys(input))
    if (key !== "target" && !isMasterUnit(key))
      throw new FxValidationError(
        `master has no "${key}"; use ${[...MASTER_UNITS, "target"].join(", ")}`,
      );
  const out: Record<string, FxValues | number> = {};
  for (const unit of MASTER_UNITS) {
    const value = input[unit];
    if (value === undefined || value === null) continue;
    out[unit] = normalizeParams(
      MASTER_SPECS[unit].params,
      value,
      `master ${unit}`,
    );
  }
  const target = input.target;
  if (target !== undefined && target !== null) {
    if (
      typeof target !== "number" ||
      !Number.isFinite(target) ||
      target < MASTER_LIMITS.minTarget ||
      target > MASTER_LIMITS.maxTarget
    )
      throw new FxValidationError(
        `master target must be ${MASTER_LIMITS.minTarget}..${MASTER_LIMITS.maxTarget} LUFS`,
      );
    out.target = target;
  }
  return Object.keys(out).length > 0
    ? (Object.freeze(out) as SongMaster)
    : undefined;
}

/** `eq low 2 · limiter ceiling -1 · target -14 LUFS`, for receipts. */
export function describeMaster(master: SongMaster | undefined): string {
  if (!masterActive(master)) return "off";
  const parts: string[] = [];
  for (const unit of MASTER_UNITS) {
    const values = master![unit];
    if (!values) continue;
    parts.push(`${unit} ${describeUnit(unit, values)}`.trim());
  }
  if (master!.target !== undefined)
    parts.push(`target ${formatNumber(master!.target)} LUFS`);
  return parts.join(" · ");
}

/** The non-default values of one unit, or its simple ones when all are. */
export function describeUnit(unit: MasterUnit, values: FxValues): string {
  const spec = MASTER_SPECS[unit];
  const changed = Object.entries(spec.params).filter(
    ([key, param]) =>
      values[key] !== undefined && values[key] !== param.default,
  );
  const shown =
    changed.length > 0
      ? changed.map(([key]) => key)
      : spec.simple.filter((key) => values[key] !== undefined);
  return shown
    .map((key) => {
      const value = values[key]!;
      const param = spec.params[key]!;
      const text =
        typeof value === "number"
          ? formatNumber(value)
          : typeof value === "boolean"
            ? value
              ? "on"
              : "off"
            : value;
      return param.kind === "number" && param.unit
        ? `${key} ${text} ${param.unit}`
        : `${key} ${text}`;
    })
    .join(", ");
}

function formatNumber(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}
