// SPDX-License-Identifier: MIT
/**
 * A persistent, content-addressed cache for offline renders: finished track
 * stems and bus returns (`StemStore`, consulted by `StemRenderer`), each
 * track's dry voice before its effects (`StemStore.voices`, so a mix-only
 * edit re-runs the chain but not the voices) and whole arrangement windows
 * (the `WindowCache` interface `renderArranged` uses).
 *
 * Every key is a sha256 of the in-memory key plus a digest of the render
 * code (the TypeScript under src/ and core/), so a code change never reads
 * an old result; without the sources (a compiled binary) the cache is off.
 * Files live under `<dir>/<code digest>/`, zstd-compressed. `maxBytes`
 * (`DAWN_RENDER_CACHE_MAX`) caps the whole `<dir>`, every code version
 * included: past it, entries of other code versions (which can never hit
 * again) go first, then this version's stems and windows, then its dry
 * voices, least recently used first within each; the dry voices
 * are also capped at `voiceMaxBytes` (`DAWN_VOICE_CACHE_MAX`). Hits refresh
 * the mtime. Several processes or threads may share one `<dir>` (an album's
 * songs do): each re-reads the folder's size after writing a tenth of the
 * budget, so together they overshoot the cap by at most that much each.
 * Writes go to a temporary file and are renamed into place, so a reader
 * never sees a partial entry. A sha256 binds the entry's name, header and
 * stored payload before decoding; damaged or older unchecked entries miss.
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type {
  RenderedAudio,
  StemStore,
  StoredStem,
  StoredVoice,
} from "./wav.ts";
import {
  DEFAULT_RENDER_CACHE_BYTES,
  renderCacheMax,
  voiceCacheMax,
} from "./cache.ts";

export { DEFAULT_RENDER_CACHE_BYTES };
const MAGIC = 0x32435244; // "DRC2": checked header and stored payload
const PREFIX_BYTES = 12;
const DIGEST_BYTES = 32;
const HEADER_OFFSET = PREFIX_BYTES + DIGEST_BYTES;

/** Bind the entry to its key as well as its bytes, including compression flags. */
function entryDigest(name: string, bytes: Uint8Array): Buffer {
  return createHash("sha256")
    .update(name)
    .update("\0")
    .update(bytes.subarray(0, PREFIX_BYTES))
    .update(bytes.subarray(HEADER_OFFSET))
    .digest();
}
/** File-name prefix of the dry voice tier. */
const VOICE = "v-";
/** A code version folder: the digest's first 16 hex digits. */
const VERSION_DIR = /^[0-9a-f]{16}$/;

type Entry = {
  path: string;
  size: number;
  mtime: number;
  voice: boolean;
  /** Written by another code version: never read again. */
  stale: boolean;
};

let codeDigestMemo: string | null | undefined;

/** sha256 of the render code, or null when the sources are not on disk. */
export function renderCodeDigest(
  root = resolve(import.meta.dir, "../.."),
): string | null {
  if (
    codeDigestMemo !== undefined &&
    root === resolve(import.meta.dir, "../..")
  )
    return codeDigestMemo;
  const files: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && !entry.name.startsWith("."))
          walk(path);
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts"))
        files.push(path);
    }
  };
  walk(join(root, "src"));
  walk(join(root, "core"));
  let digest: string | null = null;
  if (files.length > 0) {
    files.sort();
    const hash = createHash("sha256");
    for (const file of files) {
      hash.update(file.slice(root.length));
      hash.update("\0");
      hash.update(readFileSync(file));
      hash.update("\0");
    }
    digest = hash.digest("hex");
  }
  if (root === resolve(import.meta.dir, "../..")) codeDigestMemo = digest;
  return digest;
}

/**
 * Totals over every tier (stems, buses, windows, voices); the `voice*`
 * fields count the dry voice tier alone. A render on worker threads adds
 * its workers' counts to the caller's cache (`RenderDiskCache.merge`).
 */
