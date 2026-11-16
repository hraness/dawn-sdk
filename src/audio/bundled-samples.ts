/**
 * Only catalogued studio-v1 URLs resolve locally; arbitrary URLs never do.
 *
 * A studio sound's identity is its PCM WAV: the URL ends in `.wav`, and the
 * catalogue and every pinned score reference keep that WAV's SHA-256. The
 * package stores each sound as FLAC (`assets/samples/studio/<id>.flac`, less
 * than half the size); reading one decodes it and rebuilds the canonical WAV
 * byte for byte, checked against the pinned hash, so a project made when the
 * library shipped WAVs loads and renders exactly as before.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUNDLED_SAMPLE_BASE,
  BUNDLED_SAMPLES,
  bundledSample,
  type BundledSample,
} from "../../core/bundled-samples.ts";
import { decodeFlac, flacToWav } from "./flac.ts";

export function bundledSampleForUrl(url: string): BundledSample | undefined {
  return BUNDLED_SAMPLES.find(
    (sample) => url === `${BUNDLED_SAMPLE_BASE}${sample.id}.wav`,
  );
}

export type BundledSampleFile = Readonly<{
  /** The stored FLAC. */
  path: string;
  /** The sound's WAV, rebuilt from the FLAC. */
  bytes: Uint8Array;
  /** SHA-256 of `bytes`, the catalogue's pin. */
  sha256: string;
  sample: BundledSample;
}>;

/** Rebuilt WAVs kept in memory: decoding the longest book takes ~0.1 s. */
const recent = new Map<string, Promise<BundledSampleFile>>();
const RECENT = 6;

async function read(sample: BundledSample): Promise<BundledSampleFile> {
  const path = fileURLToPath(
    new URL(`../../assets/samples/studio/${sample.id}.flac`, import.meta.url),
  );
  let bytes: Uint8Array;
  try {
    bytes = flacToWav(decodeFlac(new Uint8Array(await readFile(path))));
  } catch {
    throw new Error(`studio/${sample.id} failed its bundled SHA-256 check`);
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== sample.sha256)
    throw new Error(`studio/${sample.id} failed its bundled SHA-256 check`);
  return Object.freeze({ path, bytes, sha256, sample });
}

export async function readBundledSample(
  id: string,
  expectSha256?: string,
): Promise<BundledSampleFile> {
  const sample = bundledSample(id);
  if (!sample) throw new Error(`Unknown studio sample: ${id.slice(0, 80)}`);
  let pending = recent.get(sample.id);
  if (!pending) {
    pending = read(sample);
    pending.catch(() => recent.delete(sample.id));
  } else recent.delete(sample.id);
  recent.set(sample.id, pending);
  while (recent.size > RECENT) recent.delete(recent.keys().next().value!);
  const file = await pending;
  if (expectSha256 && file.sha256 !== expectSha256)
    throw new Error(`studio/${sample.id} failed its bundled SHA-256 check`);
  return file;
}

/**
 * The sound as a WAV file on disk, for tools that read a path (`dawn audio`
 * and its ffmpeg and rubberband steps): written once per user under the
 * temporary folder, named by its hash, and checked again on every use.
 */
export async function bundledSampleWavPath(id: string): Promise<string> {
  const file = await readBundledSample(id);
  const dir = join(tmpdir(), "dawn-studio-v1");
  const path = join(dir, `${file.sha256}.wav`);
  const kept = await readFile(path).catch(() => undefined);
  if (kept && createHash("sha256").update(kept).digest("hex") === file.sha256)
    return path;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, file.bytes, { mode: 0o600 });
  await rename(tmp, path);
  return path;
}
