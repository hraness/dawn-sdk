// SPDX-License-Identifier: MIT
/**
 * The texture engine's settings (`instrument: "texture"` with a `texture`
 * field): seeded DSP beds and noises (room tone, rain, wind, vinyl, tape,
 * mains hum, city, crowd murmur, data glitches and air) with four musical
 * knobs, `density`, `distance`, `wear` and `width`. The renderer lives in
 * `src/audio/texture/`. Pitch does not tune a texture: a note is one event,
 * its length the bed's length and its velocity the level.
 */
import {
  FxValidationError,
  isRecord,
  normalizeParams,
  type EnumParam,
  type NumberParam,
  type ParamSpec,
} from "./params.ts";

/** The `Track.instrument` value the texture engine plays. */
export const TEXTURE_INSTRUMENT = "texture" as const;

/** Texture types, in browsing order. */
export const TEXTURE_TYPES = Object.freeze([
  "room",
  "rain",
  "wind",
  "vinyl",
  "tape",
  "hum",
  "city",
  "crowd",
  "data",
  "air",
  "ocean",
  "stream",
  "waterfall",
  "crickets",
  "birds",
  "country-road",
  "brush",
  "paper",
  "porcelain",
] as const);
export type TextureType = (typeof TEXTURE_TYPES)[number];

/** How a note's sound moves over its length (whoosh and riser shapes). */
export const TEXTURE_MOTIONS = Object.freeze([
  "steady",
  "rise",
  "fall",
  "swell",
] as const);
export type TextureMotion = (typeof TEXTURE_MOTIONS)[number];

/** One line per type for help and the docs. */
export const TEXTURE_DOCS: Readonly<Record<TextureType, string>> =
  Object.freeze({
    room: "room tone: shaped noise through an 8x8 Hadamard FDN with moving delays",
    rain: "Poisson raindrops as rising bubble chirps over a filtered-noise bed",
    wind: "band-passed noise whose center and Q follow gusts, plus whistles",
    vinyl: "record surface: crackle, pops and rumble",
    tape: "tape hiss with wow, flutter, modulation noise and a head bump",
    hum: "50 or 60 Hz mains hum: a harmonic series plus noise",
    city: "traffic swells, distant rumble and clatter through a street FDN",
    crowd: "murmur: seeded formant bursts (syllables) from many talkers",
    data: "glitches: bit-flips, buffer stutters, sample-rate sweeps, clicks, modem bursts",
    air: "high shimmering band noise",
    ocean: "grouped ocean swell, asymmetric breaks and foamy wash",
    stream: "running water with bright gurgling bubbles",
    waterfall: "a broad sheet of falling water with deep turbulence",
    crickets: "stereo night insects in pulsed chirp trains",
    birds: "scattered birdsong with bent whistle calls",
    "country-road":
      "distant tires and a low engine drifting across a quiet road",
    brush: "bristles brushing a drum skin in soft, uneven strokes",
    paper: "flexing paper, with clusters of creases and a dry rustle",
    porcelain: "tapped ceramic with a hollow body and beating partials",
  });

const num = (
  min: number,
  max: number,
  fallback: number,
  step: number | "log",
  doc: string,
  extra: Partial<NumberParam> = {},
): NumberParam =>
  Object.freeze({
    kind: "number",
    min,
    max,
    default: fallback,
    step,
    optional: true,
    doc,
    ...extra,
  });

/**
 * Every texture parameter. All are optional: an absent one takes the
 * type's value, then the default here. `automate` ones have a
 * `texture-<param>` lane, read every 128-sample control block.
 */
