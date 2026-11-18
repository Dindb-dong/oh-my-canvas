# Large design-file fixture

Source: [iOS and iPadOS 27, Figma Community](https://www.figma.com/community/file/1651309003795292092/ios-and-ipados-27).

This third-party snapshot was exported as a full local copy from Figma on 2026-11-10. It is included for the explicitly requested import compatibility work, separately from the synthetic fixtures.

- File: `iOS-and-iPadOS-27.fig`
- Bytes: 160627671
- SHA-256: `c7c4fdbe469ae451c9a3d3d384a2102fa08dfaa220a1277e2df17fc2146c5ee7`
- Historical Electron import structure: 46 user pages, 39363 objects including page roots, 160 referenced bitmap assets. This is not a native acceptance result.

The file is stored with Git LFS. Retrieve the real bytes before running compatibility evaluation:

```sh
git lfs pull --include="fixtures/design-files/iOS-and-iPadOS-27.fig"
```

The former Electron reproduction runner is preserved at the [historical source revision](https://github.com/Dindb-dong/oh-my-canvas/blob/dade9931ee6cb58b376c60967d742a1c83e6cdc8/scripts/design-library-e2e.mjs); it is not a current native test command. Its structure counts do not establish source fidelity.

For current native import contracts, use the [native verification commands](../../docs/TESTING.md#native-contracts). Those SDK tests do not certify this entire large fixture. The published [D-REAL import observation](../../docs/benchmarks/results/2026-11-18/README.md#diagnostics-retries-and-unfinished-qualification) failed on the tested native routes; the later fix had focused tests but no successful rerun against this file. See the [historical architecture record](../../docs/DESIGN_FILE_IMPORT.md) for the earlier implementation.
