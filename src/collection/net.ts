/**
 * Bounded HTTPS transfers for collection installs. Every hop of a redirect is
 * validated, bodies are streamed under a byte budget and an idle and total
 * deadline, and a provider token is attached only to the provider's own API
 * host, never to a redirect target or any other host.
 */
import { createHash } from "node:crypto";
import { contentProblem, TRANSFER_LIMITS } from "./policy.ts";

export type NetConfig = Readonly<{
  /** GitHub's REST API, `https://api.github.com`. */
  githubApi: string;
  /** Commit-addressed raw files, `https://raw.githubusercontent.com`. */
  githubRaw: string;
  /** Tests only: permit plain HTTP to 127.0.0.1. Never set by the CLI. */
  allowLoopback?: boolean;
}>;
export const GITHUB: NetConfig = Object.freeze({
  githubApi: "https://api.github.com",
  githubRaw: "https://raw.githubusercontent.com",
});

export class OfflineError extends Error {}

export type Session = {
  readonly config: NetConfig;
  readonly offline: boolean;
  readonly deadline: number;
  /** A provider token for `config.githubApi` only. */
  readonly token?: string;
  /**
   * The `owner/repo` (lowercase) repositories the user named on the command
   * line; the token is used for these only, never for one a catalog names.
   */
  readonly tokenRepos: Set<string>;
  /** Hosts contacted, for the plan and the report. */
  readonly hosts: Set<string>;
  resolutions: number;
  bytes: number;
  readonly maxBytes: number;
};

export function newSession(
  options: Readonly<{
    config?: NetConfig;
    offline?: boolean;
    token?: string;
    timeoutMs?: number;
    maxBytes?: number;
  }>,
): Session {
  return {
    config: options.config ?? GITHUB,
    offline: options.offline ?? false,
    deadline: Date.now() + (options.timeoutMs ?? TRANSFER_LIMITS.totalMs),
    ...(options.token ? { token: options.token } : {}),
    tokenRepos: new Set(),
    hosts: new Set(),
    resolutions: 0,
    bytes: 0,
    maxBytes: options.maxBytes ?? TRANSFER_LIMITS.totalBytes,
  };
}

function privateAddress(name: string): boolean {
  const host = name.replace(/\.$/, "");
  if (host.startsWith("[")) return true;
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b < 128) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b < 32) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && (Number(v4[3]) === 0 || Number(v4[3]) === 2)) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && Number(v4[3]) === 100) ||
      (a === 203 && b === 0 && Number(v4[3]) === 113)
    );
  }
  return (
    host === "localhost" ||
    /\.(localhost|local|internal|home\.arpa)$/.test(host) ||
    !host.includes(".")
  );
}

/** The URL a request may go to, or an error naming why it may not. */
export function checkUrl(raw: string, config: NetConfig): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("not a URL");
  }
  const loopback =
    config.allowLoopback === true &&
    url.protocol === "http:" &&
    url.hostname === "127.0.0.1";
  if (!loopback) {
    if (url.protocol !== "https:")
      throw new Error(
        `${url.protocol.replace(":", "")} URLs are refused; use HTTPS`,
      );
    if (privateAddress(url.hostname.toLowerCase()))
      throw new Error(`${url.hostname} is a local or private address`);
  }
  if (url.username || url.password)
    throw new Error("URLs with credentials are refused");
  return url;
}

/** A URL with its query removed, for messages. */
export const shown = (url: URL) => `${url.origin}${url.pathname}`;

export type Fetched = { sha256: string; bytes: number };
export type FetchOptions = Readonly<{
  label: string;
  accept?: string;
  /** Upper bound for this body. */
  maxBytes: number;
  expect?: Readonly<{ sha256?: string; bytes?: number }>;
  onChunk?: (chunk: Uint8Array) => void | Promise<void>;
  /** Send the provider token (to the API origin only). */
  auth?: boolean;
  /** Skip the LFS pointer and archive checks (for the catalog and API replies). */
  raw?: boolean;
}>;