export const TEXTURE_PARAMS: Readonly<Record<string, ParamSpec>> =
  Object.freeze({
    type: Object.freeze({
      kind: "enum",
      values: TEXTURE_TYPES,
      default: "room",
      optional: true,
      doc: `texture: ${TEXTURE_TYPES.join(", ")}`,
    }) as EnumParam,
    density: num(
      0,
      1,
      0.5,
      0.05,
      "how much happens: drops, gusts, crackle, talkers, glitches",
      {
        automate: true,
      },
    ),
    distance: num(0, 1, 0.3, 0.05, "near and bright to far, dark and roomy", {
      automate: true,
    }),
    wear: num(
      0,
      1,
      0.3,
      0.05,
      "clean to worn: grit, whistles, pops, flutter, buzz",
      {
        automate: true,
      },
    ),
    width: num(
      0,
      1,
      0.7,
      0.05,
      "mono to wide (left and right stay correlated)",
      {
        automate: true,
      },
    ),
    motion: Object.freeze({
      kind: "enum",
      values: TEXTURE_MOTIONS,
      default: "steady",
      optional: true,
      doc: "over each note: steady, rise (riser), fall (downlifter) or swell (whoosh)",
    }) as EnumParam,
    mains: num(40, 70, 60, 10, "hum fundamental (50 or 60 Hz mains)", {
      unit: "Hz",
    }),
    attack: num(0.001, 10, 0.4, "log", "fade in at each note", {
      unit: "s",
      strudel: ["att"],
    }),
    release: num(0.005, 10, 1, "log", "fade out after each note", {
      unit: "s",
      strudel: ["rel"],
    }),
    gain: num(0, 2, 1, 0.05, "level", { automate: true }),
    seed: num(0, 65535, 0, 1, "variation: another seed, another bed", {
      integer: true,
    }),
  });

/** A track's stored texture settings: a type plus overrides, all optional. */
export type TrackTexture = Readonly<{
  type?: TextureType;
  density?: number;
  distance?: number;
  wear?: number;
  width?: number;
  motion?: TextureMotion;
  mains?: number;
  attack?: number;
  release?: number;
  gain?: number;
  seed?: number;
}>;

/** What a texture plays: every parameter resolved. */
export type TextureSettings = Readonly<{
  type: TextureType;
  density: number;
  distance: number;
  wear: number;
  width: number;
  motion: TextureMotion;
  mains: number;
  attack: number;
  release: number;
  gain: number;
  seed: number;
}>;

/** Each type's own starting point (the type word alone plays these). */
export const TEXTURE_TYPE_DEFAULTS: Readonly<
  Record<TextureType, Readonly<Partial<TextureSettings>>>
> = Object.freeze({
  room: { density: 0.4, distance: 0.5, wear: 0.2, width: 0.7 },
  rain: { density: 0.5, distance: 0.3, wear: 0.3, width: 0.8 },
  wind: { density: 0.5, distance: 0.3, wear: 0.3, width: 0.7 },
  vinyl: { density: 0.4, distance: 0.1, wear: 0.3, width: 0.5 },
  tape: { density: 0.5, distance: 0.1, wear: 0.3, width: 0.5 },
  hum: { density: 0.4, distance: 0.2, wear: 0.3, width: 0.2 },
  city: { density: 0.5, distance: 0.5, wear: 0.3, width: 0.8 },
  crowd: { density: 0.5, distance: 0.5, wear: 0.2, width: 0.8 },
  data: { density: 0.5, distance: 0.1, wear: 0.4, width: 0.6 },
  air: { density: 0.5, distance: 0.2, wear: 0.2, width: 0.8 },
  ocean: { density: 0.5, distance: 0.25, wear: 0.32, width: 0.78 },
  stream: { density: 0.5, distance: 0.25, wear: 0.32, width: 0.78 },
  waterfall: { density: 0.5, distance: 0.25, wear: 0.32, width: 0.78 },
  crickets: { density: 0.5, distance: 0.25, wear: 0.32, width: 0.78 },
  birds: { density: 0.5, distance: 0.25, wear: 0.32, width: 0.78 },
  "country-road": { density: 0.5, distance: 0.25, wear: 0.32, width: 0.78 },
  brush: {
    density: 0.46,
    distance: 0.22,
    wear: 0.23,
    width: 0.58,
    attack: 0.005,
    release: 0.07,
  },
  paper: {
    density: 0.43,
    distance: 0.16,
    wear: 0.51,
    width: 0.78,
    attack: 0.004,
    release: 0.12,
  },
  porcelain: {
    density: 0.35,
    distance: 0.22,
    wear: 0.26,
    width: 0.72,
    attack: 0.001,
    release: 0.65,
  },
});

