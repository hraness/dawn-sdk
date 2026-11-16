/**
 * The sealed evaluator for song source. `song.ts`, its track files and any
 * other project module are transpiled from TypeScript to JavaScript on the
 * host (`Bun.Transpiler` with macros disabled, so nothing runs at that
 * step) and executed in a QuickJS engine compiled to WebAssembly.
 *
 * Inside the engine there is no file, network, process, clock or ambient
 * randomness: the global object holds the standard JavaScript built-ins
 * only, `Date` and `Math.random` throw, and the one module that is not a
 * project file is `dawn`, the vendored SDK. Imports resolve on the host:
 * `dawn`, or a relative path that still lies inside the project after its
 * symlinks are followed. Everything else is refused with a diagnostic
 * naming the importing file and line.
 *
 * Each evaluation gets a fresh engine runtime with a memory limit, a stack
 * limit and a wall-time deadline checked by the engine's interrupt hook, so
 * a hostile or runaway song ends with a diagnostic instead of hanging or
 * exhausting the host. The engine's arithmetic is the same WebAssembly on
 * every platform, so the same source gives the same score everywhere.
 *
 * Sample hashes and Scala tuning files are filled in afterwards by the
 * caller (`eval-child.ts`), on the host, from the plain score this returns.
 */

import variant from "@jitl/quickjs-wasmfile-release-sync";
import {
  newQuickJSWASMModuleFromVariant,
  newVariant,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSWASMModule,
} from "quickjs-emscripten-core";
import { readFileSync, realpathSync, statSync } from "node:fs";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  posix,
  relative,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { mapPosition } from "./sandbox-positions.ts";

/**
 * The engine's heap. The largest score `SCORE_LIMITS` allows evaluates in
 * well under this; a song that allocates without bound stops here with a
 * diagnostic instead of taking the host's memory.
 */
export const SANDBOX_MEMORY_BYTES = 256 * 1024 * 1024;
/**
 * The engine's own stack bound, below the WebAssembly stack so unbounded
 * recursion is a catchable `RangeError` rather than a trap.
 */
export const SANDBOX_STACK_BYTES = 1024 * 1024;
/**
 * Wall time for one evaluation, checked by the engine's interrupt hook
 * (QuickJS calls it every few thousand instructions), so an endless loop
 * stops with the position it was in. `evaluateProject` passes its own
 * budget; this is the default.
 */
export const SANDBOX_TIME_MS = 10_000;
/** One module's source: the largest printed track file is far below it. */
export const SANDBOX_MAX_MODULE_BYTES = 16 * 1024 * 1024;
/** Every module of one evaluation together. */
export const SANDBOX_MAX_SOURCE_BYTES = 64 * 1024 * 1024;
/** Distinct modules one evaluation may load. */
export const SANDBOX_MAX_MODULES = 1024;
/**
 * The JSON answer of one evaluation; the same bound as `eval.ts`'s
 * `EVAL_MAX_OUTPUT_BYTES`, above the largest score `SCORE_LIMITS` allows.
 */
export const SANDBOX_MAX_RESULT_BYTES = 32 * 1024 * 1024;

/** Where `import ... from "dawn"` resolves inside a project. */
export const VENDORED_SDK = ".dawn/sdk/v1.ts";
/** The SDK this runtime ships, used when a project has no vendored copy. */
const SHIPPED_SDK = join(dirname(fileURLToPath(import.meta.url)), "v1.ts");

/** A problem in a project file; `file` is project-relative when known. */
export type SandboxDiagnostic = {
  message: string;
  file?: string;
  line?: number;
  col?: number;
};

export type SandboxResult =
  | { ok: true; /** The default export, as JSON text. */ json: string }
  | { ok: false; error: SandboxDiagnostic };

