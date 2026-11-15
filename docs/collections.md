# Organize a collection

A collection is a catalog of sounds, loops, songs, albums or other collections. Entries point to files or remote sources; they do not require a particular repository layout. Create a catalog, add references with credits and license labels, then check local references before sharing it.

The collection tools are part of the public [DAWN SDK](https://github.com/hraness/dawn-sdk) and of the full `dawn` command. Catalog checks never fetch remote content, evaluate a project, install dependencies or publish files.

## Start a catalog

Choose a new directory whose parent exists:

```sh
dawn-collection init my-library --id my-library --title "My library" --curator "Your name" --template artist
dawn-collection check my-library/dawn.collection.json --json
```

Replace the title and curator with your own values. The command writes an empty `dawn.collection.json` and a `CONTRIBUTING.md` guide. An empty catalog is valid and its check reports zero entries. Existing directories, files and symlinks are refused. A failed write can leave a reserved directory for inspection; choose a new destination after investigating the failure.

Choose `--template pack` for a sound pack, `artist` for a library of projects, or `community` for a catalog of references. The default is `community`. Templates provide contribution instructions, not sample music or a license grant. Their suggested layouts are optional.

The catalog convention is `dawn.collection.json`, but `check` accepts any explicit local filename. It does not scan a repository for projects.

## Add a local entry

Copy a palette you own to `sounds/palette.json` beneath your catalog directory. Edit the catalog's `entries` array to include this shape, replacing the title, credits and license label with values that apply to your work:

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

Run `collection check` again. It checks that the local reference is a regular file inside the allowed root. It does not interpret the file as a palette or check its assets. Use `dawn-palette check` to validate a palette's contents separately. Referencing a TypeScript song does not execute it; evaluate only source you trust through the normal project workflow.

Paths are relative to the catalog's directory. For a catalog in `catalogs/dawn.collection.json` that refers to `../sounds/palette.json`, select the containing library as the root:

```sh
dawn-collection check my-library/catalogs/dawn.collection.json --root my-library
```

Without `--root`, the allowed root is the catalog's parent directory. Both the catalog and its local references must remain inside the selected root after resolving symlinks. A path outside it is rejected. The root is a filesystem boundary for this check, not a claim that the folder is a Git repository.

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

All source types accept an optional `entry` selector. An HTTPS source has `type: "https"` and `url`. URLs must use HTTPS and contain no credentials, query string or fragment. The `entry` field identifies an item in the referenced catalog; this command does not resolve it. GitHub paths are repository-relative. GitHub refs and content digests remain distinct: a branch name is a reference, not a content lock.

Checks validate the descriptor syntax and report every remote entry under `remoteUnchecked`. They do not contact the host, verify that a revision or selected entry exists, authenticate an author, or recursively expand another collection. A reference-only community catalog can pass with every remote entry unchecked. Availability, pinned installation and update planning are future capabilities.

## Record credits and integrity

Keep `curator` separate from each entry's `credits`. A curator selects work; credits identify its claimed creators and contributors. Neither field authenticates an identity.

Every entry needs at least one license label in `licenses`. Its keys are `content`, `software`, `samples` and `trace`; supply the labels applicable to the referenced work. DAWN checks their shape, not legal authority or compatibility. A repository's software license does not automatically cover its music, samples or trace. Public availability does not grant trace indexing or training permission.

A source may declare `sha256` and `bytes` together. The digest is 64 lowercase hexadecimal characters and the size is a nonnegative safe integer of at most 1 TiB. For local files, `check` verifies both against the file. For remote sources they remain unverified declarations. Hashes identify bytes, not authorship.

`--json` reports the collection identity, version, entry count, local files checked, hashes verified and remote entries unchecked. Without a declared hash, a local file check confirms the file reference only. Passing does not validate content schemas, a project's asset closure, source safety or licensing rights.

## Format and limits

The root object has `schema: "dawn.collection/v1"`, `id`, `version`, `title`, `curator`, optional `description`, and `entries`. Versions use numeric `major.minor.patch`. Each entry has `id`, `kind`, `title`, `credits`, `licenses`, `source`, and optional `description`.

Kinds are `palette`, `patch-pack`, `sample-pack`, `loop`, `song`, `album` and `collection`. They describe the entry; they do not change what the checker reads or executes. A library is a collection containing entries, not a separate content format.

Catalog files are limited to 8 MiB and 512 entries. IDs are lowercase slugs of up to 64 characters and must be unique within the catalog. A check hashes at most 64 MiB of referenced local content in total. Local paths and remote metadata have additional string and nesting bounds. Unknown fields are rejected, so misspelled fields cannot silently change the meaning of a source or license declaration.

Invalid arguments, malformed catalogs and failed local reference or hash checks exit with code 2 and explain the error on stderr. `--help` exits successfully without writing files. Remote entries being unchecked is reported explicitly and does not make a structurally valid catalog fail.
