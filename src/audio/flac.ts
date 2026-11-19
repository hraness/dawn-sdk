// SPDX-License-Identifier: MIT
/**
 * FLAC decoding in TypeScript, with no dependencies, so a lossless sample
 * renders exactly as the WAV it replaces: the integers decoded here are the
 * integers the WAV holds, scaled by the same power of two (`flacToFloat`).
 *
 * The whole format is read: every block size and sample rate code, 4 to 32
 * bits a sample, up to eight channels with left/side, side/right and
 * mid/side stereo, constant, verbatim, fixed and LPC subframes, wasted bits
 * and both Rice codings with escapes. Each frame's CRC-8 and CRC-16 are
 * checked, and the stream's MD5 when it names one, so a damaged file is an
 * error, never different audio. Metadata other than STREAMINFO is skipped.
 */
import { createHash } from "node:crypto";

export class FlacFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlacFormatError";
  }
}

export type FlacStreamInfo = Readonly<{
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** Total frames (samples per channel); 0 when the stream does not say. */
  frames: number;
  minBlockSize: number;
  maxBlockSize: number;
  /** Lowercase hex, or all zeros when the encoder left it out. */
  md5: string;
}>;

export type FlacPcm = Readonly<{
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  frames: number;
  /** One array of signed integers per channel. */
  samples: readonly Int32Array[];
}>;

export type FlacLimits = Readonly<{
  /** Refuse a stream longer than this many frames (checked before decoding). */
  maximumFrames?: number;
  maximumChannels?: number;
}>;

/** Whether the bytes start a FLAC stream. */
export function isFlac(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 4 &&
    bytes[0] === 0x66 &&
    bytes[1] === 0x4c &&
    bytes[2] === 0x61 &&
    bytes[3] === 0x43
  );
}

const CRC8 = new Uint8Array(256);
const CRC16 = new Uint16Array(256);
for (let i = 0; i < 256; i += 1) {
  let c8 = i;
  let c16 = i << 8;
  for (let bit = 0; bit < 8; bit += 1) {
    c8 = c8 & 0x80 ? ((c8 << 1) ^ 0x07) & 0xff : (c8 << 1) & 0xff;
    c16 = c16 & 0x8000 ? ((c16 << 1) ^ 0x8005) & 0xffff : (c16 << 1) & 0xffff;
  }
  CRC8[i] = c8;
  CRC16[i] = c16;
}

export function crc8(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0;
  for (let i = start; i < end; i += 1) crc = CRC8[crc ^ bytes[i]!]!;
  return crc;
}

export function crc16(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0;
  for (let i = start; i < end; i += 1)
    crc = ((crc << 8) & 0xffff) ^ CRC16[(crc >> 8) ^ bytes[i]!]!;
  return crc;
}

/** Big-endian bit reader over a byte array; every read is bounds-checked. */
class BitReader {
  /** Position in bits. */
  pos: number;
  private readonly end: number;
  constructor(
    private readonly bytes: Uint8Array,
    byteOffset: number,
  ) {
    this.pos = byteOffset * 8;
    this.end = bytes.byteLength * 8;
  }

  get byte(): number {
    return this.pos >>> 3;
  }

  private short(): never {
    throw new FlacFormatError("the FLAC stream ends early");
  }

  /** Unsigned read of 0..32 bits. */
  read(count: number): number {
    if (count === 0) return 0;
    if (this.pos + count > this.end) this.short();
    let value = 0;
    let need = count;
    while (need > 0) {
      const byte = this.bytes[this.pos >>> 3]!;
      const avail = 8 - (this.pos & 7);
      const take = avail < need ? avail : need;
      const bits = (byte >>> (avail - take)) & ((1 << take) - 1);
      value = value * (1 << take) + bits;
      need -= take;
      this.pos += take;
    }
    return value;
  }

  /** Two's-complement read of 1..33 bits. */
  signed(count: number): number {
    if (count === 0) return 0;
    if (count > 32) {
      const high = this.read(count - 32);
      const low = this.read(32);
      const value = high * 4294967296 + low;
      return value >= 2 ** (count - 1) ? value - 2 ** count : value;
    }
    const value = this.read(count);
    return value >= 2 ** (count - 1) ? value - 2 ** count : value;
  }