export type SandboxOptions = {
  /** Wall-time budget in milliseconds (default `SANDBOX_TIME_MS`). */
  timeMs?: number;
  memoryBytes?: number;
  /**
   * The modules by root-relative `/`-separated name, read by the host
   * beforehand (a composer plug-in, `core/composer-plugin.ts`). With it the
   * evaluation reads no file at all: imports resolve against these names
   * only, and `dawn` is always the SDK this runtime ships.
   */
  sources?: ReadonlyMap<string, string>;
  /**
   * JSON text of one argument: the default export must then be a function,
   * which is called with the parsed value (inside the engine, by the
   * intrinsic `JSON.parse`), and its return value is the result.
   */
  call?: string;
  /** What the entry is, for messages: `song` (default) or `composer`. */
  what?: "song" | "composer";
};

/**
 * Module source after transpiling: `js` runs in the engine, `ts` is kept to
 * map positions in a runtime error back to what the author wrote.
 */
type LoadedModule = { name: string; ts: string; js: string };

const EXTENSIONS = [".ts", ".mts", ".js", ".mjs"] as const;
/** How each importable extension becomes engine JavaScript. */
const LOADERS: Readonly<Record<string, "ts" | "js" | "json">> = {
  ".ts": "ts",
  ".mts": "ts",
  ".js": "js",
  ".mjs": "js",
  // Data: importing a `.json` file gives its parsed value.
  ".json": "json",
};

/**
 * Standard ECMAScript globals the engine may keep. Anything else the engine
 * adds (QuickJS-ng's `performance`, `queueMicrotask`, `DOMException`, the
 * garbage-collector-observing `WeakRef` and `FinalizationRegistry`) is
 * removed before song code runs.
 */
const ALLOWED_GLOBALS = new Set([
  "AggregateError",
  "Array",
  "ArrayBuffer",
  "BigInt",
  "BigInt64Array",
  "BigUint64Array",
  "Boolean",
  "DataView",
  "Date",
  "Error",
  "EvalError",
  "Float16Array",
  "Float32Array",
  "Float64Array",
  "Function",
  "Infinity",
  "Int16Array",
  "Int32Array",
  "Int8Array",
  "InternalError",
  "Iterator",
  "JSON",
  "Map",
  "Math",
  "NaN",
  "Number",
  "Object",
  "Promise",
  "Proxy",
  "RangeError",
  "ReferenceError",
  "Reflect",
  "RegExp",
  "Set",
  "String",
  "Symbol",
  "SyntaxError",
  "TypeError",
  "URIError",
  "Uint16Array",
  "Uint32Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "WeakMap",
  "WeakSet",
  "decodeURI",
  "decodeURIComponent",
  "encodeURI",
  "encodeURIComponent",
  "escape",
  "eval",
  "globalThis",
  "isFinite",
  "isNaN",
  "parseFloat",
  "parseInt",
  "undefined",
  "unescape",
]);

/**
 * Runs before any project code: removes non-standard globals, replaces the
 * clock and ambient randomness with functions that explain themselves, and
 * returns the intrinsic `JSON.stringify` and `JSON.parse` so a song or a
 * composer that reassigns them cannot change how its argument is made or
 * its result is read.
 */
const PRELUDE = `(() => {
  const allowed = new Set(${JSON.stringify([...ALLOWED_GLOBALS])});
  for (const key of Reflect.ownKeys(globalThis))
    if (typeof key !== "string" || !allowed.has(key)) delete globalThis[key];
  const refuse = (what, instead) => function () {
    throw new Error(what + " is not available in song source: it has no clock or ambient randomness" + instead);
  };
  const NoDate = refuse("Date", "; write times in beats");
  NoDate.now = refuse("Date.now", "; write times in beats");
  NoDate.parse = refuse("Date.parse", "");
  NoDate.UTC = refuse("Date.UTC", "");
  Object.defineProperty(globalThis, "Date", { value: NoDate, writable: true, configurable: true });
  Object.defineProperty(Math, "random", {
    value: refuse("Math.random", "; pass a seed (euclid, humanize and feel take one) or write a seeded generator"),
    writable: true,
    configurable: true,
  });
  const stringify = JSON.stringify;
  const parse = JSON.parse;
  return [
    (value) =>
      typeof value === "object" && value !== null ? stringify(value) : undefined,
    (text) => parse(text),
  ];
})()`;

