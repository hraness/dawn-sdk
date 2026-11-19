// SPDX-License-Identifier: MIT
/** Starting files for a collection repository: a guide and an optional CI workflow. */

export const TEMPLATES = ["pack", "artist", "community"] as const;
export type Template = (typeof TEMPLATES)[number];

const EXAMPLES = {
  pack: {
    id: "my-palette",
    kind: "palette",
    title: "My palette",
    credits: ["Replace with the creator"],
    licenses: { content: "Replace with the applicable license" },
    source: { type: "local", path: "packs/my-palette.json" },
  },
  artist: {
    id: "my-song",
    kind: "song",
    title: "My song",
    credits: ["Replace with the composer"],
    licenses: {
      content: "Replace with the composition license",
      software: "Replace with the source license",
    },
    source: { type: "local", path: "projects/my-song/song.ts" },
  },
  community: {
    id: "shared-library",
    kind: "collection",
    title: "Shared library",
    credits: ["Replace with the upstream curator"],
    licenses: { content: "Replace with the catalog license" },
    source: {
      type: "github",
      owner: "OWNER",
      repo: "REPOSITORY",
      ref: "main",
      path: "dawn.collection.json",
    },
  },
};
const ADD = {
  pack: 'dawn-collection add dawn.collection.json packs/my-palette.json --credit "Your name" --license content=CC-BY-4.0',
  artist:
    'dawn-collection add dawn.collection.json projects/my-song --credit "Your name" --license content=CC-BY-4.0 --license software=MIT',
  community:
    'dawn-collection add dawn.collection.json path/to/a/manifest.json --credit "Creator" --license content=CC-BY-4.0',
};
const LAYOUT = {
  pack: "Put each palette or sound pack under `packs/`.",
  artist:
    "Put each song project in its own folder under `projects/`, and albums under `albums/`.",
  community:
    "Most entries here are references to other people's repositories: a link, not a copy.",
};

export function contributionGuide(template: Template): string {
  return `# Contribute to this collection

This repository is a DAWN collection: \`dawn.collection.json\` lists sounds, loops, songs, albums or other collections, with who made them, under which licenses, and where their files are. ${LAYOUT[template]} The layout is a suggestion; files may live in any folder.

## Add an entry

Let \`collection add\` read your manifest and propose the entry. It works out the kind and lists every file with its SHA-256 digest and size; for a song folder that is the whole project except its trace history, downloads and hidden files.

\`\`\`sh
${ADD[template]}
\`\`\`

Read the proposal, then run the same command with \`--apply\` to add it. You can also write an entry by hand. This one is a shape to adapt, not an existing work or a license grant:

\`\`\`json
${JSON.stringify(EXAMPLES[template], null, 2)}
\`\`\`

Entry IDs are lowercase slugs and stay the same across versions, because projects that installed an entry find it again by its ID. Paths are relative to the catalog. For nested catalogs that reference sibling folders, pass the repository root with \`--root\`.

## Check before you open a pull request

\`\`\`sh
dawn-collection check dawn.collection.json --json
dawn-collection build dawn.collection.json --out ../collection-build --site
\`\`\`

\`check\` validates the catalog and every local file it names, and verifies the declared digests. \`build\` writes a portable copy with every digest filled in, an integrity inventory and a static page, and refuses Git LFS pointers, archives and files that configure tools (dot files, \`package.json\`, \`bunfig.toml\`). Neither command runs TypeScript, installs anything or contacts the network. A successful check is not permission to run contributed source.

Keep large recordings out of Git when they would make the repository slow to clone: publish them as release assets or on another HTTPS host and reference them with an \`https\` source and its \`sha256\` and \`bytes\`. Git LFS pointers are not installed.

## Credits and licenses

Preserve upstream credits and choose licenses you have authority to grant. Software, music, samples and traces may have different permissions, so label each one that applies. The curator selects work and is not its creator. Keep credentials, private recordings and unreviewed agent transcripts out of public contributions: a song's \`trace/\` folder is left out by \`collection add\`, and \`collection build\` includes only a metadata-only trace export.

## Install from this collection

\`\`\`sh
dawn-collection install https://github.com/OWNER/REPOSITORY <entry-id>
\`\`\`

The installer pins the current commit, copies only the selected entry's files and records them in the project's \`collections.lock.json\`. Opening a pull request or publishing a release remains your explicit action.
`;
}

/** A pull request check for a collection repository; it never runs contributed code. */
export function workflowTemplate(version: string): string {
  return `# Checks contributed catalog metadata and files. It never runs contributed
# source: the tools run from the runner's temporary folder, so a bunfig.toml,
# .env or package.json in a pull request is never read, and the job has
# read-only repository access and no secrets.
name: Collection

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  check:
    runs-on: ubuntu-24.04
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          path: collection
          persist-credentials: false
          lfs: false
      - uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0
        with:
          bun-version: "1.3.14"
      - name: Check the catalog and build it
        working-directory: \${{ runner.temp }}
        env:
          CATALOG: \${{ github.workspace }}/collection/dawn.collection.json
        run: |
          bunx --package @hraness/dawn-sdk@${version} dawn-collection check "$CATALOG" --root "$GITHUB_WORKSPACE/collection"
          bunx --package @hraness/dawn-sdk@${version} dawn-collection build "$CATALOG" --root "$GITHUB_WORKSPACE/collection" --out "$RUNNER_TEMP/build" --site
`;
}
