/**
 * Evaluates a project's `song.ts` and parses the result from `unknown` into
 * a validated `TrackScore`.
 *
 * Song source runs in the sealed engine of `sandbox.ts`: TypeScript is
 * transpiled on the host without running it and executed in QuickJS
 * compiled to WebAssembly, with no file, network, process, clock or ambient
 * randomness, and imports limited to `dawn` and relative files inside the
 * project. A fresh engine instance serves each evaluation.
 *
 * The engine lives in one Bun subprocess per DAWN process (`eval-child.ts`),
 * started on first use and reused, so evaluations after the first skip the
 * start-up and engine compilation. The subprocess has a scrubbed
 * environment, DAWN's own directory as its working directory (so a
 * project's `bunfig.toml` or `.env` is never read), no native addons or
 * auto-install. Each evaluation has a 10 second budget and a 32 MiB output
 * bound; past either the subprocess is killed and the next evaluation starts
 * a new one, so not even a fault in the engine can hang DAWN or take its
 * window down. Evaluations run one at a time, in call order.
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Subprocess } from "bun";
import { decodeLoopDocument } from "../loop.ts";
import { refreshRhythm } from "../rhythm.ts";
import { ScoreValidationError, TrackScore } from "../score.ts";

export const EVAL_TIMEOUT_MS = 10_000;
/**
 * Above the JSON of the largest score `SCORE_LIMITS` allows (64 tracks with
 * every automation lane full plus 4096 notes stays well under 16 MiB).
 */
export const EVAL_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
/** An idle evaluation subprocess exits after this long without work. */
export const EVAL_IDLE_MS = 30_000;

/** A problem in a project file; `file` is project-relative when known. */
export type Diagnostic = Readonly<{
  message: string;
  file?: string;
  line?: number;
  col?: number;
}>;

export type EvalResult =
  | Readonly<{ ok: true; score: TrackScore; ms: number }>
  | Readonly<{ ok: false; diagnostics: readonly Diagnostic[]; ms: number }>;

export type EvalOptions = Readonly<{
  /** A file of the project to evaluate in place of `song.ts`. */
  entry?: string;
  timeoutMs?: number;
}>;

const CHILD = join(dirname(fileURLToPath(import.meta.url)), "eval-child.ts");
/** Process start-up and engine load come out of the budget before song code runs. */
const ENGINE_MARGIN_MS = 1_000;
/** Standard error kept from the subprocess for a crash report. */
const STDERR_TAIL_BYTES = 8 * 1024;

/** One evaluation's outcome as the subprocess reported it. */
type Reply =
  | { kind: "line"; line: string }
  | { kind: "timeout" }
  | { kind: "output" }
  | { kind: "exit"; code: number; stderr: string };

/** The running evaluation subprocess and the one request it is serving. */
type Server = {
  child: Subprocess<"pipe", "pipe", "pipe">;
  waiting?: (reply: Reply) => void;
  stderr: string;
  idle?: ReturnType<typeof setTimeout>;
};

let server: Server | undefined;
/** Evaluations queue behind each other: the subprocess serves one at a time. */
let queue: Promise<unknown> = Promise.resolve();

/** Evaluates `<project>/song.ts`; never throws for project errors. */
export function evaluateProject(
  project: string,
  options: EvalOptions = {},
): Promise<EvalResult> {
  const run = queue.then(() => evaluateNow(project, options));
  queue = run.catch(() => undefined);
  return run;
}

async function evaluateNow(
  project: string,
  options: EvalOptions,
): Promise<EvalResult> {
  const started = performance.now();
  const timeoutMs = options.timeoutMs ?? EVAL_TIMEOUT_MS;
  let current: Server;
  try {
    current = server ?? start();
  } catch (error) {
    return failure(started, [
      { message: `could not start bun: ${text(error)}` },
    ]);
  }
  if (current.idle) clearTimeout(current.idle);
  const request = {
    project: resolve(project),
    // The engine stops song code itself a little before the budget runs
    // out, so a runaway loop reports where it was.
    budget: timeoutMs - Math.min(ENGINE_MARGIN_MS, timeoutMs / 2),
    ...(options.entry === undefined ? {} : { entry: options.entry }),
  };
  const reply = await new Promise<Reply>((settle) => {
    const timer = setTimeout(() => finish({ kind: "timeout" }), timeoutMs);
    function finish(value: Reply) {
      clearTimeout(timer);
      current.waiting = undefined;
      settle(value);
    }
    current.waiting = finish;
    try {
      current.child.stdin.write(`${JSON.stringify(request)}\n`);
      current.child.stdin.flush();
    } catch {
      // A subprocess that died between requests reports through `exited`.
    }
  });
  if (reply.kind !== "line") stop(current);
  else {
    const idle = setTimeout(() => stop(current), EVAL_IDLE_MS);
    idle.unref();
    current.idle = idle;
  }
  if (reply.kind === "output")
    return failure(started, [
      {
        file: "song.ts",
        message: `evaluation printed more than ${EVAL_MAX_OUTPUT_BYTES / (1024 * 1024)} MiB`,
      },
    ]);
  if (reply.kind === "timeout")
    return failure(started, [
      {
        file: "song.ts",
        message: `evaluation timed out (${Math.round(timeoutMs / 1000)} s); song.ts must be pure`,
      },
    ]);
  if (reply.kind === "exit") {
    const detail = reply.stderr.trim().split("\n").slice(0, 8).join("\n");
    return failure(started, [
      {
        file: "song.ts",
        message: detail
          ? `evaluation exited with code ${reply.code}: ${detail}`
          : `evaluation exited with code ${reply.code}`,
      },
    ]);
  }
  return parseChildOutput(reply.line, started);
}

