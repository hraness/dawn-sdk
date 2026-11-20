// SPDX-License-Identifier: MIT
import { resolveInstrumentWord } from "../instruments.ts";
import {
  INSTRUMENT_ICONS,
  INSTRUMENT_ICON_GRID,
  INSTRUMENT_ICON_STROKE,
  isInstrumentIcon,
  type InstrumentIcon,
} from "../icons/instruments.ts";

export {
  INSTRUMENT_ICONS,
  INSTRUMENT_ICON_GRID,
  INSTRUMENT_ICON_STROKE,
  type InstrumentIcon,
};

// These sound sources extend the DAWN player's drawings on the same 24-unit grid.
const soundPaths = {
  rain: "M4 9.5a4 4 0 0 1 4-4 5.5 5.5 0 0 1 10.5 2 3 3 0 0 1 0 6H5.5a2.5 2.5 0 0 1-1.5-4zM7 16l-1.5 3M12.5 16 11 19M18 16l-1.5 3",
  ocean:
    "M2.5 10.5c4 0 4.5-5 9-5 3.5 0 5 2.5 5.2 4.7-2.1-1.4-4.2-.3-4.2 1.2 0 2.2 5 2.9 9 1.2M2.5 16.5q2.3 2 4.7 0 2.3 2 4.8 0 2.3 2 4.8 0 2.3 2 4.7 0",
  stream:
    "M11.5 2.5c9 4.5-8 6-3.5 10 3.5 3.1 14 4.6 7 9M15.5 2.5c9 5.5-6.5 7.4-2.5 10.5 2.5 1.9 11 5.6 5.5 8.5",
  waterfall:
    "M2.5 6h8a4 4 0 0 1 4 4v5M2.5 9h6.2a2.3 2.3 0 0 1 2.3 2.3V17M18 9.5v5M7 19q2 1.8 4 0 2 1.8 4 0 2 1.8 4 0",
  birds:
    "M2.5 11.5c3.5-2.4 7 .2 9 6 1.6-6.5 4.8-10 10-10M12 5c1.5-.7 3 .1 3.6 1.6C16.4 4.9 17.8 4 20 4",
  crickets:
    "M4 16.5h10.5l3-3M7 16.5l4-7 3.5 7m-4-4 3.5-5 3 6.5m-9 3-2.5 4m10-4 3.5 3M17 10.5l3-5m-3 5 4.5-2",
  "country-road":
    "M8.5 3c6 6.5-1.7 12-5.5 18M13.5 3c8 5.5 2 13 7.5 18M12 7.5l.4 1.5m.2 4-.6 3.2",
  air: "M3 9h11a3 3 0 1 0-2.8-4M2.5 13h16a2.5 2.5 0 1 0-2.4-3.2M5 17h6a2.7 2.7 0 1 1-2.5 3.5",
  tape: "M4.5 5h15a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM5.5 10a2 2 0 1 0 4 0 2 2 0 1 0-4 0m9 0a2 2 0 1 0 4 0 2 2 0 1 0-4 0M6 19l2-4h8l2 4",
  brush: "M6 3l5 9m-1-10 2 10m2-10-1 10m5-8-4 8m7-5-6 6M11 12l4 1-3 9-3-1z",
  paper: "M5 3h10l4 4v14H5zM14 3v5h5M6 17l6-5 5 4",
  porcelain:
    "M3.5 7h13v5a6.5 6.5 0 0 1-13 0zM16.5 8h2a2.5 2.5 0 0 1 0 5h-2M3 21h15",
  "pulse-wave": "M2.5 17h3V7H12v10h6.5V7h3",
  "triangle-wave": "M2.5 13 7 5.5l9 13 5.5-8",
} as const;

const controlPaths = {
  "score-library": "M4 7.5v12h13M7.5 4h13v12h-13zM11 12h3m.5-4h3",
  level: "M3 18h3v-4H3zm7.5 0h3v-8h-3zm7.5 0h3V5h-3z",
  pan: "M3 12h18M7 8l-4 4 4 4m10-8 4 4-4 4M12 5v4m0 6v4",
  width: "M3.5 6v12m17-12v12M5.5 12h13M9 9l-3 3 3 3m6-6 3 3-3 3",
  room: "M3.5 19.5v-13l7-3 10 4v12M3.5 6.5l7 3 10-2M10.5 9.5v10",
  echo: "M3 6v12M8 8v8m5-7v6m5-5v4",
  filter: "M3 6.5h6c2 0 2.5-2 4-2 2 0 2 3.5 3 6.5l3 8h2",
  envelope: "M2.5 19.5 7 4l4.5 9H17l4.5 6.5",
  tuning: "M8 3v6a4 4 0 0 0 8 0V3M12 13v8",
  modulation:
    "M2.5 12c2.4 0 2.4-6 4.8-6s2.4 12 4.7 12 2.4-12 4.8-12 2.3 6 4.7 6",
  tone: "M4 18.5h16M5.5 15.5a6.5 6.5 0 0 1 13 0M12 2.5v3M3 7l2 2m14 0 2-2",
  mix: "M3 5h3c5 0 6 7 11 7h4M3 19h3c5 0 6-7 11-7",
  controls: "M3 7h8m4 0h6M3 17h3m4 0h11M11 4v6m4-6v6M6 14v6m4-6v6",
} as const;

