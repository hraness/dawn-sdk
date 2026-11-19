// SPDX-License-Identifier: MIT
/** Bounded trace envelopes and canonical JSON; this module never reads or writes files. */
export const TRACE_FORMAT = "dawn.trace/v1";
export const TRACE_LIMITS = Object.freeze({
  envelopeBytes: 8 * 1024,
  objectBytes: 8 * 1024 * 1024,
  segmentBytes: 8 * 1024 * 1024,
  storedBytes: 64 * 1024 * 1024,
  streams: 1024,
  events: 100_000,
  objects: 8192,
  depth: 32,
  nodes: 262_144,
});

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export const TRACE_KINDS = [
  "session",
  "prompt",
  "chosen",
  "command",
  "write",
  "gap",
  "heard",
  "comment",
  "undo",
  "redo",
  "take",
  "decision",
  "evidence",
  "handoff",
  "summary",
  "omission",
] as const;
export type TraceKind = (typeof TRACE_KINDS)[number];

export const TRACE_OMISSIONS = [
  "data",
  "body",
  "identity",
  "unknown-fields",
  "unknown-kind",
] as const;
export type TraceOmission = (typeof TRACE_OMISSIONS)[number];
export type TraceObjectRef = Readonly<{
  sha256: string;
  bytes: number;
  mediaType: "application/json";
  [key: string]: unknown;
}>;
export type TraceActor = Readonly<{
  kind: "person" | "agent" | "engine";
  name?: string;
  model?: string;
  [key: string]: unknown;
}>;

/** Unknown fields and kinds are retained as bounded JSON, never interpreted as instructions. */
export type TraceEvent = Readonly<{
  v: 1;
  id: string;
  at: string;
  kind: string;
  base: string;
  session?: string;
  format?: typeof TRACE_FORMAT;
  dawn?: string;
  sdk?: string;
  cause?: string;
  result?: string;
  actor?: TraceActor;
  status?: "applied" | "unchanged" | "stale" | "failed";
  body?: TraceObjectRef;
  data?: JsonValue;
  omitted?: readonly TraceOmission[];
  [key: string]: unknown;
}>;

export class TraceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TraceValidationError";
  }
}

function fail(message: string): never {
  throw new TraceValidationError(message);
}

const utf8 = new TextEncoder();

/**
 * Canonical uncompressed object bytes are UTF-8 of this string, without a newline.
 * Object keys sort by UTF-16 code units; arrays keep their order. Primitive
 * spelling follows JSON.stringify, including -0 as 0 and escaped lone surrogates.
 * Only finite plain JSON data is accepted; getters and toJSON are not invoked.
 */
