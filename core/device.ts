/**
 * Programmable devices (`dawn.device/v1`): WebAssembly modules with no
 * imports that a patch node runs as an effect, a synthesizer or a note
 * transform. A device can compute, and nothing else: it has no host
 * functions, no WASI, no clock, no randomness, no files and no network.
 *
 * Every module is checked before it is compiled (no imports, no start
 * function, one bounded memory, a closed instruction set) and then
 * rewritten so that it is deterministic and bounded by construction:
 *
 * - **Fuel.** Each function entry and loop iteration subtracts its static
 *   instruction count from an exported counter, and bulk memory operations
 *   subtract their length. A call that runs out traps, so the budget is a
 *   count of work, the same on every host, not a wall-clock timer.
 * - **Depth.** Each call adds its frame weight to a depth counter, so
 *   recursion stops at the same depth everywhere instead of at whatever
 *   the host's native stack allows.
 * - **NaN.** Every float operation whose NaN result the WebAssembly spec
 *   leaves non-deterministic (arithmetic, rounding, min, max, promote and
 *   demote) is followed by a select that replaces any NaN with the
 *   canonical quiet NaN, so x86 and ARM produce the same bits.
 *
 * This file imports nothing and runs no I/O: the host reads the bytes,
 * computes the content hash and hands both in. See docs/devices.md.
 */

export const DEVICE_ABI = "dawn.device/v1";
/** Frames per `process` / `render` call; the host pads the last block. */
export const DEVICE_BLOCK = 128;
/** Control values the host writes before every call (`p1`..`p8`). */
export const DEVICE_PARAMS = 8;
export const DEVICE_KINDS = ["fx", "synth", "notes"] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];
/** `sha256:` and 64 lowercase hex digits of the module's bytes. */
export const DEVICE_HASH = /^sha256:[0-9a-f]{64}$/;

export const DEVICE_LIMITS = Object.freeze({
  /** Module size in bytes. */
  maxBytes: 1024 * 1024,
  /** Declared memory maximum, in 64 KiB pages (16 MiB). */
  maxPages: 256,
  maxTypes: 4096,
  maxFunctions: 8192,
  maxGlobals: 1024,
  maxExports: 1024,
  maxTables: 1,
  maxTableSize: 65_536,
  /** Parameters plus declared locals of one function. */
  maxLocals: 4096,
  /** Nested blocks in one function. */
  maxNesting: 1024,
  /** Summed frame weights of active calls (a weight is 1 per 8 locals, at least 1). */
  maxDepth: 4096,
  /** Instruction budget of `init`. */
  initFuel: 1 << 26,
  /** Instruction budget of one `process` or `render` call (128 frames). */
  blockFuel: 1 << 22,
  /** Instruction budget of one `transform` call. */
  notesFuel: 1 << 24,
  /** Note events in one synth block; later events wait for the next block. */
  maxEvents: 64,
  /** Notes passed to one `transform` call. */
  maxNotesIn: 256,
  /** Notes one `transform` call may return. */
  maxNotesOut: 1024,
  /** Notes a transform may return over a whole render. */
  maxNotesTotal: 65_536,
  /** Output samples are clamped to ±this (+24 dBFS). */
  maxSample: 16,
});

/**
 * Byte offsets in a device's I/O region (the pointer `init` returns, 8-byte
 * aligned). Audio devices (fx, synth) use the first layout; note devices the
 * second. All samples are little-endian f64.
 */
export const DEVICE_IO = Object.freeze({
  params: 0,
  inLeft: 64,
  inRight: 64 + 8 * DEVICE_BLOCK,
  outLeft: 64 + 16 * DEVICE_BLOCK,
  outRight: 64 + 24 * DEVICE_BLOCK,
  /** i32 event count, then 4 bytes of padding. */
  eventCount: 64 + 32 * DEVICE_BLOCK,
  events: 72 + 32 * DEVICE_BLOCK,
  /** frame i32, type i32 (1 on, 0 off), voice i32, note i32, velocity f64, hz f64. */
  eventBytes: 32,
  audioBytes: 72 + 32 * DEVICE_BLOCK + 32 * 64,
  notesIn: 64,
  notesOut: 64 + 40 * 256,
  /** start f64, length f64 (frames), pitch f64 (MIDI), velocity f64, source i32, reserved i32. */
  noteBytes: 40,
  notesBytes: 64 + 40 * 256 + 40 * 1024,
});

export class DeviceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceValidationError";
  }
}

export class DeviceRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceRuntimeError";
  }
}

const fail = (message: string): never => {
  throw new DeviceValidationError(message);
};

// ------------------------------------------------------------ reading

