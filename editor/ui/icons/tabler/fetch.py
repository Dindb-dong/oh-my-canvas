"""Fetch only the pinned Tabler subset; preserve upstream SVG and license bytes."""
import concurrent.futures
import hashlib
import json
import pathlib
import urllib.request

COMMIT = '6904efd245391ad396df17654738f52f6da8c40e'
BASE = f'https://raw.githubusercontent.com/tabler/tabler-icons/{COMMIT}/'
NAMES = '''pointer frame square circle hexagon star line arrow-up-right vector-bezier ballpen pencil letter-t layout-sidebar arrow-back-up arrow-forward-up command search components minus plus chevron-down copy trash chevron-right dots eye eye-off lock lock-open arrow-up arrow-down x box photo file stack diamond layout-grid adjustments-horizontal zoom-in zoom-out align-box-left-middle align-box-center-middle align-box-right-middle align-box-top-center align-box-bottom-center arrows-horizontal arrows-vertical flip-horizontal flip-vertical clock list external-link download upload check arrows-minimize arrows-maximize color-picker rotate-clockwise unlink select-all'''.split()
FOLDER = pathlib.Path(__file__).resolve().parent

def fetch(name):
    relative = 'LICENSE' if name == 'LICENSE' else f'icons/outline/{name}.svg'
    data = urllib.request.urlopen(BASE + relative, timeout=25).read()
    target = FOLDER / (name if name == 'LICENSE' else name + '.svg')
    target.write_bytes(data)
    return {'file': target.name, 'source': BASE + relative, 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}

with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    rows = list(pool.map(fetch, NAMES + ['LICENSE']))
manifest = {'name': 'Tabler Icons', 'version': '3.50.0', 'commit': COMMIT, 'license': 'MIT', 'upstream': 'https://github.com/tabler/tabler-icons', 'release': 'https://github.com/tabler/tabler-icons/releases/tag/v3.50.0', 'files': sorted(rows, key=lambda row: row['file'])}
(FOLDER / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps({'files': len(rows), 'bytes': sum(row['bytes'] for row in rows)}))
