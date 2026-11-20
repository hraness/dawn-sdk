// SPDX-License-Identifier: MIT
/** The score-document format: head, figures, places and links. */
import { describe, expect, test } from "bun:test";
import {
  BUILT_IN_TAGS,
  DOC_LIMITS,
  type PlaceSpec,
  Problems,
  figureLines,
  formatClock,
  parseBars,
  parseFigure,
  parseHead,
  parseLinkPlace,
  parsePitch,
  parsePitchRange,
  parseTime,
  parseTimeRange,
  placeFragment,
  quoted,
  splitDoc,
} from "./format.ts";

const builtIns = () => new Map(BUILT_IN_TAGS.map((t) => [t.name, t]));

function head(yaml: string) {
  const problems = new Problems();
  const parsed = parseHead(splitDoc(`---\n${yaml}\n---\n`), problems);
  return { parsed, problems: problems.list };
}

function figure(body: string, tags = builtIns()) {
  const problems = new Problems();
  const spec = parseFigure(body, 10, tags, problems);
  return { spec, problems: problems.list };
}

function link(href: string) {
  const problems = new Problems();
  const spec = parseLinkPlace(href, 7, problems);
  return { spec, problems: problems.list };
}

describe("problems", () => {
  test("keep the first hundred, count the rest, and count every error", () => {
    const problems = new Problems();
    for (let i = 0; i < 150; i += 1) problems.error(i + 1, `error ${i}`);
    for (let i = 0; i < 10; i += 1) problems.warn(i + 1, `warning ${i}`);
    expect(problems.list).toHaveLength(DOC_LIMITS.problems);
    expect(problems.dropped).toBe(60);
    expect(problems.errors).toBe(150);
  });

  test("warnings are not errors", () => {
    const problems = new Problems();
    problems.warn(3, "a warning", "a hint");
    expect(problems.errors).toBe(0);
    expect(problems.list).toEqual([
      { line: 3, severity: "warn", message: "a warning", hint: "a hint" },
    ]);
  });

  test("quoted text is printable and short", () => {
    expect(quoted("a\u0007b")).toBe('"a b"');
    expect(quoted("x".repeat(50), 10)).toBe(`"${"x".repeat(10)}…"`);
  });
});

describe("the head", () => {
  test("splits from the body and keeps its lines", () => {
    const split = splitDoc("---\r\ntitle: A\r\n---\r\n# Hi\r\n");
    expect(split.head).toBe("title: A");
    expect(split.headLine).toBe(2);
    expect(split.body.split("\n")[3]).toBe("# Hi");
    expect(splitDoc("# Only\n")).toEqual({
      head: null,
      headLine: 0,
      body: "# Only\n",
    });
    // An unclosed head is text.
    expect(splitDoc("---\ntitle: A\n").head).toBeNull();
  });

  test("reads the title, the byline and the songs, each on its line", () => {
    const { parsed, problems } = head(
      [
        "title: Notes",
        "author: an agent",
        'date: "2026-11-19"',
        "songs:",
        "  klo: out/klo/",
        "  two: { score: two.json, audio: false, title: Two }",
        "  three: { score: three/, audio: three.mp3 }",
      ].join("\n"),
    );
    expect(problems).toEqual([]);
    expect(parsed.title).toBe("Notes");
    expect(parsed.author).toBe("an agent");
    expect(parsed.date).toBe("2026-11-19");
    expect(parsed.songs).toEqual([
      { key: "klo", path: "out/klo/", line: 6 },
      { key: "two", path: "two.json", audio: null, title: "Two", line: 7 },
      { key: "three", path: "three/", audio: "three.mp3", line: 8 },
    ]);
  });

  test("refuses what it does not know, by line, with a hint", () => {
    const { problems } = head(
      ["title: 2026", "colour: red", "dawn: 2", "songs:", "  bad key: x"].join(
        "\n",
      ),
    );
    expect(problems.map((p) => [p.line, p.message])).toEqual([
      [3, 'unknown key "colour" in the head'],
      [4, "this DAWN reads score documents of format 1"],
      [2, "title must be text"],
      [6, 'song key "bad key" must be letters, digits, - or _ (at most 32)'],
    ]);
    expect(problems[2]!.hint).toContain("quote it");
  });

  test("a song needs its score", () => {
    const { problems } = head("songs:\n  a: { audio: a.wav }");
    expect(problems.map((p) => p.message)).toEqual([
      "songs.a needs score: <file or folder>",
    ]);
  });
});