let compiled: WebAssembly.Module | undefined;
/**
 * A fresh engine instance (its own WebAssembly memory) for one evaluation,
 * so nothing a song does, even to the engine's own heap, outlives it. The
 * compiled module is shared, so only the first evaluation in a process
 * pays for compiling it.
 */
function engine(): Promise<QuickJSWASMModule> {
  compiled ??= new WebAssembly.Module(
    readFileSync(
      fileURLToPath(
        import.meta.resolve("@jitl/quickjs-wasmfile-release-sync/wasm"),
      ),
    ),
  );
  return newQuickJSWASMModuleFromVariant(
    newVariant(variant, { wasmModule: compiled }),
  );
}

/**
 * Bun runs an import marked `with { type: "macro" }` while it transpiles,
 * with full authority. `macro: false` turns macros off ("Macros are
 * disabled"); Bun's types name only the map form, hence the cast.
 */
const NO_MACROS = false as unknown as Bun.MacroMap;

/**
 * The transpiler never runs code: macros are disabled, and no tsconfig,
 * package.json or bunfig is consulted.
 */
const transpilers = {
  ts: new Bun.Transpiler({ loader: "ts", target: "browser", macro: NO_MACROS }),
  js: new Bun.Transpiler({ loader: "js", target: "browser", macro: NO_MACROS }),
} as const;

let shippedSdk: LoadedModule | undefined;
/** Transpiled vendored SDKs by source text. */
const sdkCache = new Map<string, string>();

/** Host-side error carrying a diagnostic; never crosses into the engine. */
class Refusal extends Error {
  constructor(readonly diagnostic: SandboxDiagnostic) {
    super(diagnostic.message);
  }
}

/**
 * Evaluates `entry` (project-relative, default `song.ts`) of `project` in a
 * fresh sealed engine and returns its default export as JSON text.
 */