class Reader {
  constructor(
    readonly bytes: Uint8Array,
    public pos: number,
    readonly end: number,
  ) {}
  get done(): boolean {
    return this.pos >= this.end;
  }
  byte(): number {
    if (this.pos >= this.end) fail("module ends inside a section");
    return this.bytes[this.pos++]!;
  }
  u32(): number {
    let result = 0;
    let shift = 0;
    for (let i = 0; i < 5; i += 1) {
      const b = this.byte();
      result += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) {
        if (result > 0xffffffff) fail("integer out of range");
        return result;
      }
      shift += 7;
    }
    return fail("integer is too long");
  }
  /** Skips a signed LEB of at most `max` bytes. */
  sleb(max: number): void {
    for (let i = 0; i < max; i += 1) if ((this.byte() & 0x80) === 0) return;
    fail("integer is too long");
  }
  /** A signed 33-bit block type index (non-negative), or a type byte. */
  skip(n: number): void {
    if (this.pos + n > this.end) fail("module ends inside a section");
    this.pos += n;
  }
  name(): string {
    const length = this.u32();
    if (length > 1024) fail("name is too long");
    const start = this.pos;
    this.skip(length);
    let text = "";
    for (let i = start; i < start + length; i += 1) {
      const b = this.bytes[i]!;
      if (b < 0x20 || b > 0x7e) return `\u0000${length}`;
      text += String.fromCharCode(b);
    }
    return text;
  }
}