describe("tags", () => {
  test("the built-in ones are always there", () => {
    const { parsed } = head("title: x");
    expect([...parsed.tags.keys()]).toEqual([
      "issue",
      "fix",
      "keep",
      "ask",
      "note",
      "focus",
    ]);
  });

  test("a tag of the document's own is like another, with its own tone", () => {
    const { parsed, problems } = head(
      'tags:\n  seam: { like: issue, label: the seam, tone: "#B3541E", dark: "#e08a5b" }',
    );
    expect(problems).toEqual([]);
    expect(parsed.tags.get("seam")).toEqual({
      name: "seam",
      label: "the seam",
      about: "something wrong",
      line: "solid",
      fill: "none",
      tab: "filled",
      ink: "red",
      tone: "#b3541e",
      dark: "#e08a5b",
      builtIn: false,
    });
  });

  test("the built-in tags have a color each, and a line, well and tab each", () => {
    expect(BUILT_IN_TAGS.map((t) => [t.name, t.ink])).toEqual([
      ["issue", "red"],
      ["fix", "blue"],
      ["keep", "green"],
      ["ask", "violet"],
      ["note", "gray"],
      ["focus", "gray"],
    ]);
    // Color is never the only thing that tells two tags apart.
    const looks = BUILT_IN_TAGS.map((t) => `${t.line} ${t.fill} ${t.tab}`);
    expect(new Set(looks).size).toBe(BUILT_IN_TAGS.length);
  });

  test("a tone may name a color of the palette, which has its own dark", () => {
    const { parsed, problems } = head(
      [
        "tags:",
        '  seam: { like: issue, tone: "#b3541e", dark: "#e08a5b" }',
        "  joint: { like: seam, tone: Violet }",
        "  quiet: { like: issue, tone: gray }",
        "  odd: { tone: teal }",
        '  both: { tone: green, dark: "#9cc7a8" }',
      ].join("\n"),
    );
    // A named color replaces a tone it would have taken from its like.
    expect(parsed.tags.get("joint")).toMatchObject({
      ink: "violet",
      line: "solid",
      tab: "filled",
    });
    expect(parsed.tags.get("joint")!.tone).toBeUndefined();
    expect(parsed.tags.get("joint")!.dark).toBeUndefined();
    expect(parsed.tags.get("quiet")).toMatchObject({ ink: "gray" });
    expect(problems.map((p) => [p.message, p.hint])).toEqual([
      [
        'tags.odd.tone must be one of gray, red, blue, green, violet or a color like "#2f7a4f"',
        undefined,
      ],
      [
        'tags.both.dark goes with a tone like "#2f7a4f"',
        "green has its own color on a dark ground",
      ],
    ]);
  });

  test("a built-in tag takes a new label and stays built in", () => {
    const { parsed } = head("tags:\n  issue: { label: problem }");
    expect(parsed.tags.get("issue")).toMatchObject({
      label: "problem",
      builtIn: true,
      line: "solid",
    });
  });

  test("refuses tags that cannot work, each with its reason", () => {
    const { problems } = head(
      [
        "tags:",
        "  bars: {}",
        "  Loud: {}",
        "  issue: { like: keep }",
        "  hue:",
        "    tone: #b3541e",
        '  night: { dark: "#000" }',
        "  ghost: { line: none }",
        "  odd: { line: wavy }",
      ].join("\n"),
    );
    const messages = problems.map((p) => p.message);
    expect(messages).toEqual([
      '"bars" cannot be a tag: a figure line or a place uses the word',
      'tag name "Loud" must start with a letter and be lowercase letters, digits or - (at most 24)',
      "tags.issue: a built-in tag cannot be like another",
      'tags.hue.tone must be one of gray, red, blue, green, violet or a color like "#2f7a4f"',
      "tags.night.dark needs a tone: for the light ground too",
      "tags.ghost would draw nothing: line none needs fill well",
      "tags.odd.line must be one of solid, dashed, dotted, none",
    ]);
    // An unquoted # is a YAML comment: the hint says so.
    expect(problems[3]!.hint).toContain("unquoted #");
  });

  test("at most 24 of the document's own", () => {
    const lines = Array.from({ length: 25 }, (_, i) => `  t${i}: {}`);
    const { parsed, problems } = head(`tags:\n${lines.join("\n")}`);
    expect(problems.map((p) => p.message)).toEqual([
      "more than 24 tags of the document's own",
    ]);
    expect(parsed.tags.size).toBe(BUILT_IN_TAGS.length + 24);
  });
});