export async function evaluateSandboxed(
  project: string,
  entry = "song.ts",
  options: SandboxOptions = {},
): Promise<SandboxResult> {
  const sources = options.sources;
  const what = options.what ?? "song";
  let root: string;
  try {
    // In-memory sources name no folder: nothing below reads the disk.
    root = sources ? "/" : realpathSync(project);
  } catch (error) {
    return failure({ message: `cannot read project: ${text(error)}` });
  }
  const modules = new Map<string, LoadedModule>();
  let sourceBytes = 0;
  /** What the host refused: each explains the engine error it caused. */
  const refusals: SandboxDiagnostic[] = [];
  const refuse = (diagnostic: SandboxDiagnostic): never => {
    refusals.push(diagnostic);
    throw new Refusal(diagnostic);
  };

  const vendored = sources ? undefined : vendoredSdk(root);
  /** Names `resolveImport` produced: the only ones `load` will read. */
  const resolved = new Set<string>(["dawn"]);
  const load = (name: string): LoadedModule => {
    const known = modules.get(name);
    if (known) return known;
    // After a refused import the engine still asks for a module (with an
    // empty name); answer with that refusal and read nothing.
    if (!resolved.has(name))
      throw new Error(refusals.at(-1)?.message ?? `no module "${name}"`);
    if (modules.size >= SANDBOX_MAX_MODULES)
      refuse({
        file: name,
        message: `${what} source loads more than ${SANDBOX_MAX_MODULES} modules`,
      });
    let module: LoadedModule;
    if (name === "dawn" && vendored === undefined) module = sdkModule();
    else {
      const path = name === "dawn" ? vendored! : join(root, name);
      const display = name === "dawn" ? VENDORED_SDK : name;
      const source = sources
        ? memoryModule(sources, name, refuse)
        : readModule(root, path, display, refuse);
      sourceBytes += source.length;
      if (sourceBytes > SANDBOX_MAX_SOURCE_BYTES)
        refuse({
          file: display,
          message: `${what} source is larger than ${SANDBOX_MAX_SOURCE_BYTES / (1024 * 1024)} MiB`,
        });
      // The vendored SDK is the same 17,000 lines evaluation after
      // evaluation; its transpiled text is kept per source text.
      const cached = name === "dawn" ? sdkCache.get(source) : undefined;
      module = cached
        ? { name, ts: source, js: cached }
        : transpile(display, source, refuse);
      module.name = name;
      if (name === "dawn" && !cached) {
        if (sdkCache.size >= 4) sdkCache.clear();
        sdkCache.set(source, module.js);
      }
    }
    modules.set(name, module);
    return module;
  };

  const resolveImport = (base: string, specifier: string): string => {
    if (specifier === "dawn") return "dawn";
    const where = importPosition(modules.get(base)?.ts, specifier);
    const refused = (why: string): never =>
      refuse(
        base === ""
          ? { file: entry, message: `${entry} ${why}` }
          : {
              file: base === "dawn" ? (vendored ? VENDORED_SDK : "dawn") : base,
              ...where,
              message: `import "${specifier}" ${why}`,
            },
      );
    if (base === "dawn") refused("is not allowed: the SDK imports nothing");
    if (!specifier.startsWith("./") && !specifier.startsWith("../"))
      refused(
        `is not allowed: ${what} source may import only "dawn" and relative paths inside the ${sources ? "composer" : "project"}`,
      );
    if (sources) {
      // Names only: the map is the whole file system this evaluation has.
      const target = posix.normalize(
        posix.join(posix.dirname(base), specifier),
      );
      if (target === ".." || target.startsWith("../") || target.startsWith("/"))
        refused("resolves outside the composer");
      const name = [...candidates(target, posix.join)].find((c) =>
        sources.has(c),
      );
      if (name === undefined) return refused("does not resolve to a file");
      if (!(extname(name) in LOADERS))
        refused("is not a .ts, .js or .json module");
      resolved.add(name);
      return name;
    }
    const target = join(root, dirname(base), specifier);
    let real: string | undefined;
    for (const candidate of candidates(target)) {
      try {
        if (!statSync(candidate).isFile()) continue;
        real = realpathSync(candidate);
        break;
      } catch {
        // Try the next spelling.
      }
    }
    if (real === undefined) return refused("does not resolve to a file");
    const rel = relative(root, real);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel))
      refused("resolves outside the project");
    if (vendored !== undefined && real === vendored) return "dawn";
    if (!(extname(real) in LOADERS))
      refused("is not a .ts, .js or .json module");
    const name = rel.split(sep).join("/");
    resolved.add(name);
    return name;
  };

  let QuickJS: QuickJSWASMModule;
  try {
    QuickJS = await engine();
  } catch (error) {
    return failure({
      message: `could not start the song engine: ${text(error)}`,
    });
  }
  let entryName: string;
  try {
    // Resolved from the project root as if imported there, so the entry
    // obeys the same rules as every import.
    entryName = resolveImport("", `./${entry}`);
  } catch {
    return failure(
      refusals[0] ?? { file: entry, message: `cannot evaluate ${entry}` },
    );
  }
  if (entryName === "dawn")
    return failure({
      file: entry,
      message: `${entry} is the SDK, not a ${what}`,
    });
  const budget = options.timeMs ?? SANDBOX_TIME_MS;
  const memory = options.memoryBytes ?? SANDBOX_MEMORY_BYTES;
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(memory);
  runtime.setMaxStackSize(SANDBOX_STACK_BYTES);
  const deadline = performance.now() + budget;
  let interrupted = false;
  runtime.setInterruptHandler(() => {
    if (performance.now() <= deadline) return false;
    interrupted = true;
    return true;
  });
  runtime.setModuleLoader(
    (name) => {
      try {
        return load(name).js;
      } catch (error) {
        return {
          error: error instanceof Error ? error : new Error(text(error)),
        };
      }
    },
    (base, requested) => {
      try {
        return resolveImport(base, requested);
      } catch (error) {
        return {
          error: error instanceof Error ? error : new Error(text(error)),
        };
      }
    },
  );
  const context = runtime.newContext();
  try {
    const result = run(
      context,
      entryName,
      load,
      memory,
      () => interrupted,
      options.call,
      what,
    );
    if (result.ok) return result;
    // An import the host refused surfaces in the engine as an error with
    // the refusal's message; the refusal knows the file and line.
    const refused = refusals.find((r) =>
      result.error.message.includes(r.message),
    );
    if (refused) return failure(refused);
    if (interrupted)
      return failure({
        ...locate(result.error, modules, entryName),
        message: `evaluation timed out (${budget < 1000 ? `${budget} ms` : `${Math.round(budget / 1000)} s`}); ${what} source must be pure and finite`,
      });
    return failure(locate(result.error, modules, entryName));
  } catch (error) {
    return failure(refusals[0] ?? { file: entry, message: text(error) });
  } finally {
    try {
      context.dispose();
      runtime.dispose();
    } catch {
      // A runtime stopped mid-allocation may not release cleanly; the
      // engine instance is discarded with it either way.
    }
  }
}