export type RenderCacheStats = {
  hits: number;
  misses: number;
  writes: number;
  evicted: number;
  voiceHits: number;
  voiceMisses: number;
  voiceWrites: number;
};

const emptyStats = (): RenderCacheStats => ({
  hits: 0,
  misses: 0,
  writes: 0,
  evicted: 0,
  voiceHits: 0,
  voiceMisses: 0,
  voiceWrites: 0,
});

/** What another thread needs to open the same cache (`RenderDiskCache.config`). */
export type RenderCacheConfig = Readonly<{
  dir: string;
  maxBytes?: number;
  voiceMaxBytes?: number;
  compress?: boolean;
  codeDigest?: string | null;
}>;

export class RenderDiskCache implements StemStore {
  public readonly stats: RenderCacheStats = emptyStats();
  private readonly dir: string | undefined;
  private readonly maxBytes: number;
  private readonly voiceMaxBytes: number;
  private readonly compress: boolean;
  private readonly root: string;
  private total: number | undefined;
  private voiceTotal: number | undefined;
  /** Bytes this instance wrote since it last read the folder's size. */
  private sinceScan = 0;
  /** The same cache from a worker thread (plain data, structured-cloneable). */
  public readonly config: RenderCacheConfig;

  public constructor(
    options: Readonly<{
      dir: string;
      /** Every tier (default `renderCacheMax()`, 4 GiB). */
      maxBytes?: number;
      /** The dry voice tier (default `voiceCacheMax()`, 2 GiB). */
      voiceMaxBytes?: number;
      /** zstd entries (default true). */
      compress?: boolean;
      /** Override the code digest (tests); null disables the cache. */
      codeDigest?: string | null;
    }>,
  ) {
    const code =
      options.codeDigest === undefined
        ? renderCodeDigest()
        : options.codeDigest;
    this.root = options.dir;
    this.dir = code ? join(options.dir, code.slice(0, 16)) : undefined;
    this.maxBytes = options.maxBytes ?? renderCacheMax();
    this.voiceMaxBytes = Math.min(
      this.maxBytes,
      options.voiceMaxBytes ?? voiceCacheMax(),
    );
    this.compress = options.compress ?? true;
    // Resolved budgets, so a worker thread prunes to the same caps.
    this.config = {
      dir: options.dir,
      codeDigest: code,
      maxBytes: this.maxBytes,
      voiceMaxBytes: this.voiceMaxBytes,
      ...(options.compress === undefined ? {} : { compress: options.compress }),
    };
  }

  /** Add another instance's counts (a worker thread's) to these stats. */
  public merge(stats: Readonly<Partial<RenderCacheStats>>): void {
    for (const key of Object.keys(this.stats) as (keyof RenderCacheStats)[])
      this.stats[key] += stats[key] ?? 0;
  }

  /** False when the code digest is unknown: every get misses, sets drop. */
  public get enabled(): boolean {
    return this.dir !== undefined;
  }

  // StemStore
  public get = (key: string): StoredStem | undefined => {
    const entry = this.read(`s-${key}`);
    if (!entry) return undefined;
    const { header, payload } = entry;
    const n = header.n as number;
    if (payload.byteLength !== n * 16) return this.miss();
    const all = new Float64Array(payload.buffer, payload.byteOffset, n * 2);
    return {
      left: all.slice(0, n),
      right: all.slice(n),
      ...(header.nonFinite ? { nonFinite: header.nonFinite as number } : {}),
    };
  };

  public set = (key: string, stem: StoredStem): void => {
    const n = stem.left.length;
    const payload = new Uint8Array(n * 16);
    const view = new Float64Array(payload.buffer);
    view.set(stem.left, 0);
    view.set(stem.right.subarray(0, n), n);
    this.write(`s-${key}`, { n, nonFinite: stem.nonFinite ?? 0 }, payload);
  };