describe("places", () => {
  test("pitches by name or number, C4 is 60", () => {
    expect(parsePitch("C4")).toBe(60);
    expect(parsePitch("E4")).toBe(64);
    expect(parsePitch("C#4")).toBe(61);
    expect(parsePitch("Db3")).toBe(49);
    expect(parsePitch("F♯2")).toBe(42);
    expect(parsePitch("C-1")).toBe(0);
    expect(parsePitch("127")).toBe(127);
    expect(parsePitch("128")).toBeUndefined();
    expect(parsePitch("H4")).toBeUndefined();
    expect(parsePitchRange("C4-G4")).toEqual([60, 67]);
    expect(parsePitchRange("G4..C4")).toEqual([60, 67]);
    expect(parsePitchRange("60-67")).toEqual([60, 67]);
    expect(parsePitchRange("C-1-C4")).toEqual([0, 60]);
  });

  test("times as m:ss or seconds", () => {
    expect(parseTime("0:47")).toBe(47);
    expect(parseTime("1:02.5")).toBe(62.5);
    expect(parseTime("47.5")).toBe(47.5);
    expect(parseTime("0:7")).toBeUndefined();
    expect(parseTime("0:60")).toBeUndefined();
    expect(parseTimeRange("0:47")).toEqual([47, null]);
    expect(parseTimeRange("0:47-0:52.5")).toEqual([47, 52.5]);
    expect(parseTimeRange("0:47–0:52")).toEqual([47, 52]);
    expect(formatClock(62.54)).toBe("1:02.5");
    expect(formatClock(47)).toBe("0:47");
  });

  test("bars as heard, from 1", () => {
    expect(parseBars("18")).toEqual([18, 18]);
    expect(parseBars("18-19")).toEqual([18, 19]);
    expect(parseBars("18..19")).toEqual([18, 19]);
    expect(parseBars("18 – 19")).toEqual([18, 19]);
    expect(parseBars("0")).toBeUndefined();
    expect(parseBars("x")).toBeUndefined();
  });
});

