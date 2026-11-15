/**
 * WebAssembly devices in the render (core/device.ts, docs/devices.md): the
 * `device.fx` and `device.synth` buffer nodes, the `device.notes` rewrite
 * of a patch's notes, and loading a project's `devices/` folder.
 *
 * Every node gets a fresh instance per render, so nothing carries over
 * between renders, and the device sees the same blocks, controls and
 * events in the same order every time.
 */
import { createHash } from "node:crypto";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  compileDevice,
  Device,
  DEVICE_BLOCK,
  DEVICE_LIMITS,
  DEVICE_PARAMS,
  type CompiledDevice,
  type DeviceEvent,
  type DeviceKind,
  type DeviceNote,
} from "../../../core/device.ts";
import { resolvePatch, type Patch } from "../../../core/patch.ts";
import type { TrackScore } from "../../../core/score.ts";
import type { BufferIo, PatchNote } from "./run.ts";
import { BLOCK } from "./run.ts";

/** Devices by content hash (`sha256:<hex>`): the bytes of each `.wasm` file. */
export type DeviceFiles = ReadonlyMap<string, Uint8Array>;

/** The project folder DAWN reads devices from. */
export const DEVICE_DIR = "devices";
/** At most this many `.wasm` files are read from `devices/`. */
export const MAX_DEVICE_FILES = 64;
/** Seconds a patch with a `device.synth` rings past its last note-off. */
export const DEVICE_TAIL_SECONDS = 2;

/** `sha256:` and the hex digest of `bytes`. */
export function deviceHash(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/** Every patch a score plays: the library, track instruments and effect patches. */
function scorePatches(score: TrackScore): Patch[] {
  const library = score.patches ?? {};
  const out: Patch[] = Object.values(library);
  for (const track of score.tracks) {
    if (track.patch) {
      const patch = resolvePatch(track.patch, library);
      if (patch) out.push(patch);
    }
    for (const fx of track.fxPatch ?? []) out.push(fx);
  }
  return out;
}

/** The device hashes a patch names, sorted. */
export function patchDeviceRefs(patch: Patch): string[] {
  const refs = new Set<string>();
  for (const node of patch.nodes)
    if (
      node.type.startsWith("device.") &&
      typeof node.params?.device === "string"
    )
      refs.add(node.params.device);
  return [...refs].sort();
}

/** The device hashes a score names, sorted; empty when it uses none. */
export function scoreDeviceRefs(score: TrackScore): string[] {
  const refs = new Set<string>();
  for (const patch of scorePatches(score))
    for (const ref of patchDeviceRefs(patch)) refs.add(ref);
  return [...refs].sort();
}

/** The track ids whose patches name `hash`, for problem reports. */
export function tracksUsingDevice(score: TrackScore, hash: string): string[] {
  const library = score.patches ?? {};
  return score.tracks
    .filter((track) => {
      const patches = [
        ...(track.patch ? [resolvePatch(track.patch, library)] : []),
        ...(track.fxPatch ?? []),
      ];
      return patches.some(
        (patch) => patch && patchDeviceRefs(patch).includes(hash),
      );
    })
    .map((track) => track.id);
}

async function readBounded(path: string): Promise<Uint8Array> {
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("not a regular file");
    if (info.size > DEVICE_LIMITS.maxBytes)
      throw new Error(`larger than ${DEVICE_LIMITS.maxBytes} bytes`);
    const buffer = new Uint8Array(DEVICE_LIMITS.maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > DEVICE_LIMITS.maxBytes)
      throw new Error(`larger than ${DEVICE_LIMITS.maxBytes} bytes`);
    return buffer.slice(0, length);
  } finally {
    await handle.close();
  }
}

export type DeviceLoad = Readonly<{
  devices: DeviceFiles;
  /** Hashes the score names that no file in `devices/` matches. */
  missing: readonly string[];
  /** Files that could not be read or checked: `devices/<name> · why`. */
  errors: readonly string[];
}>;

/**
 * Reads the project's `devices/*.wasm` (regular files only, at most
 * `MAX_DEVICE_FILES`, each within the module size limit), hashes each and
 * keeps the ones `wanted` names after checking them against the ABI.
 */
