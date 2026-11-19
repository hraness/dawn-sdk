// SPDX-License-Identifier: MIT
/**
 * `dawn link` and `dawn open` against real project folders: the link out,
 * the four notices, the folder back, and every way either says no.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureScore } from "../../core/link/fixture.ts";
import {
  LINK_LIMITS,
  decodeLink,
  encodeScoreBytes,
} from "../../core/link/index.ts";
import { createScore, type TrackScore } from "../../core/score.ts";
import { printProject } from "../../core/sdk/print.ts";
import {
  COMMENTS_FILE,
  COMMENT_LIMITS,
  type CommentEvent,
  commentId,
  eventLine,
  readComments,
} from "../../core/comments/events.ts";
import { runCommentsCommand } from "../comments/cli.ts";
import { initProject } from "../project/init.ts";
import {
  LINK_BASE,
  LONG_LINK,
  linkReport,
  openLink,
  runLinkCommand,
  runOpenCommand,
  scoreAudio,
  signalsIn,
  type LinkReport,
  type OpenReport,
} from "./cli.ts";

const root = await mkdtemp(join(tmpdir(), "dawn-link-"));
afterAll(() => rm(root, { recursive: true, force: true }));

let made = 0;
/** A project folder holding `score` exactly as DAWN prints it. */
async function project(score: TrackScore): Promise<string> {
  const dir = join(root, `p${(made += 1)}`);
  await initProject(dir, { agentDocs: false });
  for (const file of printProject(score).files) {
    await mkdir(join(dir, file.path, ".."), { recursive: true });
    await writeFile(join(dir, file.path), file.text);
  }
  return dir;
}

async function run(
  command: typeof runLinkCommand,
  argv: readonly string[],
  cwd = root,
) {
  let out = "";
  let err = "";
  const code = await command(
    argv,
    cwd,
    { write: (text) => (out += text) },
    { write: (text) => (err += text) },
  );
  return { code, out, err };
}

const hex = (score: TrackScore) =>
  Buffer.from(encodeScoreBytes({ score })).toString("hex");

/** A score of `count` notes nothing compresses well. */
function busy(count: number): TrackScore {
  let state = 9;
  const next = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
  return createScore({
    bars: 64,
    tracks: [{ id: "a", name: "A", instrument: "synth" }],
    notes: Array.from({ length: count }, (_, i) => ({
      id: `n${i}`,
      trackId: "a",
      startTick: next() % (64 * 4 * 480 - 2000),
      durationTicks: 1 + (next() % 1900),
      pitch: 24 + (next() % 80),
      velocity: (1 + (next() % 999)) / 1000,
    })),
  });
}