describe("figures", () => {
  test("header lines set it up and every other line is a mark", () => {
    const { spec, problems } = figure(
      [
        "song: klo",
        "bars: 18-19",
        'tracks: lead, "bass synth"',
        "caption: The lift",
        "# a comment",
        'issue word "a light" lead: closes early',
        'keep bars 18 track "Lead vocal": hold: this',
        "note t 0:47-0:52.5: a remark",
        "focus pitch C4-G4 lead",
      ].join("\n"),
    );
    expect(problems).toEqual([]);
    expect(spec).toEqual({
      line: 10,
      song: "klo",
      window: { bars: [18, 19] },
      tracks: ["lead", "bass synth"],
      caption: "The lift",
      marks: [
        {
          line: 16,
          tag: "issue",
          place: { word: "a light", tracks: ["lead"] },
          note: "closes early",
        },
        {
          line: 17,
          tag: "keep",
          place: { bars: [18, 18], tracks: ["Lead vocal"] },
          note: "hold: this",
        },
        { line: 18, tag: "note", place: { t: [47, 52.5] }, note: "a remark" },
        {
          line: 19,
          tag: "focus",
          place: { pitch: [60, 67], tracks: ["lead"] },
          note: "",
        },
      ],
    });
  });

  test("a document's own tag marks too", () => {
    const tags = builtIns();
    tags.set("seam", { ...tags.get("issue")!, name: "seam", builtIn: false });
    expect(figure("seam bars 2: here", tags).spec.marks[0]!.tag).toBe("seam");
  });

  test("says what went wrong with a mark", () => {
    const { problems } = figure(
      [
        "bars 18: no tag",
        "caption The lift",
        "loud bars 18: what",
        'issue "light": quoted alone',
        'issue section "Chorus 1" 2: the number',
        'issue word "unclosed: x',
        "issue bars 19-18: backwards",
        "issue t 0:50-0:47: backwards",
        "issue bars: no value",
        "issue song klo: in a mark",
        "issue track: alone",
      ].join("\n"),
    );
    expect(problems.map((p) => [p.line, p.message])).toEqual([
      [11, "a mark starts with its tag"],
      [12, '"caption" sets up the figure and needs a colon'],
      [13, 'unknown tag "loud"'],
      [14, '"light": quoted text needs a word before it'],
      [15, '"2" after section "Chorus 1" is not a track'],
      [16, "a quote is not closed"],
      [17, "bars 19-18 runs backwards"],
      [18, "t 0:50-0:47 runs backwards or is empty"],
      [19, "bars needs a value"],
      [20, "a mark is in its figure's song"],
      [21, "track needs a value"],
    ]);
    expect(problems[0]!.hint).toBe(
      "write it as <tag> bars …: <note>, for example issue bars …",
    );
    expect(problems[3]!.hint).toContain('track "light"');
  });

  test("at most 48 marks", () => {
    const body = Array.from({ length: 50 }, (_, i) => `note t ${i}: n`);
    const { spec, problems } = figure(body.join("\n"));
    expect(spec.marks).toHaveLength(DOC_LIMITS.marksPerFigure);
    expect(problems.map((p) => p.message)).toEqual([
      "more than 48 marks in one figure",
    ]);
  });

  test("their fences are found by line, in quotes and lists too", () => {
    const body = [
      "# x", //                      1
      "```js", //                    2
      "```dawn", //                  3: inside a js fence
      "```", //                      4
      "````dawn", //                 5
      "bars: 1", //                  6
      "```", //                      7: shorter, still open
      "````", //                     8
      "> ~~~ dawn", //               9
      "> ~~~", //                   10
      "```dawn", //                 11
    ].join("\n");
    expect(figureLines(body)).toEqual([5, 9, 11]);
  });
});

describe("links", () => {
  test("a fragment of key=value pairs is a place", () => {
    expect(link("#bars=18-19&track=lead").spec).toEqual({
      bars: [18, 19],
      tracks: ["lead"],
    });
    expect(link("#song=klo&section=Chorus+1").spec).toEqual({
      song: "klo",
      section: "Chorus 1",
    });
    expect(link("#word=a%20light&t=0:47").spec).toEqual({
      word: "a light",
      t: [47, null],
    });
    expect(link("#Bars=2&TRACKS=a,b&track=c").spec).toEqual({
      bars: [2, 2],
      tracks: ["a", "b", "c"],
    });
  });

  test("an anchor is not a place", () => {
    expect(link("#notes").spec).toBeUndefined();
    expect(link("https://example.com/#a=b").spec).toBeUndefined();
  });

  test("a broken place is an error on its line", () => {
    expect(link("#colour=red")).toMatchObject({
      spec: null,
      problems: [
        { line: 7, message: 'unknown key "colour" in the place "#colour=red"' },
      ],
    });
    expect(link("#bars=x").problems[0]!.message).toBe(
      '"x" is not a bar or a range of bars',
    );
    expect(link("#word=%E0%A4").problems[0]!.message).toBe(
      'the place "#word=%E0%A4" has a broken %-escape',
    );
  });

  test("a comma parts tracks, and one in a track's id is kept", () => {
    expect(link("#track=voxo,har,pad1").spec).toEqual({
      tracks: ["voxo", "har", "pad1"],
    });
    expect(link("#track=piano%2C%20left,bass").spec).toEqual({
      tracks: ["piano, left", "bass"],
    });
  });

  test("a place written as a fragment reads back as itself", () => {
    const places: PlaceSpec[] = [
      { song: "klo", bars: [47, 49], tracks: ["voxo", "har", "pad1"] },
      { bars: [18, 18] },
      { t: [47, null] },
      { t: [47.2, 52.5], tracks: ["piano, left & right"] },
      { section: "Chorus 1", word: "a light" },
      { song: "k-2", pitch: [60, 67] },
      { pitch: [64, 64], tracks: ["Lead vocal", "a+b"] },
    ];
    for (const place of places) {
      const href = placeFragment(place);
      expect(link(href)).toEqual({ spec: place, problems: [] });
    }
  });
});
