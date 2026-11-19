// SPDX-License-Identifier: MIT
import { expect, test } from "bun:test";
import {
  TRACE_FORMAT,
  TRACE_KINDS,
  TRACE_LIMITS,
  TraceValidationError,
  canonicalJson,
  parseTraceEvent,
  redactTraceEvent,
  traceEventLine,
} from "./trace.ts";

const writer = "0123456789abcdef0123456789abcdef";
const otherWriter = "a".repeat(32);
const base = "A".repeat(43);
const at = "2026-11-15T12:00:00.000Z";
const session = () => ({
  v: 1 as const,
  id: `${writer}.1`,
  at,
  kind: "session",
  base,
  format: TRACE_FORMAT as typeof TRACE_FORMAT,
  dawn: "0.57.0",
  sdk: "1.48.0",
});
const event = () => ({
  v: 1 as const,
  id: `${writer}.2`,
  at,
  kind: "decision",
  base,
  session: `${writer}.1`,
});
const body = () => ({
  sha256: "a".repeat(64),
  bytes: 123,
  mediaType: "application/json" as const,
});

test("canonical JSON sorts every object without reordering arrays or depending on insertion order", () => {
  const input = {
    z: [{ z: 1, a: 2 }, -0, null, "é\n"],
    a: { "2": false, "10": true, "01": null },
  };
  const expected =
    '{"a":{"01":null,"10":true,"2":false},"z":[{"a":2,"z":1},0,null,"é\\n"]}';
  expect(canonicalJson(input)).toBe(expected);
  expect(canonicalJson(JSON.parse(expected))).toBe(expected);
  expect(canonicalJson({ a: input.a, z: input.z })).toBe(expected);
  expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
  expect(canonicalJson("\ud800")).toBe('"\\ud800"');
  expect(canonicalJson({ "\ue000": 1, "🎹": 2 })).toBe('{"🎹":2,"":1}');
  expect(canonicalJson({ b: input.a, a: input.a })).toBe(
    '{"a":{"01":null,"10":true,"2":false},"b":{"01":null,"10":true,"2":false}}',
  );
});

test("canonical JSON rejects executable, nonfinite, sparse, inherited and cyclic values without invoking accessors", () => {
  let calls = 0;
  const getter = Object.defineProperty({}, "text", {
    enumerable: true,
    get: () => {
      calls++;
      return "private";
    },
  });
  const toJSON = {
    toJSON() {
      calls++;
      return "private";
    },
  };
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const extra = [1] as number[] & { label?: string };
  extra.label = "private";
  const hidden = Object.defineProperty({}, "hidden", { value: "private" });
  const customArray = Object.setPrototypeOf(
    [1],
    Object.create(Array.prototype),
  );
  for (const value of [
    undefined,
    NaN,
    Infinity,
    -Infinity,
    1n,
    Symbol("value"),
    () => null,
    { value: undefined },
    new Date(at),
    new Map(),
    Object.create({ inherited: "private" }),
    getter,
    toJSON,
    cyclic,
    [, 1],
    extra,
    hidden,
    customArray,
    { [Symbol("key")]: "value" },
  ])
    expect(() => canonicalJson(value)).toThrow(TraceValidationError);
  expect(calls).toBe(0);
});

test("foreign JSON keys remain data without modifying prototypes", () => {
  const input = JSON.parse(
    '{"__proto__":{"polluted":true},"constructor":{"prototype":{"private":"kept"}}}',
  );
  expect(canonicalJson(input)).toBe(
    '{"__proto__":{"polluted":true},"constructor":{"prototype":{"private":"kept"}}}',
  );
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  const parsed = parseTraceEvent({ ...event(), retained: input });
  expect(parsed.retained).toEqual(input);
  expect(redactTraceEvent(parsed).retained).toBeUndefined();
});

