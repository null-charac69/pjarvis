# Changelog

## Unreleased

### Added

- Phase 8 checklist and repeatable backend, desktop, and Windows packaging procedures.
- Operations, privacy, release, and release-readiness guidance for the implemented Phase 1–7 feature set.
- Electron backend-origin tests for loopback HTTP, remote HTTPS, and rejected remote HTTP; display-name trimming, fallback, and length-bound tests.

### Changed

- Electron 44.6.0 and electron-builder 26.15.3 are pinned in the desktop lockfile. Node.js 22.12 or newer is required for Electron development and packaging.
- Production settings fail closed on unsafe wildcard origins and incomplete selected-provider configuration; unconfigured weather is no longer selected in the production profile.
- SQLite file databases use WAL and a bounded lock timeout. Persistence commits/flushes await completion across cancellation, and startup marks interrupted tasks failed without resuming tool actions.
- Workspace traversal checks account for Windows junctions; Electron permits remote backend URLs only over HTTPS.

### Security and validation

- Production-only npm audit currently reports zero advisories. The complete desktop build/packaging dependency tree reports eight moderate advisories and no high or critical advisories; see [release readiness](docs/RELEASE_READINESS.md).
- Electron runtime execution, installer behavior, signing, live provider credentials, and general production readiness remain unverified.
