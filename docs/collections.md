# Organize a collection

A collection is a catalog of sounds, loops, songs, albums or other collections. Entries point to files or remote sources; they do not require a particular repository layout. Create a catalog, add entries with credits and license labels, check and build it, and share the repository. Anyone can then install selected entries into a project, pinned to the exact bytes they reviewed.

The collection tools are part of the public [DAWN SDK](https://github.com/hraness/dawn-sdk) and of the full `dawn` command. Checking, adding and building never fetch remote content, evaluate a project, install dependencies or publish files. Installing fetches only the selected entries' declared files and runs none of them. No DAWN registry or account is involved: a collection is a Git repository or a folder you own.

## Start a catalog

Choose a new directory whose parent exists:

```sh
dawn-collection init my-library --id my-library --title "My library" --curator "Your name" --template artist --ci
dawn-collection check my-library/dawn.collection.json --json
```

Replace the title and curator with your own values. The command writes an empty `dawn.collection.json` and a `CONTRIBUTING.md` guide that explains how to add an entry and check it. `--ci` also writes `.github/workflows/collection.yml`, described under [Check contributions on GitHub](#check-contributions-on-github). An empty catalog is valid and its check reports zero entries. Existing directories, files and symlinks are refused. A failed write can leave a reserved directory for inspection; choose a new destination after investigating the failure.

Choose `--template pack` for a sound pack, `artist` for a library of projects and albums, or `community` for a catalog of references to other people's repositories. The default is `community`. Templates provide contribution instructions, not sample music or a license grant. Their suggested layouts are optional.

The catalog convention is `dawn.collection.json`, but every command accepts an explicit local filename. Nothing scans a repository for projects.

## Add an entry

`collection add` reads one manifest or project folder and proposes an entry:

```sh
dawn-collection add my-library/dawn.collection.json my-library/projects/night --credit "Your name" --license content=CC-BY-4.0 --license software=MIT
```

It prints the entry and changes nothing. Run the same command with `--apply` to append it to the catalog. The kind comes from what it finds:

| Path                                               | Kind         | Files               |
| -------------------------------------------------- | ------------ | ------------------- |
| A folder with `dawn.json`, or its `song.ts`        | `song`       | The project folder  |
| A folder with `album.json`, or a `dawn.album/v1`   | `album`      | The album folder    |
| A `dawn.palette/v1` JSON file                      | `palette`    | The file            |
| A folder with `dawn.composer.json`, or that file   | `composer`   | The composer folder |
| `patches.json`, or a folder holding one            | `patch-pack` | The file            |
| `dawn.collection.json`, or a folder holding one    | `collection` | The file            |
| An audio file (`.wav`, `.flac`, `.ogg`, `.mp3`, …) | `loop`       | The file            |

Pass `--kind`, `--id` or `--title` to override what it found. A palette's title, author and license fill the entry's title, credits and license unless you pass `--credit` or `--license`. `--license` takes `content=`, `software=`, `samples=` or `trace=` followed by a label, and may be repeated. `--apply` refuses an entry without credits or licenses, or one whose ID the catalog already has.

For a folder, the entry lists every file with its SHA-256 digest and size in `files`. A song leaves out its `trace/` history, the `downloads`, `references` and `stems` folders under `tracks/`, hidden files (`.dawn/`, `.env`), package manifests and Bun configuration, archives, links and Git LFS pointers; the proposal names each file it left out. The source is the project's `song.ts` and the files are relative to its folder.

You can write an entry by hand. Copy a palette you own to `sounds/palette.json` beneath your catalog directory and add this to the `entries` array, replacing the title, credits and license with values that apply to your work:

```json
{
  "id": "my-sounds",
  "kind": "palette",
  "title": "My sounds",
  "credits": ["Your name"],
  "licenses": { "content": "LicenseRef-All-Rights-Reserved" },
  "source": { "type": "local", "path": "sounds/palette.json" }
}
```

Paths are relative to the catalog's directory. For a catalog in `catalogs/dawn.collection.json` that refers to `../sounds/palette.json`, select the containing library as the root:

```sh
dawn-collection check my-library/catalogs/dawn.collection.json --root my-library
```

Without `--root`, the allowed root is the catalog's parent directory. Both the catalog and its local references must remain inside the selected root after resolving symlinks. The root is a filesystem boundary, not a claim that the folder is a Git repository.

## Reference other repositories

A remote entry uses an explicit source descriptor. For example, replace the placeholders in this descriptor with the repository, revision and catalog path you intend to reference:

```json
{
  "type": "github",
  "owner": "OWNER",
  "repo": "REPOSITORY",
  "ref": "main",
  "path": "catalogs/dawn.collection.json",
  "entry": "warm-keys"
}
```

All source types accept an optional `entry` selector that names an item in the referenced catalog. An HTTPS source has `type: "https"` and `url`. URLs must use HTTPS and contain no credentials, query string or fragment. GitHub paths are repository-relative. A branch name is a reference, not a content lock: installation resolves it to a commit and records that commit.

Checks validate the descriptor syntax and report every remote entry under `remoteUnchecked`. They do not contact the host, verify that a revision or selected entry exists, authenticate an author, or expand another collection. A reference-only community catalog can pass with every remote entry unchecked. Curators can accept references rather than copying media, so creators keep their own repositories.

## Check and build

```sh
dawn-collection check dawn.collection.json --json
dawn-collection build dawn.collection.json --out ../my-library-build --site --url https://example.com/my-library/dawn.collection.json
```

`check` validates the catalog and every local file it names, and verifies the declared digests within a 64 MiB total hashing budget. `--json` reports the collection identity, version, entry count, local files checked, hashes verified and remote entries unchecked. Passing does not validate content schemas, source safety or licensing rights.

`build` writes a portable copy of the catalog into a new folder outside the collection root:

- `dawn.collection.json`: the catalog with every local file's digest and size filled in and every path made relative to the root, so a nested catalog's `../` paths work from the build's top level.
- each entry's local files at their root-relative paths;
- `dawn.inventory.json` (`dawn.collection-inventory/v1`): the catalog's digest, and every file with its digest, size and the entries that use it, the remote entries and the trace exports;
- `traces/<entry>/`: for each song project with a trace, the [metadata-only trace export](./traces.md#export-metadata), without prompts, notes, comments, source hunks or actor names. The full `dawn` command includes them; `--no-traces` leaves them out, and the SDK reports them as left out. A song's raw `trace/` folder is never copied;
- `index.html` with `--site`: one static page listing the entries with their kinds, credits, licenses, sources, sizes and digests. It has no script and loads nothing from elsewhere. `--url` is the address the catalog will be published at, used in the page's install commands.

The same inputs give the same bytes. Build reads and verifies everything before it creates the output, and refuses Git LFS pointers, archives, files that configure tools and digests that do not match. Nothing is published: commit or upload the build yourself. A failed build can leave a partial folder; delete it and choose a new destination.

## Check contributions on GitHub

The workflow `init --ci` writes runs `collection check` and `collection build` on every pull request with the SDK release you have, pinned by version. It checks the repository out into a subfolder and runs the tools from the runner's temporary folder, so a `bunfig.toml`, `.env` or `package.json` in a contribution is never read. It has read-only repository access, uses `pull_request` rather than `pull_request_target`, receives no secrets and does not keep Git credentials. It evaluates no contributed TypeScript; a passing check is not permission to run it.

Keep large recordings out of Git when they would make the repository slow to clone. Publish them as release assets or on another HTTPS host and reference them with an `https` source and its `sha256` and `bytes`. A release label alone does not pin content; the declared digest does.

## Install entries

From a project folder:

```sh
dawn-collection install https://github.com/OWNER/REPOSITORY warm-keys night-song
```

The command reads the repository's `dawn.collection.json`, resolves the ref once to a commit, fetches only the named entries' declared files, verifies them and copies them into `collections/<name>/<entry>/`, where the name is the catalog's ID. It records the source, the commit, the catalog's digest and every file's digest and size in `collections.lock.json`. Commit the lock with the project. Installing runs no installed code, and a song is reported as not evaluated until you [qualify it](#qualify-installed-songs).

| Form                                                    | Catalog                                                          |
| ------------------------------------------------------- | ---------------------------------------------------------------- |
| `https://github.com/OWNER/REPO`                         | `dawn.collection.json` at the default branch                     |
| `https://github.com/OWNER/REPO/tree/REF/FOLDER`         | `FOLDER/dawn.collection.json` at `REF`                           |
| `https://github.com/OWNER/REPO/blob/REF/PATH.json`      | `PATH.json` at `REF`                                             |
| `https://raw.githubusercontent.com/OWNER/REPO/REF/PATH` | `PATH` at `REF`                                                  |
| any other HTTPS URL                                     | That file; its entries' files must declare `sha256` and `bytes`  |
| a local file or folder                                  | That catalog, or the folder's `dawn.collection.json`; no network |

A URL takes only the first segment after `tree` or `blob` as the ref. For a ref with a slash, or a catalog elsewhere, give the repository URL with `--ref <ref>` and `--path <catalog-path>`. `--as <name>` installs under another name, for example a fork whose catalog has the same ID. `--root` sets the collection root of a local catalog.

Without entry IDs, `install <url>` adds the collection for search and lists its entries without installing any. `install <name> <entry>` installs from a collection the project already has, at its locked commit. A collection link (`kind: "collection"`) or a reference to an entry of another catalog is not installed through the referring catalog: the error prints the `install` command for its own catalog.

Files are cached once per user in `~/.cache/dawn/collections` (or `$XDG_CACHE_HOME/dawn/collections`, or `DAWN_COLLECTION_CACHE`), named by their SHA-256. `dawn-collection install` with no arguments restores every locked entry from the cache, for a fresh clone of the project; add `--offline` to refuse any network access. A file already holding the locked bytes is kept, and a file with other content is reported and never overwritten.

### Private repositories

`--auth gh` asks the GitHub CLI for its github.com token (`gh auth token`) for this one command and fetches through the GitHub API. The token is used only for the repository you named (and, for `update` and a restore, the repositories of the collections in the lock), never for another repository a catalog refers to. It is sent only to `api.github.com`, never to a redirect target or another host, and is not written to the lock, the cache, output or a log.

## Review updates

```sh
dawn-collection update --dry-run
dawn-collection update
dawn-collection update my-library night-song
```

`update --dry-run` resolves each collection's ref again and prints a plan without changing the project: per entry, `unchanged`, `update` with the files added, changed and removed, `held`, `conflict`, `removed-upstream` or `error`. A dry run may fill the cache. `update` applies the plan. It never replaces a file you edited: an entry with an edited file is a `conflict` and stays at its locked version, and the command exits 1. A locked song, album or composer is `held` until you name it, as in the last line. Files the new version drops are deleted only when unedited. An entry the catalog no longer lists keeps its files. Name a collection, and optionally entries, to update only those.

## Remove and search

`dawn-collection remove <name> [entry...]` removes entries from the lock; with no entries it also removes the collection from the project. It keeps the installed files unless you pass `--delete-files`, which deletes only files that still hold their locked bytes.

`dawn-collection search [words...] [--kind <kind>]` searches the catalogs this project added, offline from the cache: IDs, titles, descriptions, kinds and credits that contain every word. There is no central index; to search a community index, add it like any other collection.

## Qualify installed songs

A song's source is evaluated in the [sealed song engine](./design/song-sandbox.md): it has no file, network, process, environment, clock or randomness, imports only `dawn` and files inside its folder, and is bounded in memory, stack and time. `dawn-collection qualify [name [entry...]]` closes what that boundary leaves open for installed songs, and records the result in the lock. It is part of the full `dawn` command:

- Every installed file must hold its locked bytes; an edited song is not evaluated.
- The song is evaluated with the installed folder as its project and a 10-second budget (`--timeout-ms`).
- Every sample, wavetable, clip, take and tuning file the score names must be one of the entry's own locked files.
- The song may play at most 20 minutes (`--max-seconds`) and cost at most 19,200 track-seconds (64 tracks for 5 minutes) to render.

A qualified entry records its score's digest, length, track and note counts and the files it names. Render it like any project from its folder, for example `cd collections/my-library/night-song && dawn render ~/night.wav`. A render vendors DAWN's SDK into the folder's `.dawn/` as it would for any project, and does not check the lock; qualify again after changing the entry. With the SDK alone, `dawn-render song.ts --out ~/night.wav` in that folder writes the same bytes without vendoring the SDK.

## Limits

| Bound                                 | Value                                  |
| ------------------------------------- | -------------------------------------- |
| Catalog                               | 8 MiB, 512 entries                     |
| Files of one entry                    | 2,048                                  |
| Bytes transferred by one command      | 4 GiB (`--max-bytes`)                  |
| One file without a declared size      | 1 GiB                                  |
| Wait for a response or its next chunk | 30 s                                   |
| One command                           | 15 minutes (`--timeout <seconds>`)     |
| Redirects                             | 5, each to HTTPS on a public host name |
| Refs resolved by one command          | 64                                     |

Transfers refuse plain HTTP, URLs with credentials, IP literals in loopback, private and link-local ranges, `localhost` and single-label hosts, at every redirect. A declared size or digest that does not match stops the transfer, and nothing unverified enters the cache or the project. Git LFS pointers are reported with their object ID and are not fetched. Archives are refused rather than extracted. Installed paths are relative, in Unicode normal form C and unique ignoring case, and exclude hidden files and folders, `node_modules`, `package.json` and other package manager files, and `bunfig.toml`, so an installed entry configures no tool. Files are written without execute permission. A committed lock is validated before use: entry folders must be `collections/<name>/<entry>`, and repository names and paths follow the catalog's rules. Host names are not resolved before connecting, so a public name that resolves to a private address is not detected.

## Credits and integrity

Keep `curator` separate from each entry's `credits`. A curator selects work; credits identify its claimed creators and contributors. Neither field authenticates an identity.

Every entry needs at least one license label in `licenses`. Its keys are `content`, `software`, `samples` and `trace`; supply the labels applicable to the referenced work. DAWN checks their shape, not legal authority or compatibility. A repository's software license does not automatically cover its music, samples or trace. Public availability does not grant trace indexing or training permission.

A source may declare `sha256` and `bytes` together; an entry's `files` always carry both. The digest is 64 lowercase hexadecimal characters and the size is a nonnegative safe integer of at most 1 TiB. Hashes identify bytes, not authorship.

## Format

The root object has `schema: "dawn.collection/v1"`, `id`, `version`, `title`, `curator`, optional `description`, and `entries`. Versions use numeric `major.minor.patch`. Each entry has `id`, `kind`, `title`, `credits`, `licenses`, `source`, and optional `description` and `files`. `files` lists every file of the entry as `{ "path", "sha256", "bytes" }`, relative to the folder of the source file, which it must include; without it, the entry is the source file alone.

Kinds are `palette`, `patch-pack`, `sample-pack`, `loop`, `song`, `album`, `composer` and `collection`. They describe the entry; they do not change what the checker reads or executes. An installed `composer` runs only when `dawn song --composer` names it, in the sealed song engine and from its locked files ([Write a composer plug-in](./composers.md)). A library is a collection containing entries, not a separate content format.

IDs are lowercase slugs of up to 64 characters and must be unique within the catalog. Local paths and remote metadata have additional string and nesting bounds. Unknown fields are rejected, so misspelled fields cannot silently change the meaning of a source or license declaration.

The lock, `collections.lock.json` (`dawn.collection-lock/v1`), lists each collection's name, source, commit and catalog digest, and each installed entry's origin (repository, commit and path, or URL), folder and files. It holds no time and no credential, and the same installs give the same bytes.

Invalid arguments, malformed catalogs, failed checks and failed transfers exit with code 2 and explain the error on stderr. `update` exits 1 when an entry was left at its version because of a conflict or an error, and `qualify` exits 1 when a song is not qualified. `--help` exits successfully without writing files.