describe("dawn link", () => {
  test("prints the link alone, and says nothing when nothing stays behind", async () => {
    const dir = await project(fixtureScore());
    const { code, out, err } = await run(runLinkCommand, ["link", dir]);
    expect(code).toBe(0);
    expect(err).toBe("");
    expect(out.startsWith(`${LINK_BASE}#d1.`)).toBe(true);
    expect(out.endsWith("\n")).toBe(true);
    const read = await decodeLink(out.trim());
    expect(read.ok && hex(read.score)).toBe(hex(fixtureScore()));
    // In the folder itself, with no argument.
    const here = await run(runLinkCommand, ["link"], dir);
    expect(here.out).toBe(out);
  });

  test("--json is one object with the link and the notices", async () => {
    const dir = await project(fixtureScore());
    const { code, out, err } = await run(runLinkCommand, [
      "link",
      dir,
      "--json",
    ]);
    expect(code).toBe(0);
    expect(err).toBe("");
    const report = JSON.parse(out) as LinkReport;
    expect(report).toMatchObject({
      schema: "dawn.link/v1",
      ok: true,
      codec: "d",
      scoreBytes: 202,
      notices: [],
    });
    if (!report.ok) throw new Error(report.message);
    expect(report.length).toBe(report.link.length);
    expect(report.link.endsWith(report.digest)).toBe(true);
  });

  test("says whose code becomes plain notes, and which signals become points", async () => {
    const dir = await project(fixtureScore());
    const song = await readFile(join(dir, "song.ts"), "utf8");
    await writeFile(
      join(dir, "song.ts"),
      `import { sine, perlin } from "dawn";\n${song}\n// "sine" in a comment\nexport const wobble = sine.range(0, 1).add(perlin);\nexport const note = { saw: "square" };\n`,
    );
    await writeFile(join(dir, "tracks", "helper.ts"), "export const x = 1;\n");
    const report = await linkReport(dir);
    if (!report.ok) throw new Error(report.message);
    expect(report.notices.map((notice) => notice.kind)).toEqual([
      "own-code",
      "signals",
    ]);
    const [own, signals] = report.notices;
    expect(own).toMatchObject({ files: ["song.ts", "tracks/helper.ts"] });
    expect(own!.message).toBe(
      "This link carries the song as DAWN prints it. Your own code in 2 files becomes plain notes for whoever opens it: song.ts, tracks/helper.ts.",
    );
    expect(signals).toMatchObject({ count: 2 });
    expect(signals!.message).toBe(
      "2 signals in the source travel as fixed points.",
    );
    // The link is the same one: the notes did not change.
    const read = await decodeLink(report.link);
    expect(read.ok && hex(read.score)).toBe(hex(fixtureScore()));
    // The notices go to stderr and the link to stdout.
    const { out, err } = await run(runLinkCommand, ["link", dir]);
    expect(out).toBe(`${report.link}\n`);
    expect(err.split("\n").filter(Boolean)).toEqual(
      report.notices.map((notice) => notice.message),
    );
  });

  test("counts a signal where one starts, and nowhere else", () => {
    expect(signalsIn('import { sine, saw } from "dawn";')).toBe(0);
    expect(signalsIn("lanes: { cutoff: sine.range(200, 2000) }")).toBe(1);
    expect(signalsIn("mods: { open: saw.slow(4).add(rand) }")).toBe(2);
    expect(signalsIn('instrument: "saw", // sine\n`${"perlin"}`')).toBe(0);
    expect(signalsIn("const tri = 3; x.sine; { pat: 1 }")).toBe(1);
    expect(signalsIn('pat("0 1 0 1").fast(2); steady(0.5)')).toBe(2);
  });

  test("says which audio is not in the link", async () => {
    const score = createScore({
      tracks: [
        {
          id: "hits",
          name: "Hits",
          instrument: "sampler",
          sampler: {
            mode: "oneshot",
            voices: {
              clap: {
                src: "pack:tidal-drum-machines/RolandTR909_cp:0",
                url: "https://example.com/cp.wav",
              },
              thump: { src: "tracks/hits/samples/thump.wav" },
              gone: { src: "tracks/hits/samples/gone.wav" },
            },
          },
        },
      ],
    });
    expect(scoreAudio(score)).toEqual([
      "pack:tidal-drum-machines/RolandTR909_cp:0",
      "tracks/hits/samples/gone.wav",
      "tracks/hits/samples/thump.wav",
    ]);
    const dir = await project(score);
    await mkdir(join(dir, "tracks/hits/samples"), { recursive: true });
    await writeFile(
      join(dir, "tracks/hits/samples/thump.wav"),
      new Uint8Array(3 * 1024 * 1024),
    );
    const report = await linkReport(dir);
    if (!report.ok) throw new Error(report.message);
    const audio = report.notices.find((notice) => notice.kind === "audio");
    expect(audio).toMatchObject({
      files: [
        { src: "pack:tidal-drum-machines/RolandTR909_cp:0", kind: "pack" },
        { src: "tracks/hits/samples/gone.wav", kind: "file" },
        {
          src: "tracks/hits/samples/thump.wav",
          kind: "file",
          bytes: 3 * 1024 * 1024,
        },
      ],
    });
    expect(audio!.message).toBe(
      "3 audio files (3.0 MB) are not in the link: 1 is a pack sound DAWN fetches by name; 2 have to be sent with the link (tracks/hits/samples/gone.wav, tracks/hits/samples/thump.wav).",
    );
  });

  test("says a long link is long, and how to send it whole", async () => {
    const dir = await project(busy(700));
    const report = await linkReport(dir);
    if (!report.ok) throw new Error(report.message);
    expect(report.length).toBeGreaterThan(LONG_LINK);
    expect(report.notices.map((notice) => notice.kind)).toEqual(["long"]);
    expect(report.notices[0]!.message).toBe(
      `This is a long link (${report.length.toLocaleString("en-US")} characters); some apps cut it. A file holds it whole: dawn link > song.link.txt, then dawn open song.link.txt.`,
    );
  });

  test("past 32,768 characters there is no link, and it says so", async () => {
    const dir = await project(busy(4000));
    const { code, out, err } = await run(runLinkCommand, ["link", dir]);
    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toMatch(
      /^this song is too long for a link: [\d,]+ characters; a link holds 32,768\. Nothing was uploaded\. Send the project folder\.\n$/,
    );
    const report = await linkReport(dir);
    expect(report).toMatchObject({ ok: false, code: "fragment_too_long" });
    expect(!report.ok && report.length).toBeGreaterThan(LINK_LIMITS.fragment);
  });

  test("a folder that is no project, and a song that does not evaluate", async () => {
    const empty = await mkdtemp(join(root, "empty-"));
    const none = await run(runLinkCommand, ["link", empty]);
    expect(none).toEqual({
      code: 1,
      out: "",
      err: "not a dawn project (no dawn.json here)\n",
    });
    const dir = await project(fixtureScore());
    await writeFile(join(dir, "song.ts"), "export default 3 +;\n");
    const broken = await run(runLinkCommand, ["link", dir, "--json"]);
    expect(broken.code).toBe(1);
    expect(JSON.parse(broken.out)).toMatchObject({
      ok: false,
      code: "does_not_evaluate",
    });
  });

  test("usage", async () => {
    const help = await run(runLinkCommand, ["link", "--help"]);
    expect(help.code).toBe(0);
    expect(help.out).toContain(
      "usage: dawn link [project] [--no-comments] [--json]",
    );
    const option = await run(runLinkCommand, ["link", "--upload"]);
    expect(option.code).toBe(2);
    expect(option.err).toContain("unknown option · --upload");
    const extra = await run(runLinkCommand, ["link", "a", "b"]);
    expect(extra.code).toBe(2);
    expect(extra.err).toContain("unexpected argument · b");
  });
});

