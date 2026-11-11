#!/usr/bin/env bash
# Prebuilt Skia links the host FreeType/fontconfig ABI. No distro upgrade is
# required when these runtime libraries are already present on the runner.
set -euo pipefail
link_dir="${OMC_NATIVE_LINK_DIR:-${RUNNER_TEMP:-/tmp}/omc-native-link}"
mkdir -p "$link_dir"
python3 - "$link_dir" <<'PY'
import ctypes
import pathlib
import re
import shutil
import subprocess
import sys

destination = pathlib.Path(sys.argv[1])
ldconfig = shutil.which('ldconfig') or '/sbin/ldconfig'
listing = subprocess.check_output([ldconfig, '-p'], text=True)
for linker_name, soname in [('libfreetype.so', 'libfreetype.so.6'),
                            ('libfontconfig.so', 'libfontconfig.so.1')]:
    matches = re.findall(r'^\s*' + re.escape(soname) + r'\s+.*?=>\s+(\S+)$', listing, re.M)
    candidates = [pathlib.Path(name) for name in matches if pathlib.Path(name).is_file()]
    if not candidates:
        raise SystemExit(f'Missing native runtime {soname}; install the distro runtime package before building.')
    source = next((path for path in candidates if 'x86-64' not in str(path)), candidates[0])
    ctypes.CDLL(str(source))
    target = destination / linker_name
    if target.is_symlink():
        target.unlink()
    if target.exists():
        raise SystemExit(f'Refusing to replace non-symlink {target}')
    target.symlink_to(source)
    print(f'{linker_name}: {source}')
PY
if [[ -n "${GITHUB_ENV:-}" ]]; then
  printf '%s\n' "LIBRARY_PATH=$link_dir${LIBRARY_PATH:+:$LIBRARY_PATH}" >> "$GITHUB_ENV"
else
  printf 'LIBRARY_PATH=%s\n' "$link_dir${LIBRARY_PATH:+:$LIBRARY_PATH}"
fi
