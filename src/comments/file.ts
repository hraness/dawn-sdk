// SPDX-License-Identifier: MIT
/** `comments.jsonl` on disk: bounded reads and serialized append. */
import { closeSync, fstatSync, openSync, readSync, writeSync } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import {
  COMMENTS_FILE,
  type CommentEvent,
  type FoldedComments,
  eventLine,
  readComments,
  parseCommentLines,
  foldComments,
  COMMENT_LIMITS,
} from "../../core/comments/events.ts";
import { acquireFileLock } from "../fs/lock.ts";

/** Bytes of `comments.jsonl` this dawn reads; a larger file is refused. */
export const MAX_COMMENTS_BYTES = 64 * 1024 * 1024;
const tooLarge = () =>
  new Error(
    `${COMMENTS_FILE} is larger than ${MAX_COMMENTS_BYTES / (1024 * 1024)} MiB`,
  );

export type CommentsOnDisk = Readonly<{
  /** False when the project has no `comments.jsonl`. */
  exists: boolean;
  folded: FoldedComments;
  /** Includes every valid event, not only comment additions. */
  eventIds: ReadonlySet<string>;
}>;

export async function readCommentsFile(
  project: string,
): Promise<CommentsOnDisk> {
  let file;
  try {
    file = await open(join(project, COMMENTS_FILE), "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { exists: false, folded: readComments(""), eventIds: new Set() };
    throw error;
  }
  try {
    if ((await file.stat()).size > MAX_COMMENTS_BYTES) throw tooLarge();
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      // The extra byte detects growth after stat without reading past the cap.
      const chunk = Buffer.alloc(
        Math.min(64 * 1024, MAX_COMMENTS_BYTES - total + 1),
      );
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MAX_COMMENTS_BYTES) throw tooLarge();
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const parsed = parseCommentLines(
      Buffer.concat(chunks, total).toString("utf8"),
    );
    return {
      exists: true,
      folded: foldComments(parsed),
      eventIds: new Set(parsed.events.map((event) => event.id)),
    };
  } finally {
    await file.close();
  }
}

/**
 * Appends one event in one write. The project lock keeps the size check and
 * a missing final newline consistent across cooperating writers. Existing
 * bytes are never rewritten, including a partial line left by a failed write.
 */
export async function appendCommentEvent(
  project: string,
  event: CommentEvent,
): Promise<boolean> {
  const line = eventLine(event);
  const dawn = join(project, ".dawn");
  await mkdir(dawn, { recursive: true });
  const release = await acquireFileLock(join(dawn, "comments.lock"));
  try {
    const fd = openSync(join(project, COMMENTS_FILE), "a+");
    try {
      const size = fstatSync(fd).size;
      let prefix = "";
      if (size > 0) {
        const last = Buffer.alloc(1);
        readSync(fd, last, 0, 1, size - 1);
        if (last[0] !== 0x0a) prefix = "\n";
      }
      const bytes = Buffer.from(prefix + line, "utf8");
      if (size + bytes.length > MAX_COMMENTS_BYTES) throw tooLarge();
      const current = await readCommentsFile(project);
      if (current.eventIds.has(event.id)) return false;
      if (event.kind === "add") {
        if (
          current.folded.comments.filter(
            (comment) => comment.state !== "deleted",
          ).length >= COMMENT_LIMITS.live
        )
          throw new Error(
            `this project already holds ${COMMENT_LIMITS.live} live comments`,
          );
      } else {
        const comment = current.folded.comments.find(
          (item) => item.id === event.of,
        );
        if (!comment || comment.state === "deleted") return false;
        if (
          (event.kind === "edit" || event.kind === "delete") &&
          event.author !== comment.author
        )
          return false;
        if (
          (event.kind === "resolve" && comment.state === "resolved") ||
          (event.kind === "reopen" && comment.state === "open") ||
          (event.kind === "edit" && comment.text === event.text)
        )
          return false;
      }
      if (writeSync(fd, bytes) !== bytes.length)
        throw new Error(
          "only part of the new comment line was written; existing lines were kept",
        );
      return true;
    } finally {
      closeSync(fd);
    }
  } finally {
    await release();
  }
}
