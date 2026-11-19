// SPDX-License-Identifier: MIT
/**
 * The deterministic CBOR subset a link's score bytes are written in
 * (RFC 8949, with one spelling for every value):
 *
 * - integers in the shortest head, floats only for numbers that are not
 *   integers, as 32 bits when that is exact and 64 otherwise;
 * - no negative zero, NaN or infinity;
 * - text as UTF-8 in NFC; byte strings; arrays; false, true and null;
 * - maps whose keys are unsigned integers (ascending) and then text
 *   (ascending by its UTF-8 bytes), each key once;
 * - no tags, no indefinite lengths, nothing after the value.
 *
 * The decoder refuses any other spelling of a value; it does not tidy it.
 * Sizes are bounded before anything is allocated.
 */

export type CborValue =
  | number
  | string
  | boolean
  | null
  | Uint8Array
  | readonly CborValue[]
  | CborMap;

/** A map in key order: unsigned integers first, then text. */
export type CborMap = ReadonlyMap<number | string, CborValue>;

export type CborLimits = Readonly<{
  /** Nesting of arrays and maps. */
  depth: number;
  /** Values in all, containers included. */
  nodes: number;
  /** UTF-8 bytes in one text or bytes in one byte string. */
  text: number;
}>;

export const CBOR_LIMITS: CborLimits = Object.freeze({
  depth: 24,
  nodes: 400_000,
  text: 16_384,
});

export type CborFault =
  /** The bytes are not this subset at all (cut short, a type it has not). */
  | "malformed"
  /** A value written in a spelling other than its one. */
  | "not_canonical"
  /** Past a bound. */
  | "too_large";

export class CborError extends Error {
  readonly fault: CborFault;
  constructor(fault: CborFault, message: string) {
    super(message);
    this.name = "CborError";
    this.fault = fault;
  }
}

const utf8 = new TextEncoder();
const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

/** No lone surrogate: every text here has exactly one UTF-8 spelling. */
function wellFormed(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit < 0xd800 || unit > 0xdfff) continue;
    if (unit > 0xdbff) return false;
    const next = text.charCodeAt(i + 1);
    if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    i += 1;
  }
  return true;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const d = a[i]! - b[i]!;
    if (d !== 0) return d;
  }
  return a.length - b.length;
}

class Writer {
  private buffer = new Uint8Array(1024);
  private view = new DataView(this.buffer.buffer);
  length = 0;

  private room(more: number) {
    if (this.length + more <= this.buffer.length) return;
    let size = this.buffer.length * 2;
    while (size < this.length + more) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buffer.subarray(0, this.length));
    this.buffer = next;
    this.view = new DataView(next.buffer);
  }

  byte(value: number) {
    this.room(1);
    this.buffer[this.length++] = value;
  }

  head(major: number, n: number) {
    const m = major << 5;
    if (n < 24) this.byte(m | n);
    else if (n < 0x100) {
      this.byte(m | 24);
      this.byte(n);
    } else if (n < 0x10000) {
      this.room(3);
      this.buffer[this.length++] = m | 25;
      this.view.setUint16(this.length, n);
      this.length += 2;
    } else if (n < 0x100000000) {
      this.room(5);
      this.buffer[this.length++] = m | 26;
      this.view.setUint32(this.length, n);
      this.length += 4;
    } else {
      this.room(9);
      this.buffer[this.length++] = m | 27;
      this.view.setBigUint64(this.length, BigInt(n));
      this.length += 8;
    }
  }

  float(value: number) {
    if (Math.fround(value) === value) {
      this.room(5);
      this.buffer[this.length++] = 0xfa;
      this.view.setFloat32(this.length, value);
      this.length += 4;
    } else {
      this.room(9);
      this.buffer[this.length++] = 0xfb;
      this.view.setFloat64(this.length, value);
      this.length += 8;
    }
  }

  bytes(value: Uint8Array) {
    this.room(value.length);
    this.buffer.set(value, this.length);
    this.length += value.length;
  }

  done(): Uint8Array {
    return this.buffer.slice(0, this.length);
  }
}

