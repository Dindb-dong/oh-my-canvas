# Large design-file fixture

Source: [iOS and iPadOS 27, Figma Community](https://www.figma.com/community/file/1651309003795292092/ios-and-ipados-27).

This third-party snapshot was exported as a full local copy from Figma on 2026-11-10. It is included for the explicitly requested import compatibility work, separately from the synthetic fixtures.

- File: `iOS-and-iPadOS-27.fig`
- Bytes: 160627671
- SHA-256: `c7c4fdbe469ae451c9a3d3d384a2102fa08dfaa220a1277e2df17fc2146c5ee7`
- Expected imported structure: 46 user pages, 39363 objects including page roots, 160 referenced bitmap assets.

The file is stored with Git LFS. Retrieve the real bytes before running compatibility evaluation:

```sh
git lfs pull --include="fixtures/design-files/iOS-and-iPadOS-27.fig"
npm run build
node scripts/design-library-e2e.mjs "$PWD/fixtures/design-files/iOS-and-iPadOS-27.fig"
```

The runner uses a temporary isolated app profile. Its results do not establish perfect source fidelity. See [the status and architecture proposal](../../docs/DESIGN_FILE_IMPORT.md) for known correctness and performance gaps.