  /** Zeros before the next one bit, and the one. */
  unary(): number {
    let zeros = 0;
    for (;;) {
      if (this.pos >= this.end) this.short();
      const offset = this.pos & 7;
      const rest = (this.bytes[this.pos >>> 3]! << offset) & 0xff;
      if (rest === 0) {
        zeros += 8 - offset;
        this.pos += 8 - offset;
        continue;
      }
      const lead = Math.clz32(rest) - 24;
      zeros += lead;
      this.pos += lead + 1;
      return zeros;
    }
  }

  align(): void {
    this.pos = (this.pos + 7) & ~7;
  }
}

function readStreamInfo(bytes: Uint8Array): {
  info: FlacStreamInfo;
  audioStart: number;
} {
  if (!isFlac(bytes)) throw new FlacFormatError("not a FLAC stream");
  let at = 4;
  let info: FlacStreamInfo | undefined;
  for (let blocks = 0; ; blocks += 1) {
    if (blocks > 1024)
      throw new FlacFormatError("the FLAC stream has too many metadata blocks");
    if (at + 4 > bytes.byteLength)
      throw new FlacFormatError("the FLAC metadata ends early");
    const header = bytes[at]!;
    const last = (header & 0x80) !== 0;
    const type = header & 0x7f;
    const length =
      (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!;
    at += 4;
    if (at + length > bytes.byteLength)
      throw new FlacFormatError("the FLAC metadata ends early");
    if (type === 127) throw new FlacFormatError("invalid FLAC metadata block");
    if (blocks === 0 && type !== 0)
      throw new FlacFormatError(
        "the FLAC stream does not start with STREAMINFO",
      );
    if (type === 0) {
      if (blocks !== 0 || length !== 34)
        throw new FlacFormatError("malformed FLAC STREAMINFO");
      const r = new BitReader(bytes, at);
      const minBlockSize = r.read(16);
      const maxBlockSize = r.read(16);
      r.read(24);
      r.read(24);
      const sampleRate = r.read(20);
      const channels = r.read(3) + 1;
      const bitsPerSample = r.read(5) + 1;
      const frames = r.read(36);
      let md5 = "";
      for (let i = 0; i < 16; i += 1)
        md5 += bytes[at + 18 + i]!.toString(16).padStart(2, "0");
      if (sampleRate === 0)
        throw new FlacFormatError("the FLAC stream has no sample rate");
      if (bitsPerSample < 4)
        throw new FlacFormatError(
          `${bitsPerSample}-bit FLAC samples are unsupported`,
        );
      if (minBlockSize < 1 || maxBlockSize < minBlockSize)
        throw new FlacFormatError("malformed FLAC block sizes");
      info = Object.freeze({
        sampleRate,
        channels,
        bitsPerSample,
        frames,
        minBlockSize,
        maxBlockSize,
        md5,
      });
    }
    at += length;
    if (last) break;
  }
  return { info: info!, audioStart: at };
}

/** The stream's STREAMINFO, without decoding any audio. */
export function flacStreamInfo(bytes: Uint8Array): FlacStreamInfo {
  return readStreamInfo(bytes).info;
}

const BLOCK_SIZES = [
  0, 192, 576, 1152, 2304, 4608, -8, -16, 256, 512, 1024, 2048, 4096, 8192,
  16384, 32768,
];
const RATES = [
  0, 88_200, 176_400, 192_000, 8_000, 16_000, 22_050, 24_000, 32_000, 44_100,
  48_000, 96_000,
];
const SAMPLE_SIZES = [0, 8, 12, -1, 16, 20, 24, 32];
const FIXED: readonly (readonly number[])[] = [
  [],
  [1],
  [2, -1],
  [3, -3, 1],
  [4, -6, 4, -1],
];

function residual(
  r: BitReader,
  out: Float64Array,
  blockSize: number,
  order: number,
): void {
  const method = r.read(2);
  if (method > 1) throw new FlacFormatError("reserved FLAC residual coding");
  const paramBits = method === 0 ? 4 : 5;
  const escape = method === 0 ? 15 : 31;
  const partitionOrder = r.read(4);
  const partitions = 1 << partitionOrder;
  if (blockSize % partitions !== 0)
    throw new FlacFormatError("FLAC partitions do not divide the block");
  const each = blockSize / partitions;
  if (each < order) throw new FlacFormatError("FLAC partition is too short");
  let at = order;
  for (let p = 0; p < partitions; p += 1) {
    const count = p === 0 ? each - order : each;
    const k = r.read(paramBits);
    if (k === escape) {
      const bits = r.read(5);
      for (let i = 0; i < count; i += 1) out[at++] = r.signed(bits);
      continue;
    }
    const scale = 2 ** k;
    for (let i = 0; i < count; i += 1) {
      const u = r.unary() * scale + r.read(k);
      out[at++] = u % 2 === 0 ? u / 2 : -(u + 1) / 2;
    }
  }
}

function subframe(
  r: BitReader,
  out: Float64Array,
  blockSize: number,
  sampleBits: number,
): void {
  if (r.read(1) !== 0)
    throw new FlacFormatError("FLAC subframe padding is set");
  const type = r.read(6);
  let wasted = 0;
  if (r.read(1) === 1) wasted = r.unary() + 1;
  const bits = sampleBits - wasted;
  if (bits < 1) throw new FlacFormatError("FLAC wasted bits exceed the sample");
  if (type === 0) {
    const value = r.signed(bits);
    out.fill(value, 0, blockSize);
  } else if (type === 1) {
    for (let i = 0; i < blockSize; i += 1) out[i] = r.signed(bits);
  } else if (type >= 8 && type <= 12) {
    const order = type - 8;
    if (order > blockSize)
      throw new FlacFormatError("FLAC order exceeds block");
    for (let i = 0; i < order; i += 1) out[i] = r.signed(bits);
    residual(r, out, blockSize, order);
    const coefs = FIXED[order]!;
    for (let i = order; i < blockSize; i += 1) {
      let sum = 0;
      for (let j = 0; j < order; j += 1) sum += coefs[j]! * out[i - j - 1]!;
      out[i] = out[i]! + sum;
    }
  } else if (type >= 32) {
    const order = type - 31;
    if (order > blockSize)
      throw new FlacFormatError("FLAC order exceeds block");
    for (let i = 0; i < order; i += 1) out[i] = r.signed(bits);
    const precision = r.read(4) + 1;
    if (precision === 16)
      throw new FlacFormatError("invalid FLAC LPC precision");
    const shift = r.signed(5);
    if (shift < 0) throw new FlacFormatError("negative FLAC LPC shift");
    const coefs = new Float64Array(order);
    for (let j = 0; j < order; j += 1) coefs[j] = r.signed(precision);
    residual(r, out, blockSize, order);
    const divisor = 2 ** shift;
    for (let i = order; i < blockSize; i += 1) {
      let sum = 0;
      for (let j = 0; j < order; j += 1) sum += coefs[j]! * out[i - j - 1]!;
      if (!Number.isSafeInteger(sum))
        throw new FlacFormatError("FLAC LPC prediction overflows");
      out[i] = out[i]! + Math.floor(sum / divisor);
    }
  } else throw new FlacFormatError("reserved FLAC subframe type");
  if (wasted > 0) {
    const scale = 2 ** wasted;
    for (let i = 0; i < blockSize; i += 1) out[i] = out[i]! * scale;
  }
}

/** The UTF-8-style coded frame or sample number. */
function codedNumber(r: BitReader): number {
  const first = r.read(8);
  if (first < 0x80) return first;
  let extra = 0;
  let mask = 0x40;
  while (first & mask) {
    extra += 1;
    mask >>= 1;
  }
  if (extra < 1 || extra > 6)
    throw new FlacFormatError("bad FLAC frame number");
  let value = first & (mask - 1);
  for (let i = 0; i < extra; i += 1) {
    const next = r.read(8);
    if ((next & 0xc0) !== 0x80)
      throw new FlacFormatError("bad FLAC frame number");
    value = value * 64 + (next & 0x3f);
  }
  return value;
}

/**
 * Decode a whole FLAC stream to signed integers per channel. Throws
 * `FlacFormatError` for anything malformed, a failed CRC or MD5, or a stream
 * over the limits.
 */
export function decodeFlac(
  bytes: Uint8Array,
  limits: FlacLimits = {},
): FlacPcm {
  const { info, audioStart } = readStreamInfo(bytes);
  const { sampleRate, channels, bitsPerSample } = info;
  const maximumFrames = limits.maximumFrames ?? Number.MAX_SAFE_INTEGER;
  if (channels > (limits.maximumChannels ?? 8))
    throw new FlacFormatError(`${channels} channels is unsupported`);
  if (info.frames > maximumFrames)
    throw new FlacFormatError("the FLAC stream is too long");
  let capacity = info.frames > 0 ? info.frames : info.maxBlockSize * 16;
  let samples = Array.from(
    { length: channels },
    () => new Int32Array(capacity),
  );
  const work = Array.from(
    { length: Math.min(channels, 2) },
    () => new Float64Array(info.maxBlockSize),
  );
  const scratch = Array.from(
    { length: channels },
    () => new Float64Array(info.maxBlockSize),
  );
  let frames = 0;
  const r = new BitReader(bytes, audioStart);
  while (r.byte < bytes.byteLength) {
    if (info.frames > 0 && frames === info.frames) break;
    const start = r.byte;
    if (r.read(15) !== 0x7ffc)
      throw new FlacFormatError("lost FLAC frame sync");
    r.read(1); // blocking strategy: the frame/sample number is not needed
    const sizeCode = r.read(4);
    const rateCode = r.read(4);
    const assignment = r.read(4);
    const sizeBitsCode = r.read(3);
    if (r.read(1) !== 0) throw new FlacFormatError("reserved FLAC header bit");
    codedNumber(r);
    let blockSize = BLOCK_SIZES[sizeCode]!;
    if (blockSize === 0) throw new FlacFormatError("reserved FLAC block size");
    if (blockSize < 0) blockSize = r.read(-blockSize) + 1;
    let rate = RATES[rateCode];
    if (rateCode === 12) rate = r.read(8) * 1000;
    else if (rateCode === 13) rate = r.read(16);
    else if (rateCode === 14) rate = r.read(16) * 10;
    else if (rateCode === 15)
      throw new FlacFormatError("invalid FLAC sample rate");
    if (rate !== 0 && rate !== sampleRate)
      throw new FlacFormatError("the FLAC sample rate changes mid-stream");
    const sizeBits = SAMPLE_SIZES[sizeBitsCode]!;
    if (sizeBits < 0) throw new FlacFormatError("reserved FLAC sample size");
    if (sizeBits !== 0 && sizeBits !== bitsPerSample)
      throw new FlacFormatError("the FLAC sample size changes mid-stream");
    const frameChannels = assignment < 8 ? assignment + 1 : 2;
    if (assignment > 10)
      throw new FlacFormatError("reserved FLAC channel layout");
    if (frameChannels !== channels)
      throw new FlacFormatError("the FLAC channel count changes mid-stream");
    if (blockSize > info.maxBlockSize)
      throw new FlacFormatError(
        "a FLAC block is larger than STREAMINFO allows",
      );
    const headerEnd = r.byte;
    if (r.read(8) !== crc8(bytes, start, headerEnd))
      throw new FlacFormatError("a FLAC frame header fails its CRC");
    for (let c = 0; c < channels; c += 1) {
      const side =
        (assignment === 8 && c === 1) ||
        (assignment === 9 && c === 0) ||
        (assignment === 10 && c === 1);
      subframe(r, scratch[c]!, blockSize, bitsPerSample + (side ? 1 : 0));
    }
    r.align();
    const crcAt = r.byte;
    if (r.read(16) !== crc16(bytes, start, crcAt))
      throw new FlacFormatError("a FLAC frame fails its CRC");
    if (frames + blockSize > maximumFrames)
      throw new FlacFormatError("the FLAC stream is too long");
    if (frames + blockSize > capacity) {
      if (info.frames > 0)
        throw new FlacFormatError("the FLAC stream is longer than it says");
      capacity = Math.max(capacity * 2, frames + blockSize);
      samples = samples.map((old) => {
        const grown = new Int32Array(capacity);
        grown.set(old);
        return grown;
      });
    }
    if (assignment >= 8) {
      const [a, b] = scratch as [Float64Array, Float64Array];
      const [left, right] = work as [Float64Array, Float64Array];
      for (let i = 0; i < blockSize; i += 1) {
        const x = a[i]!;
        const y = b[i]!;
        if (assignment === 8) {
          left[i] = x;
          right[i] = x - y;
        } else if (assignment === 9) {
          left[i] = x + y;
          right[i] = y;
        } else {
          // Mid/side: mid lost its low bit, which the side's low bit restores.
          const mid = x * 2 + (y % 2 === 0 ? 0 : 1);
          left[i] = (mid + y) / 2;
          right[i] = (mid - y) / 2;
        }
      }
      samples[0]!.set(left.subarray(0, blockSize), frames);
      samples[1]!.set(right.subarray(0, blockSize), frames);
    } else
      for (let c = 0; c < channels; c += 1)
        samples[c]!.set(scratch[c]!.subarray(0, blockSize), frames);
    frames += blockSize;
  }
  if (info.frames > 0 && frames !== info.frames)
    throw new FlacFormatError("the FLAC stream ends early");
  const out = samples.map((channel) => channel.subarray(0, frames));
  if (/[^0]/.test(info.md5) && flacMd5(out, bitsPerSample) !== info.md5)
    throw new FlacFormatError("the FLAC audio fails its MD5 check");
  return Object.freeze({
    sampleRate,
    channels,
    bitsPerSample,
    frames,
    samples: Object.freeze(out),
  });
}

/** MD5 of interleaved little-endian samples, as STREAMINFO records it. */
export function flacMd5(
  samples: readonly Int32Array[],
  bitsPerSample: number,
): string {
  const width = Math.ceil(bitsPerSample / 8);
  const frames = samples[0]?.length ?? 0;
  const hash = createHash("md5");
  const chunkFrames = 65_536;
  const buffer = new Uint8Array(chunkFrames * samples.length * width);
  for (let from = 0; from < frames; from += chunkFrames) {
    const to = Math.min(frames, from + chunkFrames);
    let at = 0;
    for (let i = from; i < to; i += 1)
      for (const channel of samples) {
        let value = channel[i]!;
        for (let b = 0; b < width; b += 1) {
          buffer[at++] = value & 0xff;
          value >>= 8;
        }
      }
    hash.update(buffer.subarray(0, at));
  }
  return hash.digest("hex");
}

/**
 * Interleaved floats, each integer divided by 2^(bits - 1): the scaling the
 * WAV parser uses, so a FLAC and the PCM WAV it was made from give the same
 * floats.
 */
export function flacToFloat(pcm: FlacPcm): Float32Array {
  const { channels, frames } = pcm;
  const data = new Float32Array(frames * channels);
  const scale = 2 ** (pcm.bitsPerSample - 1);
  for (let c = 0; c < channels; c += 1) {
    const channel = pcm.samples[c]!;
    for (let i = 0; i < frames; i += 1)
      data[i * channels + c] = channel[i]! / scale;
  }
  return data;
}

/**
 * The canonical 44-byte-header PCM WAV of a 8/16/24/32-bit FLAC: what a WAV
 * converted to FLAC is again, byte for byte, when it had no other chunks.
 */
export function flacToWav(pcm: FlacPcm): Uint8Array {
  const bits = pcm.bitsPerSample;
  if (bits !== 8 && bits !== 16 && bits !== 24 && bits !== 32)
    throw new FlacFormatError(`${bits}-bit audio has no canonical WAV form`);
  const width = bits / 8;
  const dataBytes = pcm.frames * pcm.channels * width;
  if (44 + dataBytes > 0xffffffff)
    throw new FlacFormatError("the audio is too long for a WAV");
  const out = new Uint8Array(44 + dataBytes);
  const view = new DataView(out.buffer);
  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) out[at + i] = text.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, pcm.channels, true);
  view.setUint32(24, pcm.sampleRate, true);
  view.setUint32(28, pcm.sampleRate * pcm.channels * width, true);
  view.setUint16(32, pcm.channels * width, true);
  view.setUint16(34, bits, true);
  ascii(36, "data");
  view.setUint32(40, dataBytes, true);
  let at = 44;
  for (let i = 0; i < pcm.frames; i += 1)
    for (const channel of pcm.samples) {
      // 8-bit WAV is unsigned; wider is signed little-endian.
      let value = bits === 8 ? channel[i]! + 128 : channel[i]!;
      for (let b = 0; b < width; b += 1) {
        out[at++] = value & 0xff;
        value >>= 8;
      }
    }
  return out;
}