  /**
   * Dry track voices (`StemStore.voices`): Float64, one channel for a mono
   * voice, so the chain on top of a hit sees the very samples it would
   * have rendered.
   */
  public readonly voices = {
    get: (key: string): StoredVoice | undefined => {
      const entry = this.read(`${VOICE}${key}`);
      if (!entry) {
        this.stats.voiceMisses += 1;
        return undefined;
      }
      const { header, payload } = entry;
      const n = header.n as number;
      const channels = header.stereo ? 2 : 1;
      if (payload.byteLength !== n * 8 * channels) {
        this.stats.hits -= 1;
        this.stats.voiceMisses += 1;
        return this.miss();
      }
      this.stats.voiceHits += 1;
      const all = new Float64Array(
        payload.buffer,
        payload.byteOffset,
        n * channels,
      );
      return {
        left: all.subarray(0, n),
        ...(channels === 2 ? { right: all.subarray(n, 2 * n) } : {}),
        ...(header.nonFinite ? { nonFinite: header.nonFinite as number } : {}),
      };
    },
    set: (key: string, voice: StoredVoice): void => {
      const n = voice.left.length;
      const channels = voice.right ? 2 : 1;
      const payload = new Uint8Array(n * 8 * channels);
      const view = new Float64Array(payload.buffer);
      view.set(voice.left, 0);
      if (voice.right) view.set(voice.right.subarray(0, n), n);
      if (
        this.write(
          `${VOICE}${key}`,
          { n, stereo: channels === 2, nonFinite: voice.nonFinite ?? 0 },
          payload,
        )
      )
        this.stats.voiceWrites += 1;
    },
  };

  /** Bytes of the dry voice tier on disk under this code version. */
  public voiceBytes(): number {
    return this.scan()
      .filter((f) => f.voice && !f.stale)
      .reduce((a, f) => a + f.size, 0);
  }

  /** A `WindowCache`-compatible view for whole arrangement windows. */
  public readonly windows = {
    get: (key: string): RenderedAudio | undefined => {
      const entry = this.read(`w-${key}`);
      if (!entry) return undefined;
      const { header, payload } = entry;
      const frames = header.frames as number;
      if (payload.byteLength !== frames * 4) return this.miss();
      const pcm = new Int16Array(frames * 2);
      new Uint8Array(pcm.buffer).set(payload);
      return {
        sampleRate: header.sampleRate as number,
        channels: 2,
        frames,
        pcm,
        ...(header.master ? { master: header.master } : {}),
        ...(header.nonFinite ? { nonFinite: header.nonFinite } : {}),
        ...(header.monitor ? { monitor: header.monitor } : {}),
      } as RenderedAudio;
    },
    set: (key: string, audio: RenderedAudio): void => {
      const pcm = audio.pcm;
      this.write(
        `w-${key}`,
        {
          sampleRate: audio.sampleRate,
          frames: audio.frames,
          ...(audio.master ? { master: audio.master } : {}),
          ...(audio.nonFinite ? { nonFinite: audio.nonFinite } : {}),
          ...(audio.monitor ? { monitor: audio.monitor } : {}),
        },
        new Uint8Array(pcm.buffer, pcm.byteOffset, audio.frames * 4).slice(),
      );
    },
  };

  /** Bytes on disk under this code version. */
  public bytes(): number {
    return this.scan()
      .filter((f) => !f.stale)
      .reduce((a, f) => a + f.size, 0);
  }

  /** Bytes on disk under `<dir>`, every code version included (what the cap bounds). */
  public diskBytes(): number {
    return this.scan().reduce((a, f) => a + f.size, 0);
  }

  /**
   * Keep only the dry voice tier of this code version: drop finished stems,
   * bus returns, whole windows and every other code version's entries. A
   * later render or mix of the same code then re-runs effect chains but no
   * voice. Returns the bytes left.
   */
  public keepVoices(): number {
    let left = 0;
    let voices = 0;
    for (const file of this.scan()) {
      if (file.voice && !file.stale) {
        left += file.size;
        voices += file.size;
        continue;
      }
      try {
        unlinkSync(file.path);
        this.stats.evicted += 1;
      } catch {
        left += file.size; // another process got it, or it is still there
      }
    }
    this.removeEmptyVersions();
    this.total = left;
    this.voiceTotal = voices;
    this.sinceScan = 0;
    return left;
  }

