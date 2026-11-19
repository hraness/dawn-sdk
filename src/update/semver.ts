// SPDX-License-Identifier: MIT
/**
 * The version arithmetic the updater, the release manifest and project sync
 * share: `x.y.z` with an optional `-pre.N` suffix (build metadata ignored).
 * No dependencies, so the installer bootstrap can load it from a tarball.
 */

export type Version = Readonly<{
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated prerelease identifiers; empty for a stable version. */
  pre: readonly string[];
}>;

const VERSION =
  /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-([0-9A-Za-z.-]{1,40}))?(?:\+[0-9A-Za-z.-]{1,40})?$/;

/** Parses `1.2.3`, `v1.2.3` or `1.2.3-next.1`; undefined for anything else. */
export function parseVersion(text: string): Version | undefined {
  const match = VERSION.exec(text.trim());
  if (!match) return undefined;
  return Object.freeze({
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: Object.freeze(match[4] ? match[4].split(".") : []),
  });
}

/** True for a plain `x.y.z` (no `v`, no suffix). */
export function isPlainVersion(text: string): boolean {
  return /^\d{1,6}\.\d{1,6}\.\d{1,6}$/.test(text);
}

/** Negative, zero or positive like a sort comparator; throws on a malformed version. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) throw new Error(`not a version: ${!x ? a : b}`);
  if (x.major !== y.major) return x.major - y.major;
  if (x.minor !== y.minor) return x.minor - y.minor;
  if (x.patch !== y.patch) return x.patch - y.patch;
  // A prerelease sorts before its release.
  if (x.pre.length === 0 || y.pre.length === 0)
    return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i += 1) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn && Number(p) !== Number(q)) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

export function isNewer(candidate: string, than: string): boolean {
  return compareVersions(candidate, than) > 0;
}

/**
 * A project's `dawn` requirement: `">=x.y.z"` is a minimum, a plain
 * `"x.y.z"` is an exact pin. Undefined for anything else.
 */
export type Requirement =
  | Readonly<{ kind: "min"; version: string }>
  | Readonly<{ kind: "pin"; version: string }>;

export function parseRequirement(text: string): Requirement | undefined {
  const trimmed = text.trim();
  if (trimmed.startsWith(">=")) {
    const version = trimmed.slice(2).trim();
    return parseVersion(version) && !version.startsWith("v")
      ? { kind: "min", version }
      : undefined;
  }
  return parseVersion(trimmed) && !trimmed.startsWith("v")
    ? { kind: "pin", version: trimmed }
    : undefined;
}

export function satisfies(version: string, requirement: Requirement): boolean {
  return requirement.kind === "min"
    ? compareVersions(version, requirement.version) >= 0
    : compareVersions(version, requirement.version) === 0;
}

/** `>=x.y.0` for the given version: the minimum a project synced by it needs. */
export function minorFloor(version: string): string {
  const parsed = parseVersion(version);
  if (!parsed) throw new Error(`not a version: ${version}`);
  return `>=${parsed.major}.${parsed.minor}.0`;
}

/** True when `range` is a `>=` requirement of exactly `x.y.z` form. */
export function engineSatisfied(running: string, range: string): boolean {
  const requirement = parseRequirement(range);
  if (!requirement) return true; // An engines form we do not read never blocks.
  return satisfies(running.replace(/[-+].*$/, ""), requirement);
}
