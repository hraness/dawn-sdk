// SPDX-License-Identifier: MIT
/**
 * Audio input for the measures: stereo Float64 channels at a sample rate,
 * from a WAV file's bytes (PCM 16/24/32, float 32/64) or a render's
 * interleaved 16-bit PCM. Mono becomes two equal channels; channels past
 * the second are ignored, as the measures read L/R only.
 */

export type Stereo = Readonly<{
  sampleRate: number;
  left: Float64Array;
  right: Float64Array;
}>;

export class MeasureInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MeasureInputError";
  }
}

/** Interleaved stereo int16 (what a render returns) as Float64 channels. */
export function stereoFromPcm16(
  pcm: Int16Array,
  sampleRate: number,
  channels = 2,
): Stereo {
  const frames = Math.floor(pcm.length / channels);
  const left = new Float64Array(frames);
  const right = new Float64Array(frames);
  for (let i = 0; i < frames; i += 1) {
    left[i] = pcm[i * channels]! / 32768;
    right[i] = pcm[i * channels + (channels > 1 ? 1 : 0)]! / 32768;
  }
  return { sampleRate, left, right };
}

/** Decode a RIFF/RF64-less WAV (PCM or IEEE float) into stereo Float64. */
export function decodeWavStereo(bytes: Uint8Array): Stereo {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) =>
    String.fromCharCode(
      bytes[at]!,
      bytes[at + 1]!,
      bytes[at + 2]!,
      bytes[at + 3]!,
    );
  if (bytes.byteLength < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE")
    throw new MeasureInputError("not a RIFF/WAVE file");
  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let data: { start: number; size: number } | undefined;
  let at = 12;
  while (at + 8 <= bytes.byteLength) {
    const id = tag(at);
    const size = view.getUint32(at + 4, true);
    const start = at + 8;
    if (id === "fmt ") {
      if (size < 16) throw new MeasureInputError("short fmt chunk");
      format = view.getUint16(start, true);
      channels = view.getUint16(start + 2, true);
      sampleRate = view.getUint32(start + 4, true);
      bits = view.getUint16(start + 14, true);
      // WAVE_FORMAT_EXTENSIBLE: the real format is the GUID's first word.
      if (format === 0xfffe && size >= 26)
        format = view.getUint16(start + 24, true);
    } else if (id === "data") {
      data = {
        start,
        size: Math.min(size, bytes.byteLength - start),
      };
      break;
    }
    at = start + size + (size & 1);
  }
  if (!data || channels < 1 || sampleRate < 1)
    throw new MeasureInputError("WAV is missing fmt or data");
  const width = bits / 8;
  const frames = Math.floor(data.size / (width * channels));
  const read = sampleReader(view, format, bits);
  const left = new Float64Array(frames);
  const right = new Float64Array(frames);
  const step = width * channels;
  const second = channels > 1 ? width : 0;
  for (let i = 0, offset = data.start; i < frames; i += 1, offset += step) {
    left[i] = read(offset);
    right[i] = read(offset + second);
  }
  return { sampleRate, left, right };
}

function sampleReader(
  view: DataView,
  format: number,
  bits: number,
): (offset: number) => number {
  if (format === 1 && bits === 16) return (o) => view.getInt16(o, true) / 32768;
  if (format === 1 && bits === 24)
    return (o) => {
      const v =
        view.getUint8(o) |
        (view.getUint8(o + 1) << 8) |
        (view.getInt8(o + 2) << 16);
      return v / 8388608;
    };
  if (format === 1 && bits === 32)
    return (o) => view.getInt32(o, true) / 2147483648;
  if (format === 3 && bits === 32) return (o) => view.getFloat32(o, true);
  if (format === 3 && bits === 64) return (o) => view.getFloat64(o, true);
  throw new MeasureInputError(`unsupported WAV format ${format}/${bits}-bit`);
}

/** Read a WAV file from disk as stereo Float64. */
export async function readWavStereo(path: string): Promise<Stereo> {
  const { readFile } = await import("node:fs/promises");
  return decodeWavStereo(new Uint8Array(await readFile(path)));
}

/** Float32 stereo WAV bytes (stem taps keep their headroom and precision). */
export function encodeWavFloat32(
  stereo: Readonly<{
    sampleRate: number;
    left: Float64Array | Float32Array;
    right: Float64Array | Float32Array;
  }>,
): Uint8Array {
  const frames = stereo.left.length;
  const bytes = new Uint8Array(44 + frames * 8);
  const view = new DataView(bytes.buffer);
  const write = (at: number, text: string) => {
    for (let i = 0; i < 4; i += 1) bytes[at + i] = text.charCodeAt(i);
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + frames * 8, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, stereo.sampleRate, true);
  view.setUint32(28, stereo.sampleRate * 8, true);
  view.setUint16(32, 8, true);
  view.setUint16(34, 32, true);
  write(36, "data");
  view.setUint32(40, frames * 8, true);
  const out = new Float32Array(bytes.buffer, 44, frames * 2);
  // One loop for each sample type: a loop that sees both kinds of array
  // runs many times slower, and a song's stems are all 32-bit.
  if (
    stereo.left instanceof Float32Array &&
    stereo.right instanceof Float32Array
  )
    interleave32(stereo.left, stereo.right, out, frames);
  else interleave(stereo.left, stereo.right, out, frames);
  return bytes;
}

function interleave32(
  left: Float32Array,
  right: Float32Array,
  out: Float32Array,
  frames: number,
): void {
  for (let i = 0; i < frames; i += 1) {
    out[i * 2] = left[i]!;
    out[i * 2 + 1] = right[i]!;
  }
}

function interleave(
  left: Float64Array | Float32Array,
  right: Float64Array | Float32Array,
  out: Float32Array,
  frames: number,
): void {
  for (let i = 0; i < frames; i += 1) {
    out[i * 2] = left[i]!;
    out[i * 2 + 1] = right[i]!;
  }
}
