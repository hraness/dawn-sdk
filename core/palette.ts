/** Declarative sound palettes: reusable patches and metadata, never composition code. */
import { validatePatch, type Patch } from "./patch.ts";
import { patchContext } from "./score.ts";

export const PALETTE_SCHEMA = "dawn.palette/v1";
export const PALETTE_LIMITS = Object.freeze({
  maxSounds: 64,
  maxId: 64,
  maxText: 200,
  maxDescription: 1000,
  maxTags: 16,
  maxTag: 40,
  maxDepth: 24,
  maxValues: 100_000,
  maxString: 4096,
});
export const PALETTE_ROLES = [
  "bass",
  "bed",
  "lead",
  "keys",
  "drums",
  "texture",
  "effect",
] as const;
export type PaletteRole = (typeof PALETTE_ROLES)[number];
export type PaletteSound = Readonly<{
  id: string;
  title: string;
  role: PaletteRole;
  description?: string;
  tags?: readonly string[];
  range?: Readonly<{ min: number; max: number }>;
  patch: Patch;
}>;
export type PalettePack = Readonly<{
  schema: typeof PALETTE_SCHEMA;
  id: string;
  version: string;
  title: string;
  author: string;
  license: string;
  sounds: readonly PaletteSound[];
}>;
export class PaletteValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaletteValidationError";
  }
}
const fail = (message: string): never => {
  throw new PaletteValidationError(message);
};