export function canonicalJson(
  value: unknown,
  maxBytes: number = TRACE_LIMITS.objectBytes,
): string {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > TRACE_LIMITS.objectBytes
  )
    fail(`JSON byte limit must be 1..${TRACE_LIMITS.objectBytes}`);
  const parts: string[] = [];
  const ancestors = new Set<object>();
  let bytes = 0;
  let nodes = 0;

  function emit(text: string): void {
    // This cheap check prevents encoding an already oversized string.
    if (text.length > maxBytes - bytes)
      fail(`JSON exceeds ${maxBytes} UTF-8 bytes`);
    bytes += utf8.encode(text).length;
    if (bytes > maxBytes) fail(`JSON exceeds ${maxBytes} UTF-8 bytes`);
    parts.push(text);
  }

  function quote(text: string): void {
    if (text.length > maxBytes - bytes)
      fail(`JSON exceeds ${maxBytes} UTF-8 bytes`);
    emit(JSON.stringify(text));
  }

  function visit(current: unknown, depth: number): void {
    if (++nodes > TRACE_LIMITS.nodes)
      fail(`JSON exceeds ${TRACE_LIMITS.nodes} values`);
    if (depth > TRACE_LIMITS.depth)
      fail(`JSON exceeds ${TRACE_LIMITS.depth} levels of nesting`);
    if (current === null) return emit("null");
    if (typeof current === "boolean") return emit(current ? "true" : "false");
    if (typeof current === "string") return quote(current);
    if (typeof current === "number") {
      if (!Number.isFinite(current)) fail("JSON numbers must be finite");
      return emit(JSON.stringify(current));
    }
    if (typeof current !== "object") fail("trace values must be JSON data");
    const object = current as object;
    const array = Array.isArray(object);
    const prototype = Object.getPrototypeOf(object);
    if (
      array
        ? prototype !== Array.prototype
        : prototype !== Object.prototype && prototype !== null
    )
      fail("trace objects must be plain JSON objects");
    if (ancestors.has(object)) fail("trace values must not contain cycles");
    const keys = Reflect.ownKeys(object);
    const length = array ? (object as unknown[]).length : 0;
    const dataKeys = keys.filter((key) => !(array && key === "length"));
    if (
      dataKeys.length > TRACE_LIMITS.nodes - nodes ||
      (array && length > TRACE_LIMITS.nodes - nodes)
    )
      fail(`JSON exceeds ${TRACE_LIMITS.nodes} values`);
    if (array && dataKeys.length !== length)
      fail("trace arrays must not be sparse or have extra fields");
    const fields = new Map<string, unknown>();
    for (const key of dataKeys) {
      if (typeof key !== "string") fail("trace JSON keys must be strings");
      if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length))
        fail("trace arrays must contain only indexed values");
      const descriptor = Object.getOwnPropertyDescriptor(object, key)!;
      if (!descriptor.enumerable || !("value" in descriptor))
        fail("trace fields must be enumerable data");
      fields.set(key, descriptor.value);
    }
    ancestors.add(object);
    emit(array ? "[" : "{");
    const ordered = array
      ? Array.from({ length }, (_, i) => String(i))
      : [...fields.keys()].sort();
    for (let i = 0; i < ordered.length; i++) {
      if (i) emit(",");
      const key = ordered[i]!;
      if (!array) {
        quote(key);
        emit(":");
      }
      visit(fields.get(key), depth + 1);
    }
    emit(array ? "]" : "}");
    ancestors.delete(object);
  }

  visit(value, 0);
  return parts.join("");
}

const EVENT_ID = /^[a-f0-9]{32}\.([1-9][0-9]{0,15})$/;
const REVISION = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const VERSION =
  /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/;

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function eventId(value: unknown, label: string): string {
  if (typeof value !== "string") fail(`${label} must be an event ID`);
  const match = EVENT_ID.exec(value);
  if (!match || !Number.isSafeInteger(Number(match[1])))
    fail(
      `${label} must be a 32-character writer ID and a positive safe integer`,
    );
  return value;
}

function revision(value: unknown, label: string): void {
  if (typeof value !== "string" || !REVISION.test(value))
    fail(`${label} must be a canonical base64url SHA-256 revision digest`);
}

function actorName(value: unknown, label: string): void {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 128 ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    fail(`${label} must be 1..128 characters without control characters`);
}

function freezeJson(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  for (const child of Object.values(value)) freezeJson(child);
  Object.freeze(value);
}