/** Stream one file under the session's budgets. */
export async function fetchBounded(
  session: Session,
  start: string,
  options: FetchOptions,
): Promise<Fetched> {
  if (session.offline)
    throw new OfflineError(
      `${options.label} is not cached and --offline was given`,
    );
  const api = new URL(session.config.githubApi);
  let url = checkUrl(start, session.config);
  let response: Response | undefined;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = "";
  const arm = () => {
    if (timer) clearTimeout(timer);
    const left = session.deadline - Date.now();
    if (left <= 0) {
      timedOut = "the command's time budget ran out";
      controller.abort();
      return;
    }
    const idle = left < TRANSFER_LIMITS.idleMs;
    timer = setTimeout(
      () => {
        timedOut = idle
          ? "the command's time budget ran out"
          : `no data for ${TRANSFER_LIMITS.idleMs / 1000} s`;
        controller.abort();
      },
      Math.min(left, TRANSFER_LIMITS.idleMs),
    );
  };
  try {
    for (let hop = 0; ; hop++) {
      if (hop > TRANSFER_LIMITS.redirects)
        throw new Error(
          `${options.label}: more than ${TRANSFER_LIMITS.redirects} redirects`,
        );
      const headers: Record<string, string> = {
        "User-Agent": "dawn-collection",
        Accept: options.accept ?? "*/*",
      };
      // Credentials go only to the provider API origin itself.
      if (session.token && options.auth && url.origin === api.origin)
        headers.Authorization = `Bearer ${session.token}`;
      session.hosts.add(url.host);
      arm();
      try {
        response = await fetch(url.href, {
          headers,
          redirect: "manual",
          signal: controller.signal,
        });
      } catch (error) {
        throw new Error(
          `${options.label}: ${timedOut || `could not reach ${url.host}${error instanceof Error && error.message ? ` (${error.message.slice(0, 120)})` : ""}`}`,
        );
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel().catch(() => undefined);
        if (!location)
          throw new Error(`${options.label}: redirect without a location`);
        try {
          url = checkUrl(new URL(location, url).href, session.config);
        } catch (error) {
          throw new Error(
            `${options.label}: refused redirect: ${(error as Error).message}`,
          );
        }
        continue;
      }
      break;
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(
        `${options.label}: ${shown(url)} answered HTTP ${response.status}${response.status === 404 ? " (not found, or private: try --auth gh)" : ""}`,
      );
    }
    const max = Math.min(
      options.maxBytes,
      options.expect?.bytes ?? Infinity,
      session.maxBytes - session.bytes,
    );
    const declared = Number(response.headers.get("content-length"));
    if (response.headers.has("content-length") && Number.isFinite(declared)) {
      if (
        options.expect?.bytes !== undefined &&
        declared !== options.expect.bytes
      )
        throw new Error(
          `${options.label}: ${declared} bytes where ${options.expect.bytes} were declared`,
        );
      if (declared > max)
        throw new Error(
          `${options.label}: ${declared} bytes is over the ${max}-byte budget`,
        );
    }
    const hash = createHash("sha256");
    let bytes = 0;
    let head = Buffer.alloc(0);
    let checked = options.raw === true;
    const reader = response.body!.getReader();
    while (true) {
      arm();
      let next: { done: boolean; value?: Uint8Array };
      try {
        next = await reader.read();
      } catch {
        throw new Error(
          `${options.label}: ${timedOut || "the transfer failed"}`,
        );
      }
      if (next.done) break;
      const chunk = next.value!;
      bytes += chunk.length;
      if (bytes > max) {
        await reader.cancel().catch(() => undefined);
        throw new Error(
          `${options.label}: more than ${max} bytes${options.expect?.bytes !== undefined ? " (its declared size)" : ""}`,
        );
      }
      if (!checked) {
        head = Buffer.concat([head, chunk.subarray(0, 1024 - head.length)]);
        if (head.length >= 1024) {
          const problem = contentProblem(options.label, head);
          if (problem) {
            await reader.cancel().catch(() => undefined);
            throw new Error(problem);
          }
          checked = true;
        }
      }
      hash.update(chunk);
      if (options.onChunk) await options.onChunk(chunk);
    }
    if (!checked) {
      const problem = contentProblem(options.label, head);
      if (problem) throw new Error(problem);
    }
    session.bytes += bytes;
    const sha256 = hash.digest("hex");
    if (options.expect?.bytes !== undefined && bytes !== options.expect.bytes)
      throw new Error(
        `${options.label}: ${bytes} bytes where ${options.expect.bytes} were declared`,
      );
    if (
      options.expect?.sha256 !== undefined &&
      sha256 !== options.expect.sha256
    )
      throw new Error(
        `${options.label}: SHA-256 does not match the declared digest`,
      );
    return { sha256, bytes };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const segments = (path: string) =>
  path.split("/").map(encodeURIComponent).join("/");

/** Resolve a branch, tag or commit to the commit it names now. */
export async function resolveGithubRef(
  session: Session,
  owner: string,
  repo: string,
  ref: string,
): Promise<string> {
  if (/^[0-9a-f]{40}$/.test(ref)) return ref;
  if (++session.resolutions > TRANSFER_LIMITS.resolutions)
    throw new Error(`more than ${TRANSFER_LIMITS.resolutions} refs to resolve`);
  const chunks: Uint8Array[] = [];
  await fetchBounded(
    session,
    `${session.config.githubApi}/repos/${segments(owner)}/${segments(repo)}/commits/${segments(ref)}`,
    {
      label: `${owner}/${repo}@${ref}`,
      accept: "application/vnd.github.sha",
      maxBytes: 256,
      raw: true,
      auth: authorized(session, owner, repo),
      onChunk: (c) => {
        chunks.push(c);
      },
    },
  );
  const commit = Buffer.concat(chunks).toString("utf8").trim();
  if (!/^[0-9a-f]{40}$/.test(commit))
    throw new Error(`${owner}/${repo}@${ref}: GitHub did not return a commit`);
  return commit;
}

export const authorized = (session: Session, owner: string, repo: string) =>
  session.token !== undefined &&
  session.tokenRepos.has(`${owner}/${repo}`.toLowerCase());

/** The commit-addressed URL of a repository file, and its media type. */
export function githubFileUrl(
  session: Session,
  owner: string,
  repo: string,
  commit: string,
  path: string,
): { url: string; accept?: string; auth?: boolean } {
  // A token goes through the API (private repositories); public files come
  // from the commit-addressed raw host without any credential.
  return authorized(session, owner, repo)
    ? {
        url: `${session.config.githubApi}/repos/${segments(owner)}/${segments(repo)}/contents/${segments(path)}?ref=${commit}`,
        accept: "application/vnd.github.raw",
        auth: true,
      }
    : {
        url: `${session.config.githubRaw}/${segments(owner)}/${segments(repo)}/${commit}/${segments(path)}`,
      };
}

/** The token `gh` holds for github.com; it stays in memory for one command. */
export async function ghToken(): Promise<string> {
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn(["gh", "auth", "token", "--hostname", "github.com"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
  } catch {
    throw new Error("--auth gh needs the GitHub CLI (gh) on PATH");
  }
  const timer = setTimeout(() => child.kill(), 10_000);
  try {
    const text = await new Response(child.stdout as ReadableStream).text();
    const code = await child.exited;
    const token = text.trim();
    if (code !== 0 || !/^[A-Za-z0-9_]{20,255}$/.test(token))
      throw new Error("gh has no github.com login; run gh auth login");
    return token;
  } finally {
    clearTimeout(timer);
  }
}