  /** Remove every entry of this code version. */
  public clear(): void {
    if (this.dir) rmSync(this.dir, { recursive: true, force: true });
    this.total = undefined;
    this.voiceTotal = 0;
  }

  private miss(): undefined {
    this.stats.misses += 1;
    return undefined;
  }

  private pathOf(name: string): string {
    return join(this.dir!, name.slice(2, 4), `${name}.bin`);
  }

  private read(
    name: string,
  ): { header: Record<string, unknown>; payload: Uint8Array } | undefined {
    if (!this.dir) return this.miss();
    const path = this.pathOf(name);
    let bytes: Uint8Array;
    try {
      bytes = readFileSync(path);
    } catch {
      return this.miss();
    }
    try {
      if (bytes.byteLength < HEADER_OFFSET) return this.miss();
      const view = new DataView(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
      );
      if (view.getUint32(0, true) !== MAGIC) return this.miss();
      const flags = view.getUint32(4, true);
      const headerLength = view.getUint32(8, true);
      if (
        flags > 1 ||
        headerLength > bytes.byteLength - HEADER_OFFSET ||
        !entryDigest(name, bytes).equals(
          bytes.subarray(PREFIX_BYTES, HEADER_OFFSET),
        )
      )
        return this.miss();
      const header = JSON.parse(
        new TextDecoder().decode(
          bytes.subarray(HEADER_OFFSET, HEADER_OFFSET + headerLength),
        ),
      ) as Record<string, unknown>;
      let payload = bytes.subarray(HEADER_OFFSET + headerLength);
      if (flags & 1) payload = Bun.zstdDecompressSync(payload);
      // Aligned copy for the typed views.
      const aligned = new Uint8Array(payload.byteLength);
      aligned.set(payload);
      const now = new Date();
      try {
        utimesSync(path, now, now);
      } catch {
        // Evicted meanwhile: the bytes are already read.
      }
      this.stats.hits += 1;
      return { header, payload: aligned };
    } catch {
      return this.miss();
    }
  }

  /** True when the entry landed on disk. */
  private write(
    name: string,
    header: Record<string, unknown>,
    payload: Uint8Array,
  ): boolean {
    if (!this.dir) return false;
    const body = this.compress
      ? Bun.zstdCompressSync(payload, { level: 1 })
      : payload;
    const head = new TextEncoder().encode(JSON.stringify(header));
    const out = new Uint8Array(
      HEADER_OFFSET + head.byteLength + body.byteLength,
    );
    const view = new DataView(out.buffer);
    view.setUint32(0, MAGIC, true);
    view.setUint32(4, this.compress ? 1 : 0, true);
    view.setUint32(8, head.byteLength, true);
    out.set(head, HEADER_OFFSET);
    out.set(body, HEADER_OFFSET + head.byteLength);
    out.set(entryDigest(name, out), PREFIX_BYTES);
    const voice = name.startsWith(VOICE);
    if (out.byteLength > (voice ? this.voiceMaxBytes : this.maxBytes))
      return false;
    const path = this.pathOf(name);
    const folder = join(this.dir, name.slice(2, 4));
    try {
      mkdirSync(folder, { recursive: true });
      const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      writeFileSync(temp, out);
      renameSync(temp, path);
    } catch {
      return false;
    }
    this.stats.writes += 1;
    // Another writer on the same folder: re-read its size every tenth of the budget.
    this.sinceScan += out.byteLength;
    if (this.sinceScan > this.maxBytes / 10) {
      this.total = undefined;
      this.voiceTotal = undefined;
    }
    if (this.total === undefined || this.voiceTotal === undefined)
      this.recount();
    else {
      this.total += out.byteLength;
      if (voice) this.voiceTotal += out.byteLength;
    }
    if (voice && this.voiceTotal! > this.voiceMaxBytes) this.prune(true);
    if (this.total! > this.maxBytes) this.prune(false);
    return true;
  }