/** Validate and detach one envelope. Stream order and referenced objects are checked by storage. */
export function parseTraceEvent(value: unknown): TraceEvent {
  // Reserve the final byte for the JSONL newline, including for callers using objects.
  const parsed: unknown = JSON.parse(
    canonicalJson(value, TRACE_LIMITS.envelopeBytes - 1),
  );
  const event = record(parsed, "trace event");
  if (event.v !== 1) fail("unsupported trace version; expected v: 1");
  const id = eventId(event.id, "id");
  if (
    typeof event.at !== "string" ||
    !TIME.test(event.at) ||
    !Number.isFinite(Date.parse(event.at)) ||
    new Date(event.at).toISOString() !== event.at
  )
    fail("at must be a valid UTC timestamp with milliseconds");
  if (
    typeof event.kind !== "string" ||
    !/^[a-z][a-z0-9-]{0,31}$/.test(event.kind)
  )
    fail("kind must be a lowercase identifier of 1..32 characters");
  revision(event.base, "base");
  const session = `${id.split(".")[0]}.1`;
  if (event.format !== undefined && event.format !== TRACE_FORMAT)
    fail(`format must be ${TRACE_FORMAT}`);
  for (const name of ["dawn", "sdk"] as const)
    if (
      event[name] !== undefined &&
      (typeof event[name] !== "string" || !VERSION.test(event[name]))
    )
      fail(`${name} must be a stable major.minor.patch version`);
  if (event.kind === "session") {
    if (id !== session || event.session !== undefined)
      fail("a session starts at writer.1 and has no session reference");
    if (event.format !== TRACE_FORMAT)
      fail(`session format must be ${TRACE_FORMAT}`);
    for (const name of ["dawn", "sdk"] as const)
      if (event[name] === undefined)
        fail(`session ${name} must be a stable major.minor.patch version`);
  } else if (id === session || event.session !== session) {
    fail("an event must follow and reference its writer.1 session");
  }
  if (event.cause !== undefined) eventId(event.cause, "cause");
  if (event.result !== undefined) revision(event.result, "result");
  if (event.actor !== undefined) {
    const actor = record(event.actor, "actor");
    if (!["person", "agent", "engine"].includes(actor.kind as string))
      fail("actor kind must be person, agent or engine");
    for (const name of ["name", "model"] as const)
      if (actor[name] !== undefined) actorName(actor[name], `actor ${name}`);
  }
  if (
    event.status !== undefined &&
    !["applied", "unchanged", "stale", "failed"].includes(
      event.status as string,
    )
  )
    fail("status must be applied, unchanged, stale or failed");
  if (event.body !== undefined) {
    const body = record(event.body, "body");
    if (typeof body.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(body.sha256))
      fail("body sha256 must be 64 lowercase hexadecimal characters");
    if (
      !Number.isSafeInteger(body.bytes) ||
      (body.bytes as number) < 1 ||
      (body.bytes as number) > TRACE_LIMITS.objectBytes
    )
      fail(`body bytes must be 1..${TRACE_LIMITS.objectBytes}`);
    if (body.mediaType !== "application/json")
      fail("body mediaType must be application/json");
  }
  if (event.omitted !== undefined) {
    if (
      !Array.isArray(event.omitted) ||
      event.omitted.length < 1 ||
      event.omitted.length > TRACE_OMISSIONS.length ||
      event.omitted.some(
        (item) => !(TRACE_OMISSIONS as readonly unknown[]).includes(item),
      ) ||
      new Set(event.omitted).size !== event.omitted.length
    )
      fail("omitted must contain distinct known omission markers");
  }
  freezeJson(event);
  return event as TraceEvent;
}

/** One canonical JSONL line, with its newline included in the envelope budget. */
export function traceEventLine(event: unknown): string {
  return `${canonicalJson(parseTraceEvent(event), TRACE_LIMITS.envelopeBytes - 1)}\n`;
}

/**
 * A metadata-only copy. Free text, objects and unknown fields never cross this
 * boundary. Omission markers name categories, never hidden field names or hashes.
 * This does not establish the truth of a claim or consent to collect a trace.
 */
export function redactTraceEvent(value: unknown): TraceEvent {
  const event = parseTraceEvent(value);
  const recognized = (TRACE_KINDS as readonly string[]).includes(event.kind);
  const omitted = new Set<TraceOmission>(event.omitted ?? []);
  const result: Record<string, unknown> = {
    v: event.v,
    id: event.id,
    at: event.at,
    kind: recognized ? event.kind : "omission",
    base: event.base,
  };
  const kept = new Set(["v", "id", "at", "kind", "base", "omitted"]);
  for (const key of ["session", "cause", "result", "status"] as const) {
    if (event[key] !== undefined) result[key] = event[key];
    kept.add(key);
  }
  if (event.kind === "session")
    for (const key of ["format", "dawn", "sdk"] as const) {
      result[key] = event[key];
      kept.add(key);
    }
  if (event.actor !== undefined) {
    result.actor = { kind: event.actor.kind };
    kept.add("actor");
    if (Object.keys(event.actor).some((key) => key !== "kind"))
      omitted.add("identity");
  }
  for (const key of ["data", "body"] as const) {
    if (Object.hasOwn(event, key)) omitted.add(key);
    kept.add(key);
  }
  if (!recognized) omitted.add("unknown-kind");
  if (Object.keys(event).some((key) => !kept.has(key)))
    omitted.add("unknown-fields");
  if (omitted.size)
    result.omitted = TRACE_OMISSIONS.filter((marker) => omitted.has(marker));
  return parseTraceEvent(result);
}