/** Starts the evaluation subprocess with nothing of DAWN's environment. */
function start(): Server {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "TMPDIR"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env.NO_COLOR = "1";
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-addons",
      "--no-install",
      "--no-env-file",
      "--smol",
      CHILD,
    ],
    {
      // Never a project: Bun reads `bunfig.toml` (whose `preload` runs
      // code) and `.env` from its working directory.
      cwd: dirname(CHILD),
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  // An idle subprocess never keeps DAWN running; a pending evaluation's
  // timer does until it answers.
  child.unref();
  const current: Server = { child, stderr: "" };
  server = current;
  void readLines(current);
  void readStderr(current);
  void child.exited.then((code) => {
    if (server === current) server = undefined;
    current.waiting?.({ kind: "exit", code, stderr: current.stderr });
  });
  return current;
}

function stop(current: Server): void {
  if (current.idle) clearTimeout(current.idle);
  if (server === current) server = undefined;
  current.waiting = undefined;
  current.child.kill();
}

/** Hands each line the subprocess prints to the request waiting for it. */
async function readLines(current: Server): Promise<void> {
  const decoder = new TextDecoder();
  let pending = "";
  try {
    for await (const chunk of current.child.stdout) {
      pending += decoder.decode(chunk, { stream: true });
      for (;;) {
        const end = pending.indexOf("\n");
        if (end < 0) break;
        const line = pending.slice(0, end).trim();
        pending = pending.slice(end + 1);
        if (line.startsWith('{"ok":'))
          current.waiting?.({ kind: "line", line });
      }
      if (pending.length > EVAL_MAX_OUTPUT_BYTES) {
        pending = "";
        current.waiting?.({ kind: "output" });
      }
    }
  } catch {
    // The stream ends with the subprocess; `exited` reports why.
  }
}

async function readStderr(current: Server): Promise<void> {
  const decoder = new TextDecoder();
  try {
    for await (const chunk of current.child.stderr) {
      current.stderr = (
        current.stderr + decoder.decode(chunk, { stream: true })
      ).slice(-STDERR_TAIL_BYTES);
    }
  } catch {
    // Ends with the subprocess.
  }
}

/** Parses the child's JSON line from `unknown`; exported for tests. */
export function parseChildOutput(
  line: string,
  started = performance.now(),
): EvalResult {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return failure(started, [
      { file: "song.ts", message: "evaluation printed invalid JSON" },
    ]);
  }
  if (typeof value !== "object" || value === null)
    return failure(started, [
      { file: "song.ts", message: "evaluation printed no result" },
    ]);
  const record = value as Record<string, unknown>;
  if (record.ok !== true) {
    const error =
      typeof record.error === "object" && record.error !== null
        ? (record.error as Record<string, unknown>)
        : {};
    const diagnostic: {
      message: string;
      file?: string;
      line?: number;
      col?: number;
    } = {
      message:
        typeof error.message === "string" && error.message.length > 0
          ? error.message.slice(0, 2000)
          : "song.ts threw",
    };
    if (typeof error.file === "string")
      diagnostic.file = error.file.slice(0, 512);
    if (typeof error.line === "number" && Number.isInteger(error.line))
      diagnostic.line = error.line;
    if (typeof error.col === "number" && Number.isInteger(error.col))
      diagnostic.col = error.col;
    return failure(started, [diagnostic]);
  }
  try {
    // Rhythm rows are generators: their lanes are expanded here, on the
    // host, so `song.ts` stores parameters and the score stores notes.
    const score = refreshRhythm(decodeLoopDocument(record.score));
    return { ok: true, score, ms: elapsed(started) };
  } catch (error) {
    return failure(started, [
      {
        file: "song.ts",
        message:
          error instanceof ScoreValidationError
            ? `invalid score: ${error.message}`
            : `invalid score: ${text(error)}`,
      },
    ]);
  }
}

/** `file:line:col message` for humans; file-less diagnostics print the message alone. */
export function formatDiagnostic(diagnostic: Diagnostic): string {
  if (!diagnostic.file) return diagnostic.message;
  const where =
    diagnostic.line === undefined
      ? diagnostic.file
      : `${diagnostic.file}:${diagnostic.line}:${diagnostic.col ?? 1}`;
  return `${where} ${diagnostic.message}`;
}

function failure(
  started: number,
  diagnostics: readonly Diagnostic[],
): EvalResult {
  return {
    ok: false,
    diagnostics: Object.freeze(diagnostics.map((d) => Object.freeze({ ...d }))),
    ms: elapsed(started),
  };
}

function elapsed(started: number): number {
  return Math.round(performance.now() - started);
}

function text(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