test("canonical JSON bounds UTF-8 bytes, expanded object size, depth and value count", () => {
  expect(canonicalJson("é", 4)).toBe('"é"');
  expect(() => canonicalJson("é", 3)).toThrow("UTF-8 bytes");
  expect(canonicalJson("🎹", 6)).toBe('"🎹"');
  expect(() => canonicalJson("🎹", 5)).toThrow("UTF-8 bytes");
  expect(() => canonicalJson("\n", 3)).toThrow("UTF-8 bytes");
  for (const limit of [0, -1, 1.1, NaN, Infinity, TRACE_LIMITS.objectBytes + 1])
    expect(() => canonicalJson(null, limit)).toThrow("byte limit");
  const largest = "x".repeat(TRACE_LIMITS.objectBytes - 2);
  expect(canonicalJson(largest).length).toBe(TRACE_LIMITS.objectBytes);
  expect(() => canonicalJson(`${largest}x`)).toThrow("UTF-8 bytes");
  let nested: unknown = null;
  for (let i = 0; i < TRACE_LIMITS.depth; i++) nested = [nested];
  expect(() => canonicalJson(nested)).not.toThrow();
  expect(() => canonicalJson([nested])).toThrow("nesting");
  expect(() => canonicalJson(Array(TRACE_LIMITS.nodes).fill(null))).toThrow(
    "values",
  );
  expect(canonicalJson(Array(TRACE_LIMITS.nodes - 1).fill(0)).length).toBe(
    2 * (TRACE_LIMITS.nodes - 1) + 1,
  );
});

test("sessions and events preserve bounded future data in detached frozen records", () => {
  expect(parseTraceEvent(session())).toEqual(session());
  const raw = {
    ...event(),
    kind: "future-kind",
    cause: `${otherWriter}.42`,
    result: "B".repeat(42) + "A",
    status: "applied" as const,
    actor: {
      kind: "agent" as const,
      name: "composer",
      model: "chosen-model",
      future: true,
    },
    body: { ...body(), future: { version: 2 } },
    data: { words: "Use the warmer pad", measured: [1, 2] },
    future: { nested: [true, null] },
  };
  const parsed = parseTraceEvent(raw);
  expect(parsed).toEqual(raw);
  raw.data.words = "Changed later";
  raw.future.nested.push(false);
  expect(parsed.data).toEqual({
    words: "Use the warmer pad",
    measured: [1, 2],
  });
  expect(parsed.future).toEqual({ nested: [true, null] });
  for (const value of [
    parsed,
    parsed.actor,
    parsed.body,
    parsed.body!.future,
    parsed.data,
    parsed.future,
  ])
    expect(Object.isFrozen(value)).toBe(true);
  expect(traceEventLine(parsed)).toBe(`${canonicalJson(parsed)}\n`);
  expect(parseTraceEvent(JSON.parse(traceEventLine(parsed)))).toEqual(parsed);
});

test("envelope admission validates required fields, sessions, identifiers and canonical revisions", () => {
  for (const patch of [
    { v: 0 },
    { v: 2 },
    { v: "1" },
    { id: `${writer}.0` },
    { id: `${writer}.02` },
    { id: `${writer}.1` },
    { id: `${writer.toUpperCase()}.2` },
    { id: `${writer}.9007199254740992` },
    { id: `${writer}.2/escape` },
    { session: `${otherWriter}.1` },
    { session: `${writer}.2` },
    { at: "2026-02-30T12:00:00.000Z" },
    { at: "2026-11-15T12:00:00Z" },
    { at: "2026-11-15T12:00:00.000+00:00" },
    { at: "2026-11-15T24:00:00.000Z" },
    { kind: "" },
    { kind: "NotKnown" },
    { kind: "x".repeat(33) },
    { base: "A".repeat(42) },
    { base: "A".repeat(42) + "B" },
    { base: "a".repeat(64) },
    { cause: "not-an-event" },
    { result: "not-a-revision" },
    { format: false },
    { dawn: 1 },
    { sdk: null },
    { status: "success" },
    { actor: [] },
    { actor: { kind: "unknown" } },
    { actor: { kind: "agent", name: " " } },
    { actor: { kind: "agent", model: "x\nsecret" } },
    { actor: { kind: "agent", name: "x".repeat(129) } },
  ])
    expect(() => parseTraceEvent({ ...event(), ...patch })).toThrow(
      TraceValidationError,
    );
  for (const field of ["v", "id", "at", "kind", "base", "session"]) {
    const missing: Record<string, unknown> = event();
    delete missing[field];
    expect(() => parseTraceEvent(missing)).toThrow(TraceValidationError);
  }
  for (const patch of [
    { id: `${writer}.2` },
    { session: `${writer}.1` },
    { format: "dawn.trace/v2" },
    { dawn: "0.57" },
    { dawn: "01.57.0" },
    { sdk: "1.48.0+private" },
  ])
    expect(() => parseTraceEvent({ ...session(), ...patch })).toThrow(
      TraceValidationError,
    );
  expect(
    parseTraceEvent({ ...event(), id: `${writer}.9007199254740991` }).id,
  ).toBe(`${writer}.9007199254740991`);
});