describe("dawn open", () => {
  async function fixtureLink(): Promise<string> {
    const report = await linkReport(await project(fixtureScore()));
    if (!report.ok) throw new Error(report.message);
    return report.link;
  }

  test("writes the link as a new project that evaluates to the same score", async () => {
    const link = await fixtureLink();
    const cwd = await mkdtemp(join(root, "open-"));
    const { code, out, err } = await run(
      runOpenCommand,
      ["open", link, "song"],
      cwd,
    );
    expect(err).toBe("");
    expect(code).toBe(0);
    expect(out).toBe("opened song · 3 tracks, 6 notes, 4 files\n");
    const dir = join(cwd, "song");
    for (const file of printProject(fixtureScore(), { noteIds: false }).files)
      expect(await readFile(join(dir, file.path), "utf8")).toBe(file.text);
    expect((await readdir(dir)).sort()).toEqual(
      expect.arrayContaining(["dawn.json", "song.ts", "tracks", ".dawn"]),
    );
    // And from there, the same link again.
    const again = await linkReport(dir);
    expect(again.ok && again.link).toBe(link);
    expect(again.ok && again.notices).toEqual([]);
  });

  test("names the folder for the link when nobody names one", async () => {
    const link = await fixtureLink();
    const cwd = await mkdtemp(join(root, "open-"));
    const { code, out } = await run(
      runOpenCommand,
      ["open", link, "--json"],
      cwd,
    );
    expect(code).toBe(0);
    const report = JSON.parse(out) as OpenReport;
    if (!report.ok) throw new Error(report.message);
    expect(report).toMatchObject({
      schema: "dawn.open/v1",
      tracks: 3,
      notes: 6,
      audio: [],
    });
    expect(report.files).toContain("song.ts");
    expect(await readdir(cwd)).toEqual([
      expect.stringMatching(/^dawn-link-[0-9a-f]{8}$/),
    ]);
    expect(report.dir.endsWith((await readdir(cwd))[0]!)).toBe(true);
    // The fragment alone opens too.
    const fragment = await openLink(link.slice(link.indexOf("#")), "b", cwd);
    expect(fragment.ok).toBe(true);
  });

  test("never writes into a folder that has files", async () => {
    const link = await fixtureLink();
    const cwd = await mkdtemp(join(root, "open-"));
    await mkdir(join(cwd, "mine"));
    await writeFile(join(cwd, "mine", "song.ts"), "mine\n");
    await writeFile(join(cwd, "a-file"), "x\n");
    for (const dir of ["mine", "a-file", "."]) {
      const { code, out, err } = await run(
        runOpenCommand,
        ["open", link, dir],
        cwd,
      );
      expect(code).toBe(1);
      expect(out).toBe("");
      expect(err).toBe(
        `${dir} is already there and is not empty; name another folder: dawn open <link> <dir>\n`,
      );
    }
    expect(await readFile(join(cwd, "mine", "song.ts"), "utf8")).toBe("mine\n");
    expect((await readdir(cwd)).sort()).toEqual(["a-file", "mine"]);
    // An empty folder is nobody's work.
    await mkdir(join(cwd, "empty"));
    expect((await openLink(link, "empty", cwd)).ok).toBe(true);
    // Twice into the same place is the second kind of overwrite.
    expect(await openLink(link, "empty", cwd)).toMatchObject({
      ok: false,
      code: "would_overwrite",
    });
  });

  test("finds the link in a file, among other text", async () => {
    const link = await fixtureLink();
    const cwd = await mkdtemp(join(root, "open-"));
    await writeFile(
      join(cwd, "mail.txt"),
      `Here is the loop:\n\n  <${link}>\n\nsee you\n`,
    );
    const report = await openLink("mail.txt", "from-mail", cwd);
    expect(report.ok && report.notes).toBe(6);
    await writeFile(join(cwd, "big.txt"), new Uint8Array(1024 * 1024 + 1));
    expect(await openLink("big.txt", "from-big", cwd)).toMatchObject({
      ok: false,
      code: "unreadable",
    });
    await writeFile(join(cwd, "none.txt"), "no link in here\n");
    expect(await openLink("none.txt", "from-none", cwd)).toMatchObject({
      ok: false,
      code: "no_link",
    });
    expect((await readdir(cwd)).sort()).toEqual([
      "big.txt",
      "from-mail",
      "mail.txt",
      "none.txt",
    ]);
  });

  test("a link that does not open says which way, and writes nothing", async () => {
    const link = await fixtureLink();
    const cwd = await mkdtemp(join(root, "open-"));
    // One character of the digest.
    const at = link.length - 20;
    const changed =
      link.slice(0, at) + (link[at] === "A" ? "B" : "A") + link.slice(at + 1);
    const { code, out, err } = await run(
      runOpenCommand,
      ["open", changed, "x"],
      cwd,
    );
    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toBe(
      "this link does not open (digest_mismatch): the link was changed or cut short\n",
    );
    const json = await run(
      runOpenCommand,
      ["open", link.slice(0, -5), "x", "--json"],
      cwd,
    );
    expect(json.code).toBe(1);
    expect(JSON.parse(json.out)).toMatchObject({
      schema: "dawn.open/v1",
      ok: false,
    });
    expect(await readdir(cwd)).toEqual([]);
  });

  test("says which audio did not come with the link", async () => {
    const score = createScore({
      tracks: [
        {
          id: "hits",
          name: "Hits",
          instrument: "sampler",
          sampler: {
            mode: "oneshot",
            voices: { thump: { src: "tracks/hits/samples/thump.wav" } },
          },
        },
      ],
    });
    const report = await linkReport(await project(score));
    if (!report.ok) throw new Error(report.message);
    const cwd = await mkdtemp(join(root, "open-"));
    const { code, out, err } = await run(
      runOpenCommand,
      ["open", report.link, "hits"],
      cwd,
    );
    expect(code).toBe(0);
    expect(out).toBe("opened hits · 1 track, 0 notes, 2 files\n");
    expect(err).toBe(
      "1 audio file did not come with the link; its track is silent until it is in place: tracks/hits/samples/thump.wav\n",
    );
  });

  test("usage", async () => {
    const help = await run(runOpenCommand, ["open", "-h"]);
    expect(help.code).toBe(0);
    expect(help.out).toContain("usage: dawn open <link|file> [dir] [--json]");
    const none = await run(runOpenCommand, ["open"]);
    expect(none.code).toBe(2);
    expect(none.err).toContain("a link or a file with one in it");
    const option = await run(runOpenCommand, ["open", "--force", "x"]);
    expect(option.code).toBe(2);
    const extra = await run(runOpenCommand, ["open", "a", "b", "c"]);
    expect(extra.code).toBe(2);
  });
});