export const TEXTURE_DEFAULTS: TextureSettings = Object.freeze({
  type: "room",
  density: 0.5,
  distance: 0.3,
  wear: 0.3,
  width: 0.7,
  motion: "steady",
  mains: 60,
  attack: 0.4,
  release: 1,
  gain: 1,
  seed: 0,
});

export function isTextureType(name: string): name is TextureType {
  return (TEXTURE_TYPES as readonly string[]).includes(name);
}

export function isTextureParam(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(TEXTURE_PARAMS, name);
}

/** Strudel spelling (`att`, `rel`) to a texture parameter name. */
export function textureParamName(name: string): string | undefined {
  if (isTextureParam(name)) return name;
  for (const [key, spec] of Object.entries(TEXTURE_PARAMS))
    if (spec.strudel?.includes(name)) return key;
  return undefined;
}

/**
 * Validates a `texture` field: `{ type?, ...overrides }`, null or absent
 * meaning none. Keys come out in `TEXTURE_PARAMS` order so equal settings
 * print equally. `{}` is kept: it means room tone.
 */
export function normalizeTexture(input: unknown): TrackTexture | undefined {
  if (input === undefined || input === null) return undefined;
  if (!isRecord(input))
    throw new FxValidationError("track texture must be an object or null");
  const params: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    const name = textureParamName(key);
    if (!name)
      throw new FxValidationError(
        `texture has no parameter "${key.slice(0, 32)}"`,
      );
    params[name] =
      name === "type" && typeof value === "string"
        ? value.trim().toLowerCase()
        : value;
  }
  return normalizeParams(
    TEXTURE_PARAMS,
    params,
    "texture",
    false,
  ) as TrackTexture;
}

/**
 * The settings a `texture` field plays: defaults, then the type's values,
 * then explicit overrides.
 */
export function textureSettings(
  texture: TrackTexture | undefined,
): TextureSettings {
  const type = texture?.type ?? TEXTURE_DEFAULTS.type;
  const out: Record<string, number | string> = {
    ...TEXTURE_DEFAULTS,
    ...TEXTURE_TYPE_DEFAULTS[type],
  };
  if (texture)
    for (const [key, value] of Object.entries(texture))
      if (value !== undefined) out[key] = value;
  out.type = type;
  return Object.freeze(out) as TextureSettings;
}

/** Parameters with a `texture-<param>` automation lane. */
export const TEXTURE_LANE_PARAMS: readonly Readonly<{
  param: string;
  spec: NumberParam;
}>[] = Object.freeze(
  Object.entries(TEXTURE_PARAMS)
    .filter(
      (entry): entry is [string, NumberParam] =>
        entry[1].kind === "number" && entry[1].automate === true,
    )
    .map(([param, spec]) => Object.freeze({ param, spec })),
);

/** Voices one texture track sounds at once; the oldest onset is stolen. */
export const MAX_TEXTURE_VOICES = 8;

/** Joins the stem cache key so a DSP change re-renders texture stems. */
export const TEXTURE_ENGINE_VERSION = 3;

/**
 * A texture track's ring-out after its last note-off, in seconds: the
 * release fade, then the FDN's decay at the track's distance (or at the
 * farthest, when a `texture-distance` lane can move it).
 */
export function textureTailSeconds(
  texture: TrackTexture | undefined,
  distanceLane = false,
): number {
  const settings = textureSettings(texture);
  const distance = distanceLane ? 1 : settings.distance;
  return Math.min(12, settings.release + 0.5 + 2.5 * distance);
}