class Writer {
  private buf: Uint8Array<ArrayBuffer> = new Uint8Array(1024);
  length = 0;
  private grow(n: number): void {
    if (this.length + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.length + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
  }
  byte(...values: number[]): this {
    this.grow(values.length);
    for (const v of values) this.buf[this.length++] = v;
    return this;
  }
  u32(value: number): this {
    do {
      let b = value & 0x7f;
      value = Math.floor(value / 128);
      if (value !== 0) b |= 0x80;
      this.byte(b);
    } while (value !== 0);
    return this;
  }
  /** Signed LEB of a safe integer. */
  sleb(value: number): this {
    for (;;) {
      const b = ((value % 128) + 128) % 128;
      value = Math.floor(value / 128);
      const done =
        (value === 0 && (b & 0x40) === 0) || (value === -1 && (b & 0x40) !== 0);
      this.byte(done ? b : b | 0x80);
      if (done) return this;
    }
  }
  bytes(data: Uint8Array): this {
    this.grow(data.length);
    this.buf.set(data, this.length);
    this.length += data.length;
    return this;
  }
  section(id: number, body: Writer): this {
    this.byte(id).u32(body.length);
    return this.bytes(body.result());
  }
  result(): Uint8Array<ArrayBuffer> {
    return this.buf.subarray(0, this.length);
  }
}

// ------------------------------------------------------------ module

const VALTYPES: ReadonlySet<number> = new Set([
  0x7f, 0x7e, 0x7d, 0x7c, 0x70, 0x6f,
]);
type FuncType = Readonly<{
  params: readonly number[];
  results: readonly number[];
}>;
type Export = Readonly<{ name: string; kind: number; index: number }>;
type Section = Readonly<{ id: number; start: number; end: number }>;

/** Spec order of the non-custom sections (data count sits before code). */
const ORDER: Readonly<Record<number, number>> = {
  1: 1,
  2: 2,
  3: 3,
  4: 4,
  5: 5,
  6: 6,
  7: 7,
  8: 8,
  9: 9,
  12: 10,
  10: 11,
  11: 12,
};

function valtype(r: Reader, label: string): number {
  const t = r.byte();
  if (!VALTYPES.has(t))
    fail(
      t === 0x7b
        ? `${label}: SIMD values (v128) are not allowed`
        : `${label}: unsupported value type 0x${t.toString(16)}`,
    );
  return t;
}

function limits(r: Reader, label: string): { min: number; max?: number } {
  const flag = r.byte();
  if (flag & 0x02) fail(`${label}: shared memory is not allowed`);
  if (flag & 0x04) fail(`${label}: 64-bit memories and tables are not allowed`);
  if (flag > 1) fail(`${label}: unsupported limits`);
  const min = r.u32();
  return flag === 1 ? { min, max: r.u32() } : { min };
}

type Parsed = {
  types: FuncType[];
  funcs: number[];
  globals: number;
  exports: Export[];
  sections: Section[];
  code?: Section;
  memory?: { min: number; max: number };
};

function parse(bytes: Uint8Array): Parsed {
  const head = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  if (bytes.length < 8 || head.some((b, i) => bytes[i] !== b))
    fail("not a WebAssembly module (version 1)");
  const out: Parsed = {
    types: [],
    funcs: [],
    globals: 0,
    exports: [],
    sections: [],
  };
  const top = new Reader(bytes, 8, bytes.length);
  let last = 0;
  while (!top.done) {
    const id = top.byte();
    const size = top.u32();
    const start = top.pos;
    top.skip(size);
    const end = top.pos;
    if (id === 0) continue; // custom sections are dropped
    const order = ORDER[id];
    if (order === undefined)
      fail(
        id === 13
          ? "exception handling (tag section) is not allowed"
          : `unknown section ${id}`,
      );
    if (order! <= last) fail(`section ${id} is out of order`);
    last = order!;
    const r = new Reader(bytes, start, end);
    out.sections.push({ id, start, end });
    if (id === 1) {
      const n = r.u32();
      if (n > DEVICE_LIMITS.maxTypes) fail("too many types");
      for (let i = 0; i < n; i += 1) {
        if (r.byte() !== 0x60) fail("only function types are allowed");
        const params = Array.from({ length: r.u32() }, () =>
          valtype(r, "type"),
        );
        const results = Array.from({ length: r.u32() }, () =>
          valtype(r, "type"),
        );
        out.types.push({ params, results });
      }
    } else if (id === 2) {
      if (r.u32() !== 0)
        fail(
          "a device may not import anything (no host functions, WASI, memory, tables or globals)",
        );
    } else if (id === 3) {
      const n = r.u32();
      if (n > DEVICE_LIMITS.maxFunctions) fail("too many functions");
      for (let i = 0; i < n; i += 1) {
        const t = r.u32();
        if (t >= out.types.length) fail("function names a missing type");
        out.funcs.push(t);
      }
    } else if (id === 4) {
      const n = r.u32();
      if (n > DEVICE_LIMITS.maxTables)
        fail(`at most ${DEVICE_LIMITS.maxTables} table`);
      for (let i = 0; i < n; i += 1) {
        const t = r.byte();
        if (t !== 0x70 && t !== 0x6f)
          fail("tables must hold funcref or externref");
        const l = limits(r, "table");
        if (l.min > DEVICE_LIMITS.maxTableSize) fail("table is too large");
      }
    } else if (id === 5) {
      const n = r.u32();
      if (n !== 1) fail("a device defines exactly one memory");
      const l = limits(r, "memory");
      if (l.max === undefined)
        fail(
          `memory needs a maximum (at most ${DEVICE_LIMITS.maxPages} pages)`,
        );
      if (l.max! > DEVICE_LIMITS.maxPages)
        fail(
          `memory maximum ${l.max} pages exceeds ${DEVICE_LIMITS.maxPages} (16 MiB)`,
        );
      if (l.min > l.max!) fail("memory minimum exceeds its maximum");
      out.memory = { min: l.min, max: l.max! };
    } else if (id === 6) {
      out.globals = r.u32();
      if (out.globals > DEVICE_LIMITS.maxGlobals) fail("too many globals");
    } else if (id === 7) {
      const n = r.u32();
      if (n > DEVICE_LIMITS.maxExports) fail("too many exports");
      for (let i = 0; i < n; i += 1) {
        const name = r.name();
        const kind = r.byte();
        const index = r.u32();
        if (name.startsWith("__dawn"))
          fail(`export ${name} uses a reserved name`);
        out.exports.push({ name, kind, index });
      }
    } else if (id === 8) {
      fail("a device may not have a start function; do setup in init");
    } else if (id === 10) {
      out.code = { id, start, end };
    }
  }
  return out;
}

// ------------------------------------------------------------ instructions

/** Float ops whose NaN result is non-deterministic: f32 (ceil..max, demote), f64 (ceil..max, promote). */
function canonicalAfter(op: number): 0 | 32 | 64 {
  if ((op >= 0x8d && op <= 0x97) || op === 0xb6) return 32;
  if ((op >= 0x9b && op <= 0xa5) || op === 0xbb) return 64;
  return 0;
}

type Instr = { op: number; sub: number; start: number; end: number };

/** Decodes one instruction at `r.pos`, rejecting everything outside the allowed set. */
function decode(r: Reader, at: string): Instr {
  const start = r.pos;
  const op = r.byte();
  let sub = -1;
  const memarg = () => {
    const align = r.u32();
    if (align & 0x40) fail(`${at}: multiple memories are not allowed`);
    r.u32();
  };
  const zero = () => {
    if (r.byte() !== 0) fail(`${at}: multiple memories are not allowed`);
  };
  const blocktype = () => {
    const b = r.bytes[r.pos];
    if (b === 0x40 || (b !== undefined && VALTYPES.has(b))) r.pos += 1;
    else if (b === 0x7b) fail(`${at}: SIMD values (v128) are not allowed`);
    else r.sleb(5);
  };
  if (op === 0x02 || op === 0x03 || op === 0x04) blocktype();
  else if (
    op === 0x0c ||
    op === 0x0d ||
    (op >= 0x20 && op <= 0x24) ||
    op === 0x10 ||
    op === 0x25 ||
    op === 0x26 ||
    op === 0xd2
  )
    r.u32();
  else if (op === 0x0e) {
    const n = r.u32();
    if (n > 65_536) fail(`${at}: br_table is too long`);
    for (let i = 0; i <= n; i += 1) r.u32();
  } else if (op === 0x11) {
    r.u32();
    r.u32();
  } else if (op === 0x1c) {
    const n = r.u32();
    if (n !== 1) fail(`${at}: typed select takes one type`);
    valtype(r, at);
  } else if (op >= 0x28 && op <= 0x3e) memarg();
  else if (op === 0x3f || op === 0x40) zero();
  else if (op === 0x41) r.sleb(5);
  else if (op === 0x42) r.sleb(10);
  else if (op === 0x43) r.skip(4);
  else if (op === 0x44) r.skip(8);
  else if (op === 0xd0) {
    const t = r.byte();
    if (t !== 0x70 && t !== 0x6f) fail(`${at}: unsupported reference type`);
  } else if (op === 0xfc) {
    sub = r.u32();
    if (sub <= 7) {
      // saturating float-to-int: no immediates
    } else if (sub === 8) {
      r.u32();
      zero();
    } else if (sub === 9) r.u32();
    else if (sub === 10) {
      zero();
      zero();
    } else if (sub === 11) zero();
    else fail(`${at}: table bulk operations (0xfc ${sub}) are not allowed`);
  } else if (op === 0xfd)
    fail(
      `${at}: SIMD is not allowed (non-deterministic NaN and relaxed operations)`,
    );
  else if (op === 0xfe) fail(`${at}: threads and atomics are not allowed`);
  else if (op === 0x12 || op === 0x13)
    fail(`${at}: tail calls are not allowed`);
  else if (!(
    op === 0x00 ||
    op === 0x01 ||
    op === 0x05 ||
    op === 0x0b ||
    op === 0x0f ||
    op === 0x1a ||
    op === 0x1b ||
    (op >= 0x45 && op <= 0xc4) ||
    op === 0xd1
  ))
    fail(`${at}: instruction 0x${op.toString(16)} is not allowed`);
  return { op, sub, start, end: r.pos };
}

// ------------------------------------------------------------ rewriting

type Rewrite = { fuel: number; depth: number; blockTypes: Map<string, number> };

function charge(w: Writer, fuel: number, amount: number): void {
  // fuel -= amount; if (fuel < 0) unreachable
  w.byte(0x23).u32(fuel).byte(0x42).sleb(amount).byte(0x7d, 0x24).u32(fuel);
  check(w, fuel);
}

function check(w: Writer, fuel: number): void {
  w.byte(0x23).u32(fuel).byte(0x42, 0x00, 0x53, 0x04, 0x40, 0x00, 0x0b);
}

function rewriteBody(
  bytes: Uint8Array,
  start: number,
  end: number,
  type: FuncType,
  index: number,
  rw: Rewrite,
): Uint8Array {
  const at = `function ${index}`;
  const r = new Reader(bytes, start, end);
  const groups = r.u32();
  let locals = type.params.length;
  const decls = new Writer();
  for (let i = 0; i < groups; i += 1) {
    const n = r.u32();
    locals += n;
    if (locals > DEVICE_LIMITS.maxLocals)
      fail(`${at}: more than ${DEVICE_LIMITS.maxLocals} locals`);
    decls.u32(n).byte(valtype(r, at));
  }
  const f32 = locals;
  const f64 = locals + 1;
  const i32 = locals + 2;
  const weight = 1 + Math.floor(locals / 8);
  const exprStart = r.pos;

  // Pass 1: static instruction counts of the function and of each loop.
  const costs: number[] = [];
  let fnCost = 0;
  // Per open block, the cost index of its innermost enclosing loop (-1: none).
  const stack: number[] = [];
  for (;;) {
    const ins = decode(r, at);
    const loop = stack.length > 0 ? stack[stack.length - 1]! : -1;
    if (loop < 0) fnCost += 1;
    else costs[loop]! += 1;
    if (ins.op === 0x02 || ins.op === 0x04) stack.push(loop);
    else if (ins.op === 0x03) {
      stack.push(costs.length);
      costs.push(0);
    } else if (ins.op === 0x0b) {
      if (stack.length === 0) break;
      stack.pop();
    }
    if (stack.length > DEVICE_LIMITS.maxNesting)
      fail(`${at}: blocks nest too deeply`);
  }
  if (r.pos !== end) fail(`${at}: code after the function's end`);

  // Pass 2: emit.
  const w = new Writer();
  w.u32(groups + 3).bytes(decls.result());
  w.byte(1, 0x7d, 1, 0x7c, 1, 0x7f);
  // depth += weight; if (depth > max) unreachable
  w.byte(0x23)
    .u32(rw.depth)
    .byte(0x41)
    .sleb(weight)
    .byte(0x6a, 0x24)
    .u32(rw.depth);
  w.byte(0x23).u32(rw.depth).byte(0x41).sleb(DEVICE_LIMITS.maxDepth);
  w.byte(0x4b, 0x04, 0x40, 0x00, 0x0b);
  charge(w, rw.fuel, fnCost);
  // A block around the body: `return` becomes a branch to it, so the depth
  // is restored on every way out of the function.
  w.byte(0x02);
  if (type.results.length === 0) w.byte(0x40);
  else if (type.results.length === 1) w.byte(type.results[0]!);
  else w.sleb(rw.blockTypes.get(type.results.join(","))!);
  const q = new Reader(bytes, exprStart, end);
  let nesting = 0;
  let loopIndex = 0;
  for (;;) {
    const ins = decode(q, at);
    const op = ins.op;
    if (op === 0x0f) {
      w.byte(0x0c).u32(nesting);
      continue;
    }
    if (op === 0xfc && (ins.sub === 8 || ins.sub === 10 || ins.sub === 11)) {
      // The length is on top of the stack: charge one unit per 16 bytes.
      w.byte(0x22).u32(i32);
      w.byte(0x23)
        .u32(rw.fuel)
        .byte(0x20)
        .u32(i32)
        .byte(0xad, 0x42, 0x04, 0x88, 0x7d, 0x24)
        .u32(rw.fuel);
      check(w, rw.fuel);
    }
    w.bytes(bytes.subarray(ins.start, ins.end));
    if (op === 0x02 || op === 0x04) nesting += 1;
    else if (op === 0x03) {
      nesting += 1;
      charge(w, rw.fuel, costs[loopIndex++]!);
    } else if (op === 0x0b) {
      if (nesting === 0) break;
      nesting -= 1;
    }
    const canon = canonicalAfter(op);
    if (canon === 32)
      // x → x == x ? x : canonical NaN
      w.byte(0x22)
        .u32(f32)
        .byte(0x43, 0x00, 0x00, 0xc0, 0x7f, 0x20)
        .u32(f32)
        .byte(0x20)
        .u32(f32)
        .byte(0x5b, 0x1b);
    else if (canon === 64)
      w.byte(0x22)
        .u32(f64)
        .byte(0x44, 0, 0, 0, 0, 0, 0, 0xf8, 0x7f, 0x20)
        .u32(f64)
        .byte(0x20)
        .u32(f64)
        .byte(0x61, 0x1b);
  }
  // depth -= weight
  w.byte(0x23)
    .u32(rw.depth)
    .byte(0x41)
    .sleb(weight)
    .byte(0x6b, 0x24)
    .u32(rw.depth);
  w.byte(0x0b);
  return w.result();
}

// ------------------------------------------------------------ validation

const SIGNATURES: Readonly<Record<string, string>> = {
  init: "7c>7f",
  process: "7f>7f",
  render: "7f>7f",
  transform: "7f>7f",
};
const ENTRY: Readonly<Record<DeviceKind, string>> = {
  fx: "process",
  synth: "render",
  notes: "transform",
};

export type DeviceInfo = Readonly<{
  kind: DeviceKind;
  /** Declared memory pages: minimum and maximum. */
  pages: Readonly<{ min: number; max: number }>;
  functions: number;
  bytes: number;
}>;

export type InstrumentedDevice = DeviceInfo &
  Readonly<{ instrumented: Uint8Array<ArrayBuffer> }>;

/**
 * Checks a module against `dawn.device/v1` and returns it rewritten with
 * fuel, depth and NaN canonicalization. Throws `DeviceValidationError`.
 * It does not compile the result; `compileDevice` does.
 */
export function instrumentDevice(bytes: Uint8Array): InstrumentedDevice {
  if (!(bytes instanceof Uint8Array)) fail("a device must be bytes");
  if (bytes.length > DEVICE_LIMITS.maxBytes)
    fail(`module is ${bytes.length} bytes; at most ${DEVICE_LIMITS.maxBytes}`);
  const m = parse(bytes);
  if (!m.memory) fail("a device defines exactly one memory");
  const exported = new Map<string, Export>();
  for (const e of m.exports) exported.set(e.name, e);
  const memory = exported.get("memory");
  if (!memory || memory.kind !== 2 || memory.index !== 0)
    fail('a device exports its memory as "memory"');
  const kinds = DEVICE_KINDS.filter((kind) => exported.has(ENTRY[kind]));
  if (kinds.length !== 1)
    fail(
      "a device exports exactly one of process (fx), render (synth) or transform (notes)",
    );
  const kind = kinds[0]!;
  for (const name of ["init", ENTRY[kind]]) {
    const e = exported.get(name);
    if (!e || e.kind !== 0) fail(`a device exports a function "${name}"`);
    const type = m.types[m.funcs[e!.index] ?? -1];
    if (!type) fail(`export ${name} is not a defined function`);
    const sig = `${type!.params.map((t) => t.toString(16)).join(",")}>${type!.results.map((t) => t.toString(16)).join(",")}`;
    if (sig !== SIGNATURES[name])
      fail(
        name === "init"
          ? "init takes the sample rate (f64) and returns the I/O pointer (i32)"
          : `${name} takes an i32 and returns an i32 status`,
      );
  }
  if (!m.code && m.funcs.length > 0) fail("module has no code section");

  // Block types for multi-value functions: reuse or append `[] -> results`.
  const types = [...m.types];
  const blockTypes = new Map<string, number>();
  for (const t of m.funcs) {
    const results = m.types[t]!.results;
    if (results.length < 2) continue;
    const key = results.join(",");
    if (blockTypes.has(key)) continue;
    let found = types.findIndex(
      (x) => x.params.length === 0 && x.results.join(",") === key,
    );
    if (found < 0) {
      found = types.length;
      types.push({ params: [], results });
    }
    blockTypes.set(key, found);
  }
  const rw: Rewrite = { fuel: m.globals, depth: m.globals + 1, blockTypes };

  const out = new Writer().byte(0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00);
  let wroteGlobals = false;
  const globals = () => {
    if (wroteGlobals) return;
    wroteGlobals = true;
    const g = new Writer().u32(m.globals + 2);
    const old = m.sections.find((s) => s.id === 6);
    if (old) {
      const r = new Reader(bytes, old.start, old.end);
      r.u32();
      g.bytes(bytes.subarray(r.pos, old.end));
    }
    g.byte(0x7e, 0x01, 0x42, 0x00, 0x0b); // __dawn_fuel: mut i64 = 0
    g.byte(0x7f, 0x01, 0x41, 0x00, 0x0b); // __dawn_depth: mut i32 = 0
    out.section(6, g);
  };
  for (const s of m.sections) {
    if (ORDER[s.id]! >= ORDER[6]!) globals();
    if (s.id === 6) continue;
    if (s.id === 1) {
      const w = new Writer().u32(types.length);
      const r = new Reader(bytes, s.start, s.end);
      r.u32();
      w.bytes(bytes.subarray(r.pos, s.end));
      for (const t of types.slice(m.types.length))
        w.byte(0x60)
          .u32(0)
          .u32(t.results.length)
          .byte(...t.results);
      out.section(1, w);
    } else if (s.id === 7) {
      const w = new Writer().u32(m.exports.length + 2);
      const r = new Reader(bytes, s.start, s.end);
      r.u32();
      w.bytes(bytes.subarray(r.pos, s.end));
      for (const [name, index] of [
        ["__dawn_fuel", rw.fuel],
        ["__dawn_depth", rw.depth],
      ] as const) {
        w.u32(name.length);
        for (const c of name) w.byte(c.charCodeAt(0));
        w.byte(0x03).u32(index);
      }
      out.section(7, w);
    } else if (s.id === 10) {
      const r = new Reader(bytes, s.start, s.end);
      const n = r.u32();
      if (n !== m.funcs.length) fail("code and function counts differ");
      const w = new Writer().u32(n);
      for (let i = 0; i < n; i += 1) {
        const size = r.u32();
        const start = r.pos;
        r.skip(size);
        const body = rewriteBody(
          bytes,
          start,
          r.pos,
          m.types[m.funcs[i]!]!,
          i,
          rw,
        );
        w.u32(body.length).bytes(body);
      }
      if (!r.done) fail("code section has trailing bytes");
      out.section(10, w);
    } else
      out.section(s.id, new Writer().bytes(bytes.subarray(s.start, s.end)));
  }
  globals();
  return Object.freeze({
    kind,
    pages: Object.freeze({ ...m.memory! }),
    functions: m.funcs.length,
    bytes: bytes.length,
    instrumented: out.result(),
  });
}

export type CompiledDevice = DeviceInfo &
  Readonly<{ module: WebAssembly.Module }>;

/** Validates, instruments and compiles a device. Throws `DeviceValidationError`. */
export function compileDevice(bytes: Uint8Array): CompiledDevice {
  const device = instrumentDevice(bytes);
  if (!WebAssembly.validate(bytes as Uint8Array<ArrayBuffer>))
    fail("module does not pass WebAssembly validation");
  let module: WebAssembly.Module;
  try {
    module = new WebAssembly.Module(device.instrumented);
  } catch (error) {
    fail(
      `module does not compile: ${error instanceof Error ? error.message : String(error)}`.slice(
        0,
        300,
      ),
    );
  }
  const { instrumented: _instrumented, ...info } = device;
  return Object.freeze({ ...info, module: module! });
}

// ------------------------------------------------------------ running

/** One note event for a synth device, in block frames. */
export type DeviceEvent = Readonly<{
  frame: number;
  on: boolean;
  voice: number;
  note: number;
  velocity: number;
  hz: number;
}>;

/** A note for a note device, in frames and MIDI pitch. */
export type DeviceNote = Readonly<{
  start: number;
  length: number;
  pitch: number;
  velocity: number;
  /** Input: the note's index in the whole list. Output: the input note it came from. */
  source: number;
}>;

type Exports = {
  memory: WebAssembly.Memory;
  init: (rate: number) => number;
  process?: (n: number) => number;
  render?: (n: number) => number;
  transform?: (n: number) => number;
  __dawn_fuel: WebAssembly.Global;
  __dawn_depth: WebAssembly.Global;
};

/**
 * A running device: a fresh instance with its own memory, initialized at
 * one sample rate. Any trap, budget overrun or bad status kills it; every
 * later call throws the same `DeviceRuntimeError`.
 */
export class Device {
  readonly kind: DeviceKind;
  /** Control values `p1`..`p8` the next call sees. */
  readonly params = new Float64Array(DEVICE_PARAMS);
  private readonly x: Exports;
  private readonly io: number;
  private failed: DeviceRuntimeError | undefined;
  private seen = 0;
  private returned = 0;