describe("comments in a link", () => {
  const id = (n: number) => {
    const bytes = new Uint8Array(16);
    new DataView(bytes.buffer).setUint32(0, n);
    bytes[15] = 5;
    return commentId(bytes);
  };
  const quiet = { write: () => undefined };
  let second = 0;
  /** `dawn comments` in `dir`, as `author`. */
  const comment = (dir: string, argv: string[], author?: string) =>
    runCommentsCommand(["comments", ...argv], dir, quiet, quiet, {
      author: async () => author,
      now: () => new Date(Date.UTC(2026, 10, 14, 9, 0, (second += 1))),
    });
  const folded = async (dir: string) =>
    readComments(await readFile(join(dir, COMMENTS_FILE), "utf8"));
  /** What a fold says, without what a link does not keep. */
  const said = async (dir: string) =>
    (await folded(dir)).comments.map((c) => ({
      id: c.id,
      text: c.text,
      author: c.author,
      at: c.at,
      thread: c.thread,
      state: c.state,
    }));

  test("dawn link carries them and dawn open writes them back", async () => {
    const dir = await project(fixtureScore());
    await comment(dir, ["add", "Slower?"], "ada");
    const first = (await folded(dir)).comments[0]!;
    await comment(dir, ["reply", first.id, "By 4"], "ana");
    await comment(
      dir,
      [
        "add",
        "These two",
        "--track",
        "lead",
        "--note",
        "0,240,62",
        "--note",
        "480,240,65",
      ],
      "ana",
    );
    await comment(dir, [
      "add",
      "Kick is late",
      "--track",
      "kick",
      "--bars",
      "0,1",
    ]);
    const late = (await folded(dir)).comments[3]!;
    await comment(dir, ["resolve", late.id], "ada");
    await comment(dir, ["add", "Never mind"], "ada");
    await comment(dir, ["delete", (await folded(dir)).comments[4]!.id], "ada");

    const sent = await run(runLinkCommand, ["link", dir]);
    expect(sent.code).toBe(0);
    expect(sent.err).toBe(
      "4 comments travel in this link with their authors' names; dawn link --no-comments leaves them out.\n",
    );
    const report = await linkReport(dir);
    if (!report.ok) throw new Error(report.message);
    expect(report.comments).toBe(4);
    expect(report.notices[0]).toMatchObject({
      kind: "comments",
      carried: 4,
      left: 0,
    });
    // The comments are in the digest and not in the revision.
    const bare = await linkReport(dir, { comments: false });
    if (!bare.ok) throw new Error(bare.message);
    expect(bare.comments).toBe(0);
    expect(bare.notices).toEqual([]);
    expect(bare.revision).toBe(report.revision);
    expect(bare.digest).toBe(bare.revision);
    expect(report.digest).not.toBe(report.revision);
    const flagged = await run(runLinkCommand, ["link", dir, "--no-comments"]);
    expect(flagged.out.trim()).toBe(bare.link);
    expect(flagged.err).toBe("");

    const cwd = await mkdtemp(join(root, "open-"));
    const opened = await run(
      runOpenCommand,
      ["open", report.link, "back"],
      cwd,
    );
    expect(opened.code).toBe(0);
    expect(opened.out).toContain(", 4 comments");
    const back = join(cwd, "back");
    const mine = (await said(dir)).filter((c) => c.state !== "deleted");
    expect(await said(back)).toEqual(mine);
    // Where they point survives: the notes, and the kick's first bar in ticks.
    const anchors = (await folded(back)).comments.map((c) => c.anchor);
    expect(anchors[2]).toEqual({
      rev: report.revision,
      track: "lead",
      notes: [
        [0, 240, 62],
        [480, 240, 65],
      ],
    });
    expect(anchors[3]).toEqual({
      rev: report.revision,
      track: "kick",
      bars: [0, 1],
    });
    // The folder that came back makes the same link.
    const again = await linkReport(back);
    expect(again.ok && again.link).toBe(report.link);
    // And opening the same link twice writes the same file.
    await run(runOpenCommand, ["open", report.link, "twice"], cwd);
    expect(await readFile(join(cwd, "twice", COMMENTS_FILE), "utf8")).toBe(
      await readFile(join(back, COMMENTS_FILE), "utf8"),
    );

    const json = await openLink(report.link, "third", cwd);
    expect(json).toMatchObject({ ok: true, comments: 4 });
    expect(json.ok && json.files).toContain(COMMENTS_FILE);
  });

  test("legacy-only comments are named as staying in the project folder", async () => {
    const dir = await project(fixtureScore());
    // It need not parse: the sender only checks whether the path is present.
    const legacy = Buffer.from("desktop comments: { not JSON\n");
    await writeFile(join(dir, "comments.json"), legacy);
    const sent = await run(runLinkCommand, ["link", dir, "--json"]);
    expect(sent.code).toBe(0);
    expect(sent.err).toBe("");
    const report = JSON.parse(sent.out) as LinkReport;
    if (!report.ok) throw new Error(report.message);
    expect(report.comments).toBe(0);
    expect(report.notices).toHaveLength(1);
    const notice = report.notices[0]!;
    expect(notice).toMatchObject({
      kind: "legacy-comments",
      file: "comments.json",
    });
    expect(notice.message).toContain("comments.json");
    expect(notice.message).toContain("not read");
    expect(notice.message).toContain("project folder");
    expect(notice.message).toContain("send the folder");
    expect(notice.message).not.toContain("migrate");
    expect(notice).not.toHaveProperty("left");
    const plain = await run(runLinkCommand, ["link", dir]);
    expect(plain.out.trim()).toBe(report.link);
    expect(plain.err.trim()).toBe(notice.message);
    const read = await decodeLink(report.link);
    expect(read.ok && read.comments).toEqual([]);
    expect(await readFile(join(dir, "comments.json"))).toEqual(legacy);
    expect(await readdir(dir)).not.toContain(COMMENTS_FILE);
  });

  test("both comment files carry JSONL comments and name the legacy omission", async () => {
    const dir = await project(fixtureScore());
    const legacy = "legacy desktop comments: { left untouched\n";
    const current = eventLine({
      v: 1,
      id: id(7),
      kind: "add",
      at: "2026-11-14T09:00:00Z",
      text: "From the shared file",
      author: "ada",
    });
    await writeFile(join(dir, "comments.json"), legacy);
    await writeFile(join(dir, COMMENTS_FILE), current);
    const report = await linkReport(dir);
    if (!report.ok) throw new Error(report.message);
    expect(report.comments).toBe(1);
    expect(report.notices.map((notice) => notice.kind)).toEqual([
      "comments",
      "legacy-comments",
    ]);
    expect(report.notices[0]).toMatchObject({ carried: 1, left: 0 });
    expect(report.notices[1]).toMatchObject({ file: "comments.json" });
    const read = await decodeLink(report.link);
    if (!read.ok) throw new Error(read.message);
    expect(read.comments.map((comment) => comment.text)).toEqual([
      "From the shared file",
    ]);
    expect(await readFile(join(dir, "comments.json"), "utf8")).toBe(legacy);
    expect(await readFile(join(dir, COMMENTS_FILE), "utf8")).toBe(current);
  });

  test("--no-comments suppresses the legacy notice with either file layout", async () => {
    for (const shared of [false, true]) {
      const dir = await project(fixtureScore());
      const legacy = "{ desktop comments stay here\n";
      await writeFile(join(dir, "comments.json"), legacy);
      const current = eventLine({
        v: 1,
        id: id(8),
        kind: "add",
        at: "2026-11-14T09:00:00Z",
        text: "Excluded too",
      });
      if (shared) await writeFile(join(dir, COMMENTS_FILE), current);
      const sent = await run(runLinkCommand, [
        "link",
        dir,
        "--no-comments",
        "--json",
      ]);
      expect(sent.code).toBe(0);
      expect(sent.err).toBe("");
      const report = JSON.parse(sent.out) as LinkReport;
      if (!report.ok) throw new Error(report.message);
      expect(report.comments).toBe(0);
      expect(report.notices).toEqual([]);
      const plain = await run(runLinkCommand, ["link", dir, "--no-comments"]);
      expect(plain.err).toBe("");
      expect(plain.out.trim()).toBe(report.link);
      expect(await readFile(join(dir, "comments.json"), "utf8")).toBe(legacy);
      if (shared)
        expect(await readFile(join(dir, COMMENTS_FILE), "utf8")).toBe(current);
      else expect(await readdir(dir)).not.toContain(COMMENTS_FILE);
    }
  });

  test("a link with no comments writes no comments.jsonl", async () => {
    const dir = await project(fixtureScore());
    const report = await linkReport(dir);
    if (!report.ok) throw new Error(report.message);
    expect(report.comments).toBe(0);
    const cwd = await mkdtemp(join(root, "open-"));
    const opened = await openLink(report.link, "plain", cwd);
    expect(opened).toMatchObject({ ok: true, comments: 0 });
    expect(await readdir(join(cwd, "plain"))).not.toContain(COMMENTS_FILE);
  });

  test("over the bound it says what is left out and why", async () => {
    const dir = await project(fixtureScore());
    let text = "";
    const line = (event: Partial<CommentEvent> & { id: string }) =>
      (text += eventLine({
        v: 1,
        kind: "add",
        at: "2026-11-14T09:00:00Z",
        text: "x",
        ...event,
      }));
    for (let n = 0; n < 1030; n += 1) line({ id: id(n) });
    // The first three are resolved: they go first.
    for (let n = 0; n < 3; n += 1)
      line({ id: id(5000 + n), kind: "resolve", of: id(n), text: undefined });
    line({ id: id(9000), kind: "add", text: "{ torn" });
    await writeFile(join(dir, COMMENTS_FILE), `${text}{ torn\n`);
    const report = await linkReport(dir);
    if (!report.ok) throw new Error(report.message);
    expect(report.comments).toBe(1024);
    const notice = report.notices[0]!;
    expect(notice).toMatchObject({ kind: "comments", carried: 1024, left: 7 });
    expect(notice.message).toContain(
      "7 comments are not in it: a link holds 1,024 comments; whole threads were left out, resolved ones first, then the oldest.",
    );
    expect(notice.message).toContain(
      "1 line of comments.jsonl could not be read and is not in it.",
    );
    const read = await decodeLink(report.link);
    if (!read.ok) throw new Error(read.message);
    const carried = new Set(read.comments.map((row) => commentId(row.id)));
    for (const n of [0, 1, 2, 3, 4, 5]) expect(carried.has(id(n))).toBe(false);
    expect(carried.has(id(6))).toBe(false);
    expect(carried.has(id(7))).toBe(true);
    expect(carried.has(id(9000))).toBe(true);
  });

  test("comments that make the link too long: it says so, and how to leave them out", async () => {
    const dir = await project(fixtureScore());
    const alone = await linkReport(dir, { comments: false });
    expect(alone.ok).toBe(true);
    let text = "";
    let state = 1;
    for (let n = 0; n < 40; n += 1) {
      let words = "";
      // Text that does not compress.
      while (words.length < COMMENT_LIMITS.text - 8) {
        state = (Math.imul(state, 1103515245) + 12345) >>> 0;
        words += state.toString(36);
      }
      text += eventLine({
        v: 1,
        id: id(n),
        kind: "add",
        at: "2026-11-14T09:00:00Z",
        text: words,
      });
    }
    await writeFile(join(dir, COMMENTS_FILE), text);
    const report = await linkReport(dir);
    expect(report.ok).toBe(false);
    if (report.ok) return;
    expect(["fragment_too_long", "url_too_long"]).toContain(report.code);
    expect(report.message).toContain("with its 40 comments");
    expect(report.message).toContain("dawn link --no-comments");
  });
});