type RunFailure = { ok: false; error: SandboxDiagnostic & { stack?: string } };

/**
 * Evaluates the entry module and reads its default export as JSON text; with
 * `call`, calls the default export with that JSON argument and reads what it
 * returns.
 */
function run(
  context: QuickJSContext,
  entry: string,
  load: (name: string) => LoadedModule,
  memory: number,
  stopped: () => boolean,
  call: string | undefined,
  what: "song" | "composer",
): SandboxResult | RunFailure {
  const runtime = context.runtime;
  const fail = (handle: QuickJSHandle): RunFailure =>
    thrown(context, handle, memory, what);
  const prelude = context.evalCode(PRELUDE, "dawn:prelude", {
    type: "global",
  });
  if (prelude.error) return fail(prelude.error);
  using intrinsics = prelude.value;
  using stringify = context.getProp(intrinsics, 0);
  using parse = context.getProp(intrinsics, 1);
  let entryModule: LoadedModule;
  try {
    entryModule = load(entry);
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, error: error.diagnostic };
    throw error;
  }
  /**
   * The value a promise settles to after the engine's pending jobs run (a
   * top-level await, or a composer that returns a promise); a value that is
   * not a promise is itself. Takes ownership of `handle`.
   */
  const settle = (
    handle: QuickJSHandle,
    waiting: string,
  ): { value: QuickJSHandle } | { failure: RunFailure } => {
    const first = context.getPromiseState(handle);
    if (first.type === "fulfilled" && first.notAPromise === true)
      return { value: handle };
    if (first.type === "fulfilled") first.value.dispose();
    else if (first.type === "rejected") first.error.dispose();
    for (;;) {
      const jobs = runtime.executePendingJobs();
      if (jobs.error) {
        handle.dispose();
        return { failure: fail(jobs.error) };
      }
      if (jobs.value === 0 || stopped()) break;
    }
    const settled = context.getPromiseState(handle);
    handle.dispose();
    if (settled.type === "rejected") return { failure: fail(settled.error) };
    if (settled.type === "pending")
      return {
        failure: {
          ok: false,
          error: {
            file: entry,
            message: `${entry} never finished: ${waiting}`,
          },
        },
      };
    return { value: settled.value };
  };
  const evaluated = context.evalCode(entryModule.js, entry, { type: "module" });
  if (evaluated.error) return fail(evaluated.error);
  // A module evaluates to its namespace, or to a promise of it when it (or
  // a module it imports) awaits at the top level.
  const module = settle(evaluated.value, "a top-level await is still waiting");
  if ("failure" in module) return module.failure;
  let result = context.getProp(module.value, "default");
  module.value.dispose();
  if (call !== undefined) {
    if (context.typeof(result) !== "function") {
      result.dispose();
      return {
        ok: false,
        error: {
          file: entry,
          message: `${entry} must \`export default composer((brief) => ...)\``,
        },
      };
    }
    const argument = context.newString(call);
    const parsed = context.callFunction(parse, context.undefined, argument);
    argument.dispose();
    if (parsed.error) {
      result.dispose();
      return fail(parsed.error);
    }
    const called = context.callFunction(
      result,
      context.undefined,
      parsed.value,
    );
    parsed.value.dispose();
    result.dispose();
    if (called.error) return fail(called.error);
    const returned = settle(
      called.value,
      "the promise it returned never settled",
    );
    if ("failure" in returned) return returned.failure;
    result = returned.value;
  }
  const json = context.callFunction(stringify, context.undefined, result);
  result.dispose();
  if (json.error) return fail(json.error);
  using text = json.value;
  if (context.typeof(text) !== "string")
    return {
      ok: false,
      error: {
        file: entry,
        message:
          what === "composer"
            ? `${entry}: the composer must return a composition object`
            : `${entry} must \`export default song({...})\``,
      },
    };
  return { ok: true, json: context.getString(text) };
}