  constructor(
    compiled: CompiledDevice,
    sampleRate: number,
    readonly label = "device",
  ) {
    this.kind = compiled.kind;
    let instance: WebAssembly.Instance;
    try {
      instance = new WebAssembly.Instance(compiled.module, {});
    } catch (error) {
      throw new DeviceRuntimeError(
        `${label} could not start: ${error instanceof Error ? error.message : String(error)}`.slice(
          0,
          300,
        ),
      );
    }
    this.x = instance.exports as unknown as Exports;
    const io = this.call(
      this.x.init,
      sampleRate,
      DEVICE_LIMITS.initFuel,
      "init",
    );
    const size =
      this.kind === "notes" ? DEVICE_IO.notesBytes : DEVICE_IO.audioBytes;
    if (io <= 0 || io % 8 !== 0 || io + size > this.x.memory.buffer.byteLength)
      this.die(
        `init returned I/O pointer ${io}; it must be 8-byte aligned, above 0 and leave ${size} bytes in memory`,
      );
    this.io = io;
  }

  private die(message: string): never {
    this.failed ??= new DeviceRuntimeError(`${this.label}: ${message}`);
    throw this.failed;
  }

  private call(
    fn: (n: number) => number,
    arg: number,
    fuel: number,
    what: string,
  ): number {
    if (this.failed) throw this.failed;
    this.x.__dawn_fuel.value = BigInt(fuel);
    this.x.__dawn_depth.value = 0;
    try {
      return fn(arg);
    } catch (error) {
      if ((this.x.__dawn_fuel.value as bigint) < 0n)
        this.die(`${what} ran past its budget of ${fuel} instructions`);
      if ((this.x.__dawn_depth.value as number) > DEVICE_LIMITS.maxDepth)
        this.die(`${what} recursed past the call depth limit`);
      if (error instanceof WebAssembly.RuntimeError)
        this.die(`${what} trapped (${error.message})`.slice(0, 300));
      if (error instanceof RangeError)
        this.die(`${what} exhausted the host stack`);
      throw error;
    }
  }