function writeValue(out: Writer, value: CborValue, depth: number): void {
  if (value === null) return out.byte(0xf6);
  if (value === false) return out.byte(0xf4);
  if (value === true) return out.byte(0xf5);
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new CborError("not_canonical", "a number must be finite");
    if (Object.is(value, -0))
      throw new CborError("not_canonical", "negative zero has no spelling");
    if (Number.isInteger(value)) {
      if (Math.abs(value) > MAX_SAFE)
        throw new CborError("too_large", "an integer past 2^53 - 1");
      return value >= 0 ? out.head(0, value) : out.head(1, -1 - value);
    }
    return out.float(value);
  }
  if (typeof value === "string") {
    if (value.normalize("NFC") !== value)
      throw new CborError("not_canonical", "text must be in NFC");
    if (!wellFormed(value))
      throw new CborError("not_canonical", "text has a lone surrogate");
    const bytes = utf8.encode(value);
    out.head(3, bytes.length);
    return out.bytes(bytes);
  }
  if (value instanceof Uint8Array) {
    out.head(2, value.length);
    return out.bytes(value);
  }
  if (depth <= 0) throw new CborError("too_large", "nested too deeply");
  if (Array.isArray(value)) {
    out.head(4, value.length);
    for (const item of value) writeValue(out, item, depth - 1);
    return;
  }
  const map = value as CborMap;
  const numbers: number[] = [];
  const texts: [Uint8Array, string][] = [];
  for (const key of map.keys()) {
    if (typeof key === "number") {
      if (!Number.isInteger(key) || key < 0 || key > MAX_SAFE)
        throw new CborError(
          "not_canonical",
          "a map key must be an unsigned integer or text",
        );
      numbers.push(key);
    } else {
      if (key.normalize("NFC") !== key || !wellFormed(key))
        throw new CborError("not_canonical", "a text key must be in NFC");
      texts.push([utf8.encode(key), key]);
    }
  }
  numbers.sort((a, b) => a - b);
  texts.sort((a, b) => compareBytes(a[0], b[0]));
  out.head(5, map.size);
  for (const key of numbers) {
    out.head(0, key);
    writeValue(out, map.get(key)!, depth - 1);
  }
  for (const [bytes, key] of texts) {
    out.head(3, bytes.length);
    out.bytes(bytes);
    writeValue(out, map.get(key)!, depth - 1);
  }
}

/** The one spelling of `value`. Throws a CborError for a value that has none. */
export function encodeCbor(
  value: CborValue,
  limits: CborLimits = CBOR_LIMITS,
): Uint8Array {
  const out = new Writer();
  writeValue(out, value, limits.depth);
  return out.done();
}