/** Reads an engine exception into a message and its stack. */
function thrown(
  context: QuickJSContext,
  handle: QuickJSHandle,
  memory: number,
  what: "song" | "composer",
): RunFailure {
  let value: unknown;
  try {
    value = context.dump(handle);
  } catch {
    value = undefined;
  } finally {
    handle.dispose();
  }
  const record =
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : { message: String(value) };
  const message =
    typeof record.message === "string" ? record.message : String(value);
  const out: RunFailure["error"] = {
    message:
      record.name === "InternalError" && /out of memory/i.test(message)
        ? `evaluation ran out of memory (limit ${memory / (1024 * 1024)} MiB); ${what} source must be finite`
        : message,
  };
  if (typeof record.stack === "string") out.stack = record.stack;
  return { ok: false, error: out };
}

/**
 * The first stack frame in a project file (not the SDK), mapped from the
 * transpiled JavaScript back to the TypeScript the author wrote.
 */
function locate(
  error: SandboxDiagnostic & { stack?: string },
  modules: ReadonlyMap<string, LoadedModule>,
  entry: string,
): SandboxDiagnostic {
  const out: SandboxDiagnostic = { message: error.message };
  for (const line of (error.stack ?? "").split("\n")) {
    const match = line.match(/\(?([^\s()]+):(\d+):(\d+)\)?\s*$/);
    if (!match) continue;
    const name = match[1]!;
    if (name === "dawn" || name.startsWith("dawn:")) continue;
    const module = modules.get(name);
    if (!module) continue;
    const mapped = mapPosition(module.js, module.ts, {
      line: Number(match[2]),
      col: Number(match[3]),
    });
    out.file = name;
    if (mapped) {
      out.line = mapped.line;
      out.col = mapped.col;
    }
    return out;
  }
  if (error.file) return { ...out, file: error.file };
  return { ...out, file: entry };
}

function sdkModule(): LoadedModule {
  if (!shippedSdk) {
    const ts = readFileSync(SHIPPED_SDK, "utf8");
    shippedSdk = {
      name: "dawn",
      ts,
      js: transpilers.ts.transformSync(ts),
    };
  }
  return shippedSdk;
}

/** The project's vendored SDK when it is a regular file inside the project. */
function vendoredSdk(root: string): string | undefined {
  const path = join(root, VENDORED_SDK);
  try {
    if (!statSync(path).isFile()) return undefined;
    const real = realpathSync(path);
    const rel = relative(root, real);
    if (rel.startsWith("..") || isAbsolute(rel)) return undefined;
    return real;
  } catch {
    return undefined;
  }
}

