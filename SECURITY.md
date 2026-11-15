# Security

Report a vulnerability privately through
[GitHub security advisories](https://github.com/hraness/dawn-sdk/security/advisories/new).
Please don't open a public issue for it.

The palette and collection tools read untrusted files. They are meant to
reject oversized input, paths that escape the folder being checked, and
symbolic links, and never to run code from a palette or catalog, fetch a
remote source, or overwrite an existing path. A way around any of those is in
scope.
