// SPDX-License-Identifier: MIT
import { afterAll, expect, test } from "bun:test";
import { closeSync, ftruncateSync, openSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commentId,
  COMMENTS_FILE,
  eventLine,
} from "../../core/comments/events.ts";
import {
  appendCommentEvent,
  MAX_COMMENTS_BYTES,
  readCommentsFile,
} from "./file.ts";

const root = await mkdtemp(join(tmpdir(), "dawn-comments-file-"));
afterAll(() => rm(root, { recursive: true, force: true }));
const event = {
  v: 1 as const,
  id: commentId(new Uint8Array(16)),
  kind: "add" as const,
  at: "2026-11-14T00:00:00Z",
  text: "hello",
};

test("refuses an oversized sparse file before reading its contents", async () => {
  const file = join(root, COMMENTS_FILE);
  const fd = openSync(file, "w");
  try {
    ftruncateSync(fd, MAX_COMMENTS_BYTES + 1);
  } finally {
    closeSync(fd);
  }
  await expect(readCommentsFile(root)).rejects.toThrow("64 MiB");
  expect((await stat(file)).size).toBe(MAX_COMMENTS_BYTES + 1);
});

test("an append cannot grow the file past the reader's cap", async () => {
  const file = join(root, COMMENTS_FILE);
  const fd = openSync(file, "w");
  try {
    ftruncateSync(fd, MAX_COMMENTS_BYTES);
  } finally {
    closeSync(fd);
  }
  await expect(appendCommentEvent(root, event)).rejects.toThrow("64 MiB");
  expect((await stat(file)).size).toBe(MAX_COMMENTS_BYTES);
});

test("keeps a crash-cut final line and starts the next event on its own line", async () => {
  const file = join(root, COMMENTS_FILE);
  const cut = '{"v":1,"id":"cut';
  await writeFile(file, cut);
  await appendCommentEvent(root, event);
  expect(await readFile(file, "utf8")).toBe(cut + "\n" + eventLine(event));
  const read = await readCommentsFile(root);
  expect(read.folded.comments).toHaveLength(1);
  expect(read.folded.skipped).toEqual([{ line: 1, reason: "not JSON" }]);
});

test("a repeated event id is unchanged, and a raced resolution is unchanged", async () => {
  await writeFile(join(root, COMMENTS_FILE), "");
  expect(await appendCommentEvent(root, event)).toBe(true);
  expect(await appendCommentEvent(root, { ...event, text: "retry" })).toBe(
    false,
  );
  const resolve = {
    ...event,
    id: commentId(new Uint8Array(16).fill(1)),
    kind: "resolve" as const,
    of: event.id,
  };
  expect(await appendCommentEvent(root, resolve)).toBe(true);
  expect(
    await appendCommentEvent(root, {
      ...resolve,
      id: commentId(new Uint8Array(16).fill(2)),
    }),
  ).toBe(false);
  expect(
    (await readFile(join(root, COMMENTS_FILE), "utf8")).split("\n"),
  ).toHaveLength(3);
});

test("concurrent additions cannot pass the live-comment cap", async () => {
  const id = (n: number) => {
    const bytes = new Uint8Array(16);
    new DataView(bytes.buffer).setUint32(0, n);
    return commentId(bytes);
  };
  await writeFile(
    join(root, COMMENTS_FILE),
    Array.from({ length: 1999 }, (_, n) =>
      eventLine({ ...event, id: id(n + 1) }),
    ).join(""),
  );
  const result = await Promise.allSettled(
    [2000, 2001].map((n) => appendCommentEvent(root, { ...event, id: id(n) })),
  );
  expect(result.filter((item) => item.status === "fulfilled")).toHaveLength(1);
  expect(result.filter((item) => item.status === "rejected")).toHaveLength(1);
  expect((await readCommentsFile(root)).folded.comments).toHaveLength(2000);
});