function* candidates(
  target: string,
  joinPath: (a: string, b: string) => string = join,
): Generator<string> {
  yield target;
  for (const extension of EXTENSIONS) yield `${target}${extension}`;
  for (const extension of EXTENSIONS)
    yield joinPath(target, `index${extension}`);
}

/** A module of in-memory sources, held to the same size bound as a file. */
function memoryModule(
  sources: ReadonlyMap<string, string>,
  name: string,
  refuse: (diagnostic: SandboxDiagnostic) => never,
): string {
  const source = sources.get(name);
  if (source === undefined)
    return refuse({ file: name, message: `${name} is not a composer file` });
  if (source.length > SANDBOX_MAX_MODULE_BYTES)
    refuse({
      file: name,
      message: `${name} is not a file under ${SANDBOX_MAX_MODULE_BYTES / (1024 * 1024)} MiB`,
    });
  return source;
}

/**
 * Reads a module the resolver admitted, checking again that it is a file
 * inside the project, in case a link changed since it was resolved.
 */
function readModule(
  root: string,
  path: string,
  display: string,
  refuse: (diagnostic: SandboxDiagnostic) => never,
): string {
  try {
    const real = realpathSync(path);
    const rel = relative(root, real);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel))
      refuse({
        file: display,
        message: `${display} resolves outside the project`,
      });
    const info = statSync(real);
    if (!info.isFile() || info.size > SANDBOX_MAX_MODULE_BYTES)
      refuse({
        file: display,
        message: `${display} is not a file under ${SANDBOX_MAX_MODULE_BYTES / (1024 * 1024)} MiB`,
      });
    return readFileSync(real, "utf8");
  } catch (error) {
    if (error instanceof Refusal) throw error;
    return refuse({
      file: display,
      message: `cannot read ${display}: ${text(error)}`,
    });
  }
}

function transpile(
  display: string,
  ts: string,
  refuse: (diagnostic: SandboxDiagnostic) => never,
): LoadedModule {
  const loader = LOADERS[extname(display)] ?? "ts";
  if (loader === "json") {
    let value: unknown;
    try {
      value = JSON.parse(ts);
    } catch (error) {
      return refuse({
        file: display,
        message: `${display} is not valid JSON: ${text(error)}`,
      });
    }
    return {
      name: display,
      ts,
      js: `export default ${JSON.stringify(value)};\n`,
    };
  }
  try {
    return { name: display, ts, js: transpilers[loader].transformSync(ts) };
  } catch (error) {
    return refuse(buildDiagnostic(error, display));
  }
}

/** Bun's build errors carry a position; an AggregateError wraps several. */
function buildDiagnostic(error: unknown, file: string): SandboxDiagnostic {
  let record =
    typeof error === "object" && error !== null
      ? (error as Record<string, unknown>)
      : {};
  if (Array.isArray(record.errors) && record.errors.length > 0) {
    const first: unknown = record.errors[0];
    if (typeof first === "object" && first !== null)
      record = first as Record<string, unknown>;
  }
  const out: SandboxDiagnostic = {
    file,
    message: typeof record.message === "string" ? record.message : text(error),
  };
  const position = record.position as Record<string, unknown> | undefined;
  if (position && typeof position.line === "number") {
    out.line = position.line;
    if (typeof position.column === "number") out.col = position.column + 1;
  }
  return out;
}

/** Where `specifier` is first written as a quoted string in `source`. */
function importPosition(
  source: string | undefined,
  specifier: string,
): { line?: number; col?: number } {
  if (source === undefined) return {};
  for (const quote of ['"', "'", "`"]) {
    const index = source.indexOf(`${quote}${specifier}${quote}`);
    if (index < 0) continue;
    const before = source.slice(0, index);
    const line = before.split("\n").length;
    return { line, col: index - before.lastIndexOf("\n") };
  }
  return {};
}

function failure(error: SandboxDiagnostic): SandboxResult {
  return { ok: false, error };
}

function text(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