test("object references and omission markers reject invalid metadata without opening an object", () => {
  for (const patch of [
    { sha256: "A".repeat(64) },
    { sha256: "../private" },
    { sha256: "a".repeat(63) },
    { bytes: 0 },
    { bytes: -1 },
    { bytes: 1.5 },
    { bytes: TRACE_LIMITS.objectBytes + 1 },
    { bytes: "123" },
    { mediaType: "text/plain" },
  ])
    expect(() =>
      parseTraceEvent({ ...event(), body: { ...body(), ...patch } }),
    ).toThrow(TraceValidationError);
  for (const omitted of [[], ["body", "body"], ["private-field"], "body", null])
    expect(() => parseTraceEvent({ ...event(), omitted })).toThrow(
      TraceValidationError,
    );
  expect(
    parseTraceEvent({
      ...event(),
      body: { ...body(), bytes: TRACE_LIMITS.objectBytes },
    }).body!.bytes,
  ).toBe(TRACE_LIMITS.objectBytes);
});

test("an envelope includes its trailing newline and counts non-ASCII content as UTF-8", () => {
  const initial = { ...event(), data: "" };
  const available =
    TRACE_LIMITS.envelopeBytes - Buffer.byteLength(traceEventLine(initial));
  const full = { ...initial, data: "x".repeat(available) };
  expect(Buffer.byteLength(traceEventLine(full))).toBe(
    TRACE_LIMITS.envelopeBytes,
  );
  expect(() => traceEventLine({ ...full, data: `${full.data}x` })).toThrow(
    "UTF-8 bytes",
  );
  expect(() =>
    parseTraceEvent({ ...full, data: "é".repeat(available) }),
  ).toThrow("UTF-8 bytes");
});

test("metadata export removes text, object hashes, identities and unknown keys without naming secrets", () => {
  const raw = {
    ...event(),
    actor: {
      kind: "agent",
      name: "private-name",
      model: "private-model",
      privateAccount: "secret",
    },
    data: { prompt: "private-prompt", evidence: "private-output" },
    body: body(),
    "private-filename": "private-content",
    cause: `${otherWriter}.4`,
    result: base,
    status: "applied",
  };
  const redacted = redactTraceEvent(raw);
  expect(redacted).toEqual({
    ...event(),
    actor: { kind: "agent" },
    cause: `${otherWriter}.4`,
    result: base,
    status: "applied",
    omitted: ["data", "body", "identity", "unknown-fields"],
  });
  const text = traceEventLine(redacted);
  for (const secret of ["private", "secret", body().sha256])
    expect(text).not.toContain(secret);
  expect(redactTraceEvent(redacted)).toEqual(redacted);
  expect(raw.data.prompt).toBe("private-prompt");
  expect(raw.body.sha256).toBe(body().sha256);
});

test("unknown event kinds become explicit omissions and redaction keeps evidence and summaries distinct", () => {
  const unknown = redactTraceEvent({
    ...event(),
    kind: "private-extension",
    secret: { value: "private-body" },
  });
  expect(unknown.kind).toBe("omission");
  expect(unknown.omitted).toEqual(["unknown-fields", "unknown-kind"]);
  expect(traceEventLine(unknown)).not.toContain("private");
  for (const kind of TRACE_KINDS.filter((kind) => kind !== "session"))
    expect(redactTraceEvent({ ...event(), kind }).kind).toBe(kind);
  const start = {
    ...session(),
    actor: { kind: "agent", name: "private-name", model: "private-model" },
    data: { private: "session-prompt" },
  };
  expect(redactTraceEvent(start)).toEqual({
    ...session(),
    actor: { kind: "agent" },
    omitted: ["data", "identity"],
  });
  expect(redactTraceEvent(redactTraceEvent(start))).toEqual(
    redactTraceEvent(start),
  );
  expect(parseTraceEvent({ ...event(), omitted: ["body"] }).omitted).toEqual([
    "body",
  ]);
});