export async function loadProjectDevices(
  projectRoot: string,
  wanted: readonly string[],
): Promise<DeviceLoad> {
  const devices = new Map<string, Uint8Array>();
  const errors: string[] = [];
  if (wanted.length === 0) return { devices, missing: [], errors };
  const dir = join(projectRoot, DEVICE_DIR);
  let names: string[] = [];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith(".wasm"));
  } catch {
    names = [];
  }
  names.sort();
  if (names.length > MAX_DEVICE_FILES) {
    errors.push(
      `${DEVICE_DIR}/ holds ${names.length} .wasm files; at most ${MAX_DEVICE_FILES} are read`,
    );
    names = names.slice(0, MAX_DEVICE_FILES);
  }
  const want = new Set(wanted);
  for (const name of names) {
    const path = join(dir, name);
    try {
      if ((await lstat(path)).isSymbolicLink())
        throw new Error("symbolic links are not read");
      const bytes = await readBounded(path);
      const hash = deviceHash(bytes);
      if (!want.has(hash) || devices.has(hash)) continue;
      compiledDevice(hash, bytes);
      devices.set(hash, bytes);
    } catch (error) {
      errors.push(
        `${DEVICE_DIR}/${name} · ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return {
    devices,
    missing: wanted.filter((hash) => !devices.has(hash)),
    errors,
  };
}

const COMPILED = new Map<string, CompiledDevice>();
const CACHE_SIZE = 32;
/** Byte arrays already hashed, and their hash. */
const VERIFIED = new WeakMap<Uint8Array, string>();

/**
 * The compiled module for `hash`, cached by hash (most recent last). The
 * bytes are hashed once per array, so a cached hash never vouches for
 * different bytes.
 */
export function compiledDevice(
  hash: string,
  bytes: Uint8Array,
): CompiledDevice {
  let actual = VERIFIED.get(bytes);
  if (actual === undefined) {
    actual = deviceHash(bytes);
    VERIFIED.set(bytes, actual);
  }
  if (actual !== hash)
    throw new Error(`device ${hash.slice(0, 19)}… does not match its bytes`);
  const hit = COMPILED.get(hash);
  if (hit) {
    COMPILED.delete(hash);
    COMPILED.set(hash, hit);
    return hit;
  }
  const compiled = compileDevice(bytes);
  COMPILED.set(hash, compiled);
  while (COMPILED.size > CACHE_SIZE)
    COMPILED.delete(COMPILED.keys().next().value!);
  return compiled;
}

function startDevice(
  hash: unknown,
  kind: DeviceKind,
  devices: DeviceFiles | undefined,
  sampleRate: number,
  label: string,
): Device {
  if (typeof hash !== "string") throw new Error(`${label}: no device hash`);
  const bytes = devices?.get(hash);
  if (!bytes)
    throw new Error(
      `${label}: device ${hash.slice(0, 19)}… is not loaded · put its .wasm file in the project's ${DEVICE_DIR}/ folder`,
    );
  const compiled = compiledDevice(hash, bytes);
  if (compiled.kind !== kind)
    throw new Error(
      `${label}: device ${hash.slice(0, 19)}… is a ${compiled.kind} device, not ${kind}`,
    );
  return new Device(compiled, sampleRate, label);
}

/** A control port's value at `frame`: knob or own value, plus cables, clamped 0..1. */
function controlAt(io: BufferIo, name: string, frame: number): number {
  const own = io.node.params[name];
  const knob = io.bases?.[name];
  const cable = io.inputs[name];
  const base = knob
    ? knob[Math.min(knob.length - 1, Math.floor(frame / BLOCK))]!
    : typeof own === "number"
      ? own
      : 0;
  const value = base + (cable ? cable[frame]! : 0);
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

/** Note-on and note-off events in render frames, in a fixed order. */
function noteEvents(notes: readonly PatchNote[], frames: number) {
  const events: (DeviceEvent & { at: number })[] = [];
  notes.forEach((note, voice) => {
    if (note.start >= frames) return;
    const base = {
      voice,
      note: Math.max(0, Math.min(127, Math.round(note.note))),
      velocity: note.velocity,
      hz: note.pitch,
    };
    events.push({ ...base, at: Math.max(0, note.start), frame: 0, on: true });
    if (note.end < frames)
      events.push({ ...base, at: Math.max(0, note.end), frame: 0, on: false });
  });
  // By frame, offs before ons, then by voice: the same order every render.
  return events.sort(
    (a, b) => a.at - b.at || Number(a.on) - Number(b.on) || a.voice - b.voice,
  );
}

/**
 * Runs a `device.fx` or `device.synth` node over the whole render, one
 * 128-frame block at a time. A synth plays `notes`.
 */
export function runDeviceNode(
  io: BufferIo,
  devices: DeviceFiles | undefined,
  notes: readonly PatchNote[],
): void {
  const { node, outputs, frames } = io;
  const synth = node.type === "device.synth";
  const device = startDevice(
    node.params.device,
    synth ? "synth" : "fx",
    devices,
    io.sampleRate,
    `node ${node.id}`,
  );
  const left = synth ? outputs.out! : outputs.left!;
  const right = outputs.right;
  const inLeft = synth ? undefined : io.inputs.left;
  const inRight = synth ? undefined : (io.inputs.right ?? inLeft);
  const events = synth ? noteEvents(notes, frames) : [];
  const bufL = new Float64Array(DEVICE_BLOCK);
  const bufR = new Float64Array(DEVICE_BLOCK);
  const outL = new Float64Array(DEVICE_BLOCK);
  const outR = new Float64Array(DEVICE_BLOCK);
  let next = 0;
  for (let start = 0; start < frames; start += DEVICE_BLOCK) {
    const n = Math.min(DEVICE_BLOCK, frames - start);
    for (let p = 0; p < DEVICE_PARAMS; p += 1)
      device.params[p] = controlAt(io, `p${p + 1}`, start);
    bufL.fill(0);
    bufR.fill(0);
    if (inLeft) bufL.set(inLeft.subarray(start, start + n));
    if (inRight) bufR.set(inRight.subarray(start, start + n));
    // Events due by the block's end; a burst over the limit waits a block.
    const block: DeviceEvent[] = [];
    while (
      next < events.length &&
      events[next]!.at < start + DEVICE_BLOCK &&
      block.length < DEVICE_LIMITS.maxEvents
    ) {
      const e = events[next++]!;
      block.push({
        frame: Math.max(0, e.at - start),
        on: e.on,
        voice: e.voice,
        note: e.note,
        velocity: e.velocity,
        hz: e.hz,
      });
    }
    device.block(
      synth ? undefined : bufL,
      synth ? undefined : bufR,
      block,
      outL,
      outR,
    );
    left.set(outL.subarray(0, n), start);
    right?.set(outR.subarray(0, n), start);
  }
}

/** The patch's `device.notes` node, if any (validation allows one). */
export function noteDevice(patch: Patch) {
  return patch.nodes.find((node) => node.type === "device.notes");
}

/**
 * Passes a patch's notes through its `device.notes` node: in start order,
 * `maxNotesIn` at a time. A rewritten note keeps its source's tuning (its
 * frequency moves by the pitch change) and a seed derived from it.
 */
export function transformPatchNotes(
  patch: Patch,
  notes: readonly PatchNote[],
  devices: DeviceFiles | undefined,
  sampleRate: number,
): PatchNote[] {
  const node = noteDevice(patch);
  if (!node) return [...notes];
  const device = startDevice(
    node.params?.device,
    "notes",
    devices,
    sampleRate,
    `node ${node.id}`,
  );
  for (let p = 0; p < DEVICE_PARAMS; p += 1) {
    const value = node.params?.[`p${p + 1}`];
    device.params[p] = typeof value === "number" ? value : 0;
  }
  const order = notes
    .map((note, index) => ({ note, index }))
    .sort((a, b) => a.note.start - b.note.start || a.index - b.index);
  const out: PatchNote[] = [];
  const made = new Map<number, number>();
  for (let i = 0; i < order.length; i += DEVICE_LIMITS.maxNotesIn) {
    const chunk: DeviceNote[] = order
      .slice(i, i + DEVICE_LIMITS.maxNotesIn)
      .map(({ note, index }) => ({
        start: note.start,
        length: Math.max(1, note.end - note.start),
        pitch: note.note,
        velocity: note.velocity,
        source: index,
      }));
    for (const result of device.transform(chunk)) {
      const source = notes[result.source]!;
      const k = made.get(result.source) ?? 0;
      made.set(result.source, k + 1);
      const start = Math.round(result.start);
      out.push({
        seed: `${source.seed}~${k}`,
        start,
        end: start + Math.max(1, Math.round(result.length)),
        pitch: source.pitch * 2 ** ((result.pitch - source.note) / 12),
        note: Math.round(result.pitch),
        velocity: result.velocity,
      });
    }
  }
  return out;
}