/** Stroke paths for SVG, Path2D or a native vector surface. DAWN uses round caps and joins. */
const allIconPaths = () =>
  Object.freeze({
    ...INSTRUMENT_ICONS,
    ...soundPaths,
    ...controlPaths,
  });
export const DAWN_ICON_PATHS = /* @__PURE__ */ allIconPaths();
export type DawnIconName = keyof typeof DAWN_ICON_PATHS;
type SoundIcon = InstrumentIcon | keyof typeof soundPaths;

const engineAliases: ReadonlyMap<string, SoundIcon> = /* @__PURE__ */ new Map(
  /* @__PURE__ */ (
    [
      [
        "piano",
        [
          "grand",
          "upright",
          "felt",
          "honkytonk",
          "prepared",
          "keys",
          "felt-piano",
          "prepared-piano",
        ],
      ],
      [
        "electric-piano",
        ["epiano", "wurli", "clav", "tine-piano", "reed-piano"],
      ],
      ["organ", ["tonewheel", "combo", "pipe"]],
      [
        "mallets",
        ["modal", "marimba", "soft-vibes", "thumb-piano", "dulcimer"],
      ],
      ["bells", ["bell", "glass-bell", "singing-bowl"]],
      ["percussion", ["frame-drum"]],
      ["kick", ["round-kick"]],
      ["drum-kit", ["kit", "drums"]],
      ["strings", ["string", "viola"]],
      ["guitar", ["sitar"]],
      ["cello", ["contrabass", "upright-bass"]],
      ["bass-guitar", ["ebass"]],
      ["lead-vocal", ["sing", "vox", "alto-vowel", "tenor-vowel"]],
      ["woodwind", ["wind", "bamboo-flute"]],
      ["pad", ["drift-pad", "sequence-haze"]],
      ["arp", ["pulse-sequence"]],
      ["bass-synth", ["bass", "offbeat-bass"]],
      ["sub", ["sine"]],
      ["lead-synth", ["lead", "saw", "sawtooth", "tan", "user", "wavetable"]],
      ["pulse-wave", ["square", "pulse"]],
      ["triangle-wave", ["triangle"]],
      ["noise", ["texture", "white", "pink", "brown", "crackle", "fx"]],
    ] satisfies [SoundIcon, string[]][]
  ).flatMap(([icon, names]) => names.map((name) => [name, icon] as const)),
);

type PresetHint = Readonly<{ preset?: string }>;
/** Accepts a DAWN score track, a published track with an explicit icon, or an engine ID. */
type IconTrack = Readonly<{
  instrument?: string;
  icon?: string;
  role?: string;
  string?: PresetHint;
  modal?: PresetHint;
  wind?: PresetHint;
  sing?: PresetHint;
  texture?: Readonly<{ type?: string }>;
}>;

const soundIcon = (id: string): SoundIcon | undefined =>
  isInstrumentIcon(id) || Object.hasOwn(soundPaths, id)
    ? (id as SoundIcon)
    : engineAliases.get(id);

function presetIcon(
  engine: "string" | "modal" | "wind" | "sing",
  preset: string,
): SoundIcon | undefined {
  switch (engine) {
    case "string":
      if (/^(ebass|slap|motown)$/.test(preset)) return "bass-guitar";
      if (/^(upright|contrabass(es)?|cellos?)$/.test(preset)) return "cello";
      if (/^(violas?|violins?|fiddle|erhu|kamancheh|trem)$/.test(preset))
        return "strings";
      if (/^(dulcimer|santur)$/.test(preset)) return "mallets";
      if (preset === "harp") return "harp";
      if (/^(pizz|harpsichord|koto|tanpura)$/.test(preset)) return "pluck";
      if (
        /^(nylon|steel|electric|jangle|sitar|lute|oud|setar|tar|banjo|tres|requinto)$/.test(
          preset,
        )
      )
        return "guitar";
      break;
    case "modal":
      if (/^(glock|celesta|chimes|crotales|musicbox|bowl)$/.test(preset))
        return "bells";
      if (/^(gong|kempul)$/.test(preset)) return "cymbal";
      if (/^(bodhran|daf|tabla|timpani)$/.test(preset)) return "percussion";
      break;
    case "wind":
      if (/^(trumpet|harmon|plunger|trombone|tuba|horn)$/.test(preset))
        return "brass";
      break;
    case "sing":
      if (/^(choir|oohchoir|chorale)$/.test(preset)) return "backing-vocal";
      break;
  }
}