/** Copy bounded JSON data without invoking getters or retaining caller-owned objects. */
function jsonData(value: unknown): unknown {
  let count = 0;
  const ancestors = new Set<object>();
  const visit = (v: unknown, depth: number): unknown => {
    if (++count > PALETTE_LIMITS.maxValues || depth > PALETTE_LIMITS.maxDepth)
      fail("palette exceeds its data size or nesting limit");
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "string") {
      if (v.length > PALETTE_LIMITS.maxString)
        fail("palette string is too long");
      return v;
    }
    if (typeof v === "number") {
      if (!Number.isFinite(v)) fail("palette numbers must be finite");
      return v;
    }
    if (typeof v !== "object") fail("palette must contain only JSON data");
    const obj = v as object;
    const array = Array.isArray(obj);
    const prototype = Object.getPrototypeOf(obj);
    if (
      array
        ? prototype !== Array.prototype
        : prototype !== Object.prototype && prototype !== null
    )
      fail("palette objects must be plain JSON objects");
    if (ancestors.has(obj)) fail("palette must not contain cycles");
    ancestors.add(obj);
    const keys = Reflect.ownKeys(obj);
    if (keys.length > PALETTE_LIMITS.maxValues - count)
      fail("palette has too many fields");
    if (array && (obj as unknown[]).length > PALETTE_LIMITS.maxValues)
      fail("palette array is too long");
    const out: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      if (array && key === "length") continue;
      if (
        typeof key !== "string" ||
        ["__proto__", "prototype", "constructor"].includes(key)
      )
        fail("palette contains a forbidden key");
      if (array && !/^(0|[1-9][0-9]*)$/.test(key as string))
        fail("palette arrays must contain only indexed values");
      const descriptor = Object.getOwnPropertyDescriptor(obj, key)!;
      if (!descriptor.enumerable || !("value" in descriptor))
        fail("palette fields must be enumerable data");
      out[key as string] = visit(descriptor.value, depth + 1);
    }
    ancestors.delete(obj);
    if (!array) return out;
    const length = (obj as unknown[]).length;
    if (Object.keys(out).length !== length)
      fail("palette arrays must not be sparse");
    return Array.from({ length }, (_, i) => out[String(i)]);
  };
  return visit(value, 0);
}
function record(
  value: unknown,
  fields: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(`${label} must be an object`);
  const r = value as Record<string, unknown>;
  for (const key of Object.keys(r))
    if (!fields.includes(key)) fail(`${label} has no field "${key}"`);
  return r;
}
function text(
  value: unknown,
  label: string,
  max: number = PALETTE_LIMITS.maxText,
): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    fail(`${label} must be 1..${max} characters without control characters`);
  return value as string;
}
function id(value: unknown, label: string): string {
  const s = text(value, label, PALETTE_LIMITS.maxId);
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(s))
    fail(`${label} must be a lowercase slug`);
  return s;
}
/** Validate and freeze a self-contained palette. No imports, downloads or code execute. */
export function parsePalettePack(value: unknown): PalettePack {
  const r = record(
    jsonData(value),
    ["schema", "id", "version", "title", "author", "license", "sounds"],
    "palette",
  );
  if (r.schema !== PALETTE_SCHEMA)
    fail(`palette schema must be ${PALETTE_SCHEMA}`);
  const version = text(r.version, "palette version", 100);
  const n = "(?:0|[1-9][0-9]*)";
  const pre = "(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)";
  if (
    !new RegExp(
      `^${n}\\.${n}\\.${n}(?:-${pre}(?:\\.${pre})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
    ).test(version)
  )
    fail("palette version must be semantic versioning (major.minor.patch)");
  if (
    !Array.isArray(r.sounds) ||
    r.sounds.length < 1 ||
    r.sounds.length > PALETTE_LIMITS.maxSounds
  )
    fail(`palette sounds must contain 1..${PALETTE_LIMITS.maxSounds} sounds`);
  const seen = new Set<string>();
  const sounds = (r.sounds as unknown[]).map((raw, i): PaletteSound => {
    const label = `sound ${i + 1}`;
    const s = record(
      raw,
      ["id", "title", "role", "description", "tags", "range", "patch"],
      label,
    );
    const soundId = id(s.id, `${label} id`);
    if (seen.has(soundId)) fail(`duplicate sound id "${soundId}"`);
    seen.add(soundId);
    if (!(PALETTE_ROLES as readonly unknown[]).includes(s.role))
      fail(`${label} has an unknown role`);
    let patch: Patch;
    try {
      patch = validatePatch(s.patch, patchContext({}, `${label} patch`));
    } catch (error) {
      fail(
        `${label}: ${error instanceof Error ? error.message : "invalid patch"}`,
      );
    }
    if (
      patch!.side ||
      patch!.cables.some((cable) => cable.from === "in.side") ||
      patch!.nodes.some(
        (node) =>
          ["engine.granular", "engine.vocoder"].includes(node.type) ||
          ["sampler", "wavetable"].includes(
            String(node.params?.instrument ?? "")
              .trim()
              .toLowerCase(),
          ) ||
          (node.params?.settings &&
            typeof node.params.settings === "object" &&
            ["sampler", "wavetable"].some(
              (field) => field in (node.params!.settings as object),
            )),
      )
    )
      fail(
        `${label} must be self-contained synthesis; external samples and sidechains are not palette v1`,
      );
    const freezeData = (v: unknown): void => {
      if (v && typeof v === "object") {
        for (const child of Object.values(v)) freezeData(child);
        Object.freeze(v);
      }
    };
    freezeData(patch!);
    if ((s.role === "effect") !== (patch!.role === "effect"))
      fail(`${label} role does not match its patch`);
    let tags: readonly string[] | undefined;
    if (s.tags !== undefined) {
      if (!Array.isArray(s.tags) || s.tags.length > PALETTE_LIMITS.maxTags)
        fail(`${label} has too many tags or tags is not a list`);
      tags = Object.freeze(
        (s.tags as unknown[]).map((t) =>
          text(t, `${label} tag`, PALETTE_LIMITS.maxTag),
        ),
      );
      if (new Set(tags).size !== tags.length)
        fail(`${label} has duplicate tags`);
    }
    let range: Readonly<{ min: number; max: number }> | undefined;
    if (s.range !== undefined) {
      const v = record(s.range, ["min", "max"], `${label} range`);
      if (
        ![v.min, v.max].every(
          (n) =>
            typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= 127,
        ) ||
        (v.min as number) > (v.max as number)
      )
        fail(`${label} range must be ordered MIDI integers from 0 to 127`);
      range = Object.freeze({ min: v.min as number, max: v.max as number });
    }
    return Object.freeze({
      id: soundId,
      title: text(s.title, `${label} title`),
      role: s.role as PaletteRole,
      ...(s.description !== undefined
        ? {
            description: text(
              s.description,
              `${label} description`,
              PALETTE_LIMITS.maxDescription,
            ),
          }
        : {}),
      ...(tags !== undefined ? { tags } : {}),
      ...(range ? { range } : {}),
      patch: patch!,
    });
  });
  return Object.freeze({
    schema: PALETTE_SCHEMA,
    id: id(r.id, "palette id"),
    version,
    title: text(r.title, "palette title"),
    author: text(r.author, "palette author"),
    license: text(r.license, "palette license"),
    sounds: Object.freeze(sounds),
  });
}