  private view(): DataView {
    return new DataView(this.x.memory.buffer, this.io);
  }

  /**
   * Runs one 128-frame block. fx reads `inLeft`/`inRight`; synth reads
   * `events` (at most `maxEvents`, frames inside the block). Outputs are
   * written to `outLeft`/`outRight`, finite and clamped.
   */
  block(
    inLeft: Float64Array | undefined,
    inRight: Float64Array | undefined,
    events: readonly DeviceEvent[],
    outLeft: Float64Array,
    outRight: Float64Array,
  ): void {
    if (this.kind === "notes") this.die("a note device has no audio block");
    const v = this.view();
    for (let i = 0; i < DEVICE_PARAMS; i += 1)
      v.setFloat64(DEVICE_IO.params + 8 * i, finiteOr0(this.params[i]!), true);
    for (let i = 0; i < DEVICE_BLOCK; i += 1) {
      v.setFloat64(DEVICE_IO.inLeft + 8 * i, finiteOr0(inLeft?.[i] ?? 0), true);
      v.setFloat64(
        DEVICE_IO.inRight + 8 * i,
        finiteOr0(inRight?.[i] ?? inLeft?.[i] ?? 0),
        true,
      );
      v.setFloat64(DEVICE_IO.outLeft + 8 * i, 0, true);
      v.setFloat64(DEVICE_IO.outRight + 8 * i, 0, true);
    }
    if (events.length > DEVICE_LIMITS.maxEvents)
      this.die("too many events in one block");
    v.setInt32(DEVICE_IO.eventCount, events.length, true);
    events.forEach((e, i) => {
      const at = DEVICE_IO.events + DEVICE_IO.eventBytes * i;
      v.setInt32(at, e.frame, true);
      v.setInt32(at + 4, e.on ? 1 : 0, true);
      v.setInt32(at + 8, e.voice, true);
      v.setInt32(at + 12, e.note, true);
      v.setFloat64(at + 16, e.velocity, true);
      v.setFloat64(at + 24, e.hz, true);
    });
    const fn = this.kind === "fx" ? this.x.process! : this.x.render!;
    const status = this.call(
      fn,
      DEVICE_BLOCK,
      DEVICE_LIMITS.blockFuel,
      this.kind === "fx" ? "process" : "render",
    );
    if (status !== 0)
      this.die(
        `${this.kind === "fx" ? "process" : "render"} returned status ${status}`,
      );
    const after = this.view();
    const max = DEVICE_LIMITS.maxSample;
    for (let i = 0; i < DEVICE_BLOCK; i += 1) {
      outLeft[i] = clampSample(
        after.getFloat64(DEVICE_IO.outLeft + 8 * i, true),
        max,
      );
      outRight[i] = clampSample(
        after.getFloat64(DEVICE_IO.outRight + 8 * i, true),
        max,
      );
    }
  }

