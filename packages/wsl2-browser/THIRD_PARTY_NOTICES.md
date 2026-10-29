# Third-party notices

This package's own source is licensed under the repository's MIT license.

The runtime preparation command installs these packages from the npm registry using the exact versions and integrity hashes in `package-lock.json`:

- `@playwright/cli` 0.1.22 — Apache-2.0
- `playwright` 1.64.0-alpha-1790635538000 — Apache-2.0
- `playwright-core` 1.64.0-alpha-1790635538000 — Apache-2.0

The Apache License 2.0 is available at <https://www.apache.org/licenses/LICENSE-2.0>. Third-party package source and the upstream Agent Skill are not included in this repository. The local WSL2 patches are applied only to the external runtime cache after lockfile installation.