class Reader {
  readonly view: DataView;
  offset = 0;
  nodes = 0;
  constructor(
    readonly bytes: Uint8Array,
    readonly limits: CborLimits,
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  need(count: number) {
    if (this.offset + count > this.bytes.length)
      throw new CborError("malformed", "the bytes end inside a value");
  }

  /** A head's argument, refused unless it is the shortest that holds it. */
  argument(info: number): number {
    if (info < 24) return info;
    if (info === 24) {
      this.need(1);
      const n = this.bytes[this.offset++]!;
      if (n < 24)
        throw new CborError("not_canonical", "a head longer than needed");
      return n;
    }
    if (info === 25) {
      this.need(2);
      const n = this.view.getUint16(this.offset);
      this.offset += 2;
      if (n < 0x100)
        throw new CborError("not_canonical", "a head longer than needed");
      return n;
    }
    if (info === 26) {
      this.need(4);
      const n = this.view.getUint32(this.offset);
      this.offset += 4;
      if (n < 0x10000)
        throw new CborError("not_canonical", "a head longer than needed");
      return n;
    }
    if (info === 27) {
      this.need(8);
      const big = this.view.getBigUint64(this.offset);
      this.offset += 8;
      if (big < 0x100000000n)
        throw new CborError("not_canonical", "a head longer than needed");
      if (big > BigInt(MAX_SAFE))
        throw new CborError("too_large", "an integer past 2^53 - 1");
      return Number(big);
    }
    throw new CborError(
      "malformed",
      info === 31 ? "an indefinite length" : "a reserved head",
    );
  }

  text(length: number): string {
    if (length > this.limits.text)
      throw new CborError("too_large", "a text longer than the bound");
    this.need(length);
    let value: string;
    try {
      value = strict.decode(
        this.bytes.subarray(this.offset, this.offset + length),
      );
    } catch {
      throw new CborError("malformed", "text that is not UTF-8");
    }
    this.offset += length;
    if (value.normalize("NFC") !== value)
      throw new CborError("not_canonical", "text must be in NFC");
    return value;
  }

  value(depth: number): CborValue {
    this.nodes += 1;
    if (this.nodes > this.limits.nodes)
      throw new CborError("too_large", "more values than the bound");
    this.need(1);
    const first = this.bytes[this.offset++]!;
    const major = first >> 5;
    const info = first & 31;
    if (major === 7) {
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 22) return null;
      if (info === 26) {
        this.need(4);
        const n = this.view.getFloat32(this.offset);
        this.offset += 4;
        return this.float(n);
      }
      if (info === 27) {
        this.need(8);
        const n = this.view.getFloat64(this.offset);
        this.offset += 8;
        if (Math.fround(n) === n)
          throw new CborError("not_canonical", "a float wider than needed");
        return this.float(n);
      }
      throw new CborError("malformed", "a simple value this format has not");
    }
    if (major === 6) throw new CborError("malformed", "a tag");
    const n = this.argument(info);
    if (major === 0) return n;
    if (major === 1) {
      if (n >= MAX_SAFE)
        throw new CborError("too_large", "an integer past 2^53 - 1");
      return -1 - n;
    }
    if (major === 2) {
      if (n > this.limits.text)
        throw new CborError("too_large", "a byte string longer than the bound");
      this.need(n);
      const out = this.bytes.slice(this.offset, this.offset + n);
      this.offset += n;
      return out;
    }
    if (major === 3) return this.text(n);
    if (depth <= 0) throw new CborError("too_large", "nested too deeply");
    // Every item takes at least one byte, so a length the bytes cannot hold
    // is refused before the array for it is made.
    if (major === 4) {
      this.need(n);
      const out: CborValue[] = [];
      for (let i = 0; i < n; i += 1) out.push(this.value(depth - 1));
      return out;
    }
    this.need(n * 2);
    const map = new Map<number | string, CborValue>();
    let lastNumber = -1;
    let lastText: Uint8Array | undefined;
    for (let i = 0; i < n; i += 1) {
      this.nodes += 1;
      this.need(1);
      const head = this.bytes[this.offset++]!;
      const keyMajor = head >> 5;
      const length = this.argument(head & 31);
      if (keyMajor === 0) {
        if (lastText !== undefined || length <= lastNumber)
          throw new CborError("not_canonical", "map keys out of order");
        lastNumber = length;
        map.set(length, this.value(depth - 1));
      } else if (keyMajor === 3) {
        const start = this.offset;
        const key = this.text(length);
        const bytes = this.bytes.subarray(start, start + length);
        if (lastText !== undefined && compareBytes(lastText, bytes) >= 0)
          throw new CborError("not_canonical", "map keys out of order");
        lastText = bytes;
        map.set(key, this.value(depth - 1));
      } else
        throw new CborError(
          "malformed",
          "a map key that is neither an unsigned integer nor text",
        );
    }
    return map;
  }

  private float(n: number): number {
    if (!Number.isFinite(n))
      throw new CborError("not_canonical", "a number must be finite");
    if (Number.isInteger(n))
      throw new CborError("not_canonical", "an integer written as a float");
    return n;
  }
}

/** The value `bytes` spell. Throws a CborError; never anything else. */
export function decodeCbor(
  bytes: Uint8Array,
  limits: CborLimits = CBOR_LIMITS,
): CborValue {
  const reader = new Reader(bytes, limits);
  const value = reader.value(limits.depth);
  if (reader.offset !== bytes.length)
    throw new CborError("not_canonical", "bytes after the value");
  return value;
}
