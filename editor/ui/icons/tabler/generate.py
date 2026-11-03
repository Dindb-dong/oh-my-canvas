"""Build the small inline runtime from byte-verified upstream SVGs."""
import hashlib
import json
import pathlib
import re
folder = pathlib.Path(__file__).resolve().parent
manifest = json.loads((folder / 'manifest.json').read_text())
icons = {}
for entry in manifest['files']:
    data = (folder / entry['file']).read_bytes()
    if hashlib.sha256(data).hexdigest() != entry['sha256']:
        raise RuntimeError('Upstream bytes changed: ' + entry['file'])
    if entry['file'].endswith('.svg'):
        icons[entry['file'][:-4]] = re.search(r'<svg\b[\s\S]*', data.decode()).group(0).strip()
source = '''// Generated from pinned Tabler Icons v3.50.0; MIT license in ./LICENSE.
// Path geometry is unchanged. Only root presentation/accessibility attributes are set at use.
const icons = %s;
export const iconNames = Object.freeze(Object.keys(icons));
export function svgIcon(name, size = 18) {
    if (!Object.hasOwn(icons, name)) throw new Error(`Unknown Tabler icon: ${name}`);
    const source = icons[name];
    return source.replace(/<svg\\b[^>]*>/, opening => {
        const attributes = opening.replace(/\\s(?:width|height|stroke-width|class)="[^"]*"/g, "").slice(0, -1);
        return `${attributes} width="${size}" height="${size}" stroke-width="1.75" class="ui-icon" data-icon="${name}" aria-hidden="true" focusable="false">`;
    });
}
''' % json.dumps(icons, ensure_ascii=False, indent=2)
(folder / 'runtime.js').write_text(source)
manifest['generated'] = {'file': 'runtime.js', 'sha256': hashlib.sha256(source.encode()).hexdigest(), 'description': 'Inline SVG subset; unchanged upstream path geometry; SVG root size/stroke/class/decorative accessibility attributes set at use.'}
(folder / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(f'{len(icons)} SVG icons; {len(source.encode())} runtime bytes')