export function instrumentIcon(value: string | IconTrack): SoundIcon {
  const track = typeof value === "string" ? { instrument: value } : value;
  if (
    track.icon &&
    (isInstrumentIcon(track.icon) || Object.hasOwn(soundPaths, track.icon))
  )
    return track.icon as SoundIcon;
  const engine = (track.instrument ?? "")
    .trim()
    .toLowerCase()
    .replace(/^z_/, "");
  if (engine === "texture" && track.texture?.type) {
    const texture = track.texture.type;
    if (texture === "wind") return "air";
    return Object.hasOwn(soundPaths, texture)
      ? (texture as keyof typeof soundPaths)
      : "noise";
  }
  if (
    engine === "string" ||
    engine === "modal" ||
    engine === "wind" ||
    engine === "sing"
  ) {
    const preset = track[engine]?.preset;
    if (preset) {
      const icon = presetIcon(engine, preset);
      if (icon) return icon;
    }
  }
  const known = soundIcon(engine);
  if (known) return known;
  // Words such as "trumpet" and "classical" resolve through the same catalog
  // as a DAWN score. Inspect its normalized engine and preset together.
  const word = resolveInstrumentWord(engine);
  if (word && word.instrument !== engine) {
    const family = word.instrument;
    if (
      word.preset &&
      (family === "wind" ||
        family === "string" ||
        family === "modal" ||
        family === "sing")
    ) {
      const icon = presetIcon(family, word.preset);
      if (icon) return icon;
    }
    const icon = soundIcon(family);
    if (icon) return icon;
  }
  return soundIcon(track.role ?? "") ?? "generic";
}

/** Accepts DAWN parameter keys such as gain, pan, synth.lpattack and reverb.mix. */
export function parameterIcon(key: string): keyof typeof controlPaths {
  const parts = key.toLowerCase().replace(/[ _-]/g, "").split(".");
  const name = parts.at(-1) ?? "";
  if (parts.includes("reverb") || /^(room|reverb)(mix)?$/.test(name))
    return "room";
  if (parts.includes("delay") || /^(echo|delay)(mix|feedback)?$/.test(name))
    return "echo";
  if (/^(gain|vol(ume)?|level|tracklevel|percvol|velocity|vel)$/.test(name))
    return "level";
  if (name === "pan") return "pan";
  if (/^(width|spread|stereo)$/.test(name)) return "width";
  if (/(attack|decay|sustain|release|env)[2-8]?$/.test(name)) return "envelope";
  if (/^(filter|cutoff|resonance|[lhb]p[fq]|notch)$/.test(name))
    return "filter";
  if (/^(pitch|tuning|transpose|cents|detune|oct(ave)?|octbelow)$/.test(name))
    return "tuning";
  if (/^(bright(ness)?|hardness|warmth|tone|tilt)$/.test(name)) return "tone";
  if (
    /^(motion|movement|modulation|lfo|vib(mod|ehz)?|trem(olo|hz)?|flutter)$/.test(
      name,
    )
  )
    return "modulation";
  if (/^(mix|wet|dry|blend)$/.test(name)) return "mix";
  return "controls";
}

/** Make a decorative currentColor glyph alongside an accessible name supplied by the caller. */
export function createIcon(
  document: Document,
  name: DawnIconName,
): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute(
    "viewBox",
    `0 0 ${INSTRUMENT_ICON_GRID} ${INSTRUMENT_ICON_GRID}`,
  );
  svg.setAttribute("width", "1em");
  svg.setAttribute("height", "1em");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", String(INSTRUMENT_ICON_STROKE));
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const path = document.createElementNS(ns, "path");
  path.setAttribute(
    "d",
    Object.hasOwn(DAWN_ICON_PATHS, name)
      ? DAWN_ICON_PATHS[name]
      : INSTRUMENT_ICONS.generic,
  );
  svg.append(path);
  return svg;
}