  /** Every entry under `<dir>`: this code version's and stale ones. */
  private scan(): Entry[] {
    if (!this.dir || !existsSync(this.root)) return [];
    const out: Entry[] = [];
    const current = this.dir.slice(this.root.length + 1);
    let versions: string[];
    try {
      versions = readdirSync(this.root).filter((name) =>
        VERSION_DIR.test(name),
      );
    } catch {
      return [];
    }
    for (const version of versions) {
      const base = join(this.root, version);
      const stale = version !== current;
      let subs: string[];
      try {
        subs = readdirSync(base);
      } catch {
        continue;
      }
      for (const sub of subs) {
        const folder = join(base, sub);
        let names: string[];
        try {
          names = readdirSync(folder);
        } catch {
          continue;
        }
        for (const name of names) {
          if (!name.endsWith(".bin")) continue;
          try {
            const st = statSync(join(folder, name));
            out.push({
              path: join(folder, name),
              size: st.size,
              mtime: st.mtimeMs,
              voice: name.startsWith(VOICE),
              stale,
            });
          } catch {
            // Gone meanwhile.
          }
        }
      }
    }
    return out;
  }

  /** Re-read the folder's size (every version) and this version's voice bytes. */
  private recount(): void {
    const all = this.scan();
    this.total = all.reduce((a, f) => a + f.size, 0);
    this.voiceTotal = all
      .filter((f) => f.voice && !f.stale)
      .reduce((a, f) => a + f.size, 0);
    this.sinceScan = 0;
  }

  /** Remove other code versions' folders once nothing is left in them. */
  private removeEmptyVersions(): void {
    const current = this.dir?.slice(this.root.length + 1);
    let versions: string[];
    try {
      versions = readdirSync(this.root).filter(
        (name) => VERSION_DIR.test(name) && name !== current,
      );
    } catch {
      return;
    }
    for (const version of versions) {
      const base = join(this.root, version);
      try {
        for (const sub of readdirSync(base))
          if (readdirSync(join(base, sub)).every((n) => !n.endsWith(".bin")))
            rmSync(join(base, sub), { recursive: true, force: true });
        if (readdirSync(base).length === 0) rmSync(base, { recursive: true });
      } catch {
        // Another process is still using or removing it.
      }
    }
  }

  /**
   * Drop entries down to 90% of the budget: of the whole folder (other code
   * versions, then stems and windows, then dry voices, each least recently
   * used first), or (`voices`) of this version's dry voice tier alone.
   */
  private prune(voices: boolean): void {
    const all = this.scan();
    // Other versions first, then stems and windows (cheap to redo), then
    // dry voices (the slow part), each least recently used first.
    const rank = (f: Entry) => (f.stale ? 0 : f.voice ? 2 : 1);
    const files = (voices ? all.filter((f) => f.voice && !f.stale) : all).sort(
      (a, b) => rank(a) - rank(b) || a.mtime - b.mtime,
    );
    const budget = voices ? this.voiceMaxBytes : this.maxBytes;
    let total = files.reduce((a, f) => a + f.size, 0);
    let voiceTotal = all
      .filter((f) => f.voice && !f.stale)
      .reduce((a, f) => a + f.size, 0);
    let everything = all.reduce((a, f) => a + f.size, 0);
    let staleGone = false;
    for (const file of files) {
      if (total <= budget * 0.9) break;
      try {
        unlinkSync(file.path);
        total -= file.size;
        everything -= file.size;
        if (file.voice && !file.stale) voiceTotal -= file.size;
        if (file.stale) staleGone = true;
        this.stats.evicted += 1;
      } catch {
        // Another process got it.
      }
    }
    if (staleGone) this.removeEmptyVersions();
    this.total = everything;
    this.voiceTotal = voiceTotal;
    this.sinceScan = 0;
  }
}