  /**
   * Passes the next notes (at most `maxNotesIn`, in start order) through a
   * note device and returns what it made of them, validated.
   */
  transform(notes: readonly DeviceNote[]): DeviceNote[] {
    if (this.kind !== "notes") this.die("only a note device transforms notes");
    if (notes.length > DEVICE_LIMITS.maxNotesIn)
      this.die("too many notes in one call");
    const v = this.view();
    for (let i = 0; i < DEVICE_PARAMS; i += 1)
      v.setFloat64(DEVICE_IO.params + 8 * i, finiteOr0(this.params[i]!), true);
    notes.forEach((n, i) => {
      const at = DEVICE_IO.notesIn + DEVICE_IO.noteBytes * i;
      v.setFloat64(at, n.start, true);
      v.setFloat64(at + 8, n.length, true);
      v.setFloat64(at + 16, n.pitch, true);
      v.setFloat64(at + 24, n.velocity, true);
      v.setInt32(at + 32, n.source, true);
      v.setInt32(at + 36, 0, true);
    });
    this.seen = Math.max(this.seen, ...notes.map((n) => n.source + 1));
    const count = this.call(
      this.x.transform!,
      notes.length,
      DEVICE_LIMITS.notesFuel,
      "transform",
    );
    if (count < 0) this.die(`transform returned status ${count}`);
    if (count > DEVICE_LIMITS.maxNotesOut)
      this.die(
        `transform returned ${count} notes; at most ${DEVICE_LIMITS.maxNotesOut} per call`,
      );
    this.returned += count;
    if (this.returned > DEVICE_LIMITS.maxNotesTotal)
      this.die(
        `transform returned more than ${DEVICE_LIMITS.maxNotesTotal} notes in all`,
      );
    const after = this.view();
    const out: DeviceNote[] = [];
    for (let i = 0; i < count; i += 1) {
      const at = DEVICE_IO.notesOut + DEVICE_IO.noteBytes * i;
      const note = {
        start: after.getFloat64(at, true),
        length: after.getFloat64(at + 8, true),
        pitch: after.getFloat64(at + 16, true),
        velocity: after.getFloat64(at + 24, true),
        source: after.getInt32(at + 32, true),
      };
      if (
        !Number.isFinite(note.start) ||
        note.start < 0 ||
        note.start > 2 ** 40 ||
        !Number.isFinite(note.length) ||
        note.length <= 0 ||
        note.length > 2 ** 40 ||
        !Number.isFinite(note.pitch) ||
        note.pitch < 0 ||
        note.pitch > 127 ||
        !Number.isFinite(note.velocity) ||
        note.velocity < 0 ||
        note.velocity > 1 ||
        note.source < 0 ||
        note.source >= this.seen
      )
        this.die(`transform returned an invalid note at index ${i}`);
      out.push(note);
    }
    return out;
  }
}

const finiteOr0 = (x: number): number => (Number.isFinite(x) ? x : 0);
const clampSample = (x: number, max: number): number =>
  Number.isFinite(x) ? Math.max(-max, Math.min(max, x)) : 0;
