"""Materialize an offline LD05 fixture and apply only its scheduled source patches."""

import argparse
import hashlib
from html import escape
import json
from pathlib import Path
import struct
import zlib

from ld05_contract import FAMILIES, fixture


MAIN = """import {createCard} from './card.mjs';
import {cards, extraCard, inputRule, messages} from './data.mjs';

const list = document.querySelector('.cards');
list.append(...cards.map(createCard));
const toggle = document.querySelector('#toggle');
const state = document.querySelector('#state');
toggle.addEventListener('click', () => {
  const selected = toggle.getAttribute('aria-pressed') !== 'true';
  toggle.setAttribute('aria-pressed', String(selected));
  state.textContent = selected ? messages.selected : messages.unselected;
});

// Scheduled status patch
// Scheduled form patch
// Scheduled list patch
"""

CARD = """export function createCard({title, detail, image, variant = 'standard'}) {
  const entry = document.createElement('li');
  const card = document.createElement('article');
  card.className = 'card';
  card.dataset.variant = variant;
  const media = document.createElement('img');
  media.src = './assets/' + image;
  media.width = 64;
  media.height = 36;
  media.alt = '';
  const heading = document.createElement('h2');
  heading.textContent = title;
  const body = document.createElement('p');
  body.textContent = detail;
  card.append(media, heading, body);
  entry.append(card);
  return entry;
}
"""

STYLES = """@font-face {
  font-family: 'Fixture UI';
  src: local('Inter');
}
:root {
  --card-gap: 12px;
  --card-radius: 6px;
  --card-heading-size: 20px;
  --accent: #253357;
  --variant-border: #718096;
  color: #182132;
  background: #f5f6fa;
  font: 1rem/1.5 'Fixture UI', system-ui, sans-serif;
}
main { inline-size: min(100% - 2rem, 70rem); margin-inline: auto; }
.cards { display: flex; flex-direction: column; padding-inline-start: 1.5rem; gap: var(--card-gap); }
.cards li { min-inline-size: 0; }
.card {
  padding: 1rem;
  border: 2px solid transparent;
  border-radius: var(--card-radius);
  background: white;
  overflow-wrap: anywhere;
}
.card[data-variant]:not([data-variant="standard"]) { border-color: var(--variant-border); }
.card img { display: block; inline-size: 100%; block-size: auto; aspect-ratio: 16 / 9; }
.card h2 { font-size: var(--card-heading-size); color: var(--accent); }
form label { display: block; }
input, button { font: inherit; min-block-size: 3rem; max-inline-size: 100%; box-sizing: border-box; }
input[aria-invalid="true"] { border-color: #982a32; }
"""

FORM = """const form = document.querySelector('#fixture-form');
const input = form.elements.value;
const error = document.querySelector('#field-error');
const saved = document.querySelector('#saved');
form.addEventListener('submit', event => {
  event.preventDefault();
  const value = input.value.trim();
  const valid = inputRule === 'bin' ? /^[A-Z][0-9]{2}$/.test(value) : value.length >= 4;
  input.setAttribute('aria-invalid', String(!valid));
  error.hidden = valid;
  error.textContent = valid ? '' : messages.invalid;
  if (!valid) {
    input.setAttribute('aria-describedby', error.id);
    input.focus();
    return;
  }
  input.removeAttribute('aria-describedby');
  saved.textContent = messages.saved + ': ' + value;
});
input.addEventListener('input', () => {
  input.setAttribute('aria-invalid', 'false');
  input.removeAttribute('aria-describedby');
  error.hidden = true;
});
"""

LIST = """const showExtra = document.querySelector('#show-extra');
const extra = createCard(extraCard);
showExtra.addEventListener('change', () => {
  if (showExtra.checked) list.append(extra);
  else extra.remove();
});
"""


def image(palette):
    def chunk(kind, value):
        return struct.pack(">I", len(value)) + kind + value + struct.pack(">I", zlib.crc32(kind + value))
    pixels = bytearray()
    for y in range(36):
        pixels.append(0)
        for x in range(64):
            pixels.extend(palette[((x // 11) + (y // 7) * 2) % len(palette)])
    return b"\x89PNG\r\n\x1a\n" + b"".join([
        chunk(b"IHDR", struct.pack(">IIBBBBB", 64, 36, 8, 2, 0, 0, 0)),
        chunk(b"sRGB", b"\0"), chunk(b"IDAT", zlib.compress(pixels)), chunk(b"IEND", b""),
    ])


def html(family, brief):
    title = escape(brief["title"])
    control = escape(brief["control"])
    state = escape(brief["initial_state"])
    controls = f'<button type="button" id="toggle" aria-pressed="false">{control}</button><p id="state">{state}</p>'
    cards = '<ul class="cards"></ul>'
    if family == "route-board":
        content = f"<header><h1>{title}</h1>{controls}</header>{cards}<!-- form slot --><!-- list slot -->"
    else:
        content = f"<h1>{title}</h1>{cards}<aside>{controls}<!-- form slot --><!-- list slot --></aside>"
    return f"""<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<link rel="stylesheet" href="./theme.css">
<main>{content}</main>
<script type="module" src="./app.mjs"></script>
</html>
"""


def apply_change(text, old, new):
    if text.count(old) != 1:
        raise ValueError(f"scheduled source change requires one retained anchor: {old}")
    return text.replace(old, new)


def prepare(output, family):
    brief = FAMILIES[family]
    output.mkdir()
    assets = output / "assets"
    assets.mkdir()
    filenames = [brief["initial_asset"], brief["updated_asset"]]
    palettes = ([(219, 233, 236), (27, 84, 104), (203, 113, 69)],
                [(244, 222, 200), (127, 55, 38), (49, 93, 84)])
    for number, (filename, palette) in enumerate(zip(filenames, palettes)):
        rotated = palette[number:] + palette[:number] if family == "supply-ledger" else palette
        (assets / filename).write_bytes(image(rotated))
    rows = [{"title": title, "detail": f"Item {index + 1}", "image": filenames[0]}
            for index, title in enumerate(brief["initial_cards"])]
    extra = {"title": brief["extra_card"], "detail": "Extra item", "image": filenames[0]}
    messages = {"selected": brief["changed_state"], "unselected": brief["initial_state"],
                "invalid": brief["error"], "saved": brief["success"]}
    data = {"cards": rows, "extraCard": extra, "messages": messages,
            "inputRule": "note" if family == "route-board" else "bin"}
    files = {
        "index.html": html(family, brief),
        "theme.css": STYLES,
        "app.mjs": MAIN,
        "card.mjs": CARD,
        "data.mjs": "".join(f"export const {name} = {json.dumps(value, ensure_ascii=False)};\n"
                            for name, value in data.items()),
    }
    for name, value in files.items():
        (output / name).write_text(value, encoding="utf-8")


def patch(root, family, cycle):
    index_path, app_path = root / "index.html", root / "app.mjs"
    index = index_path.read_text(encoding="utf-8")
    app = app_path.read_text(encoding="utf-8")
    brief = FAMILIES[family]
    pending = [number for number, anchor in enumerate(
        ("// Scheduled status patch", "// Scheduled form patch", "// Scheduled list patch"), 1
    ) if anchor in app]
    if not pending or cycle != pending[0]:
        raise ValueError("scheduled source patches must be applied once, in cycle order")
    if cycle == 1:
        index = apply_change(index, '<p id="state">', '<p id="state" role="status">')
        app = apply_change(app, '// Scheduled status patch', '// Selection status is announced by the live region.')
    elif cycle == 2:
        field = escape(brief["field"])
        index = apply_change(index, "<!-- form slot -->", f"""
<form id="fixture-form" novalidate>
  <label for="fixture-value">{field}</label>
  <input id="fixture-value" name="value" required aria-invalid="false">
  <p id="field-error" hidden></p>
  <button type="submit">Save</button>
  <p id="saved" role="status"></p>
</form>""")
        app = apply_change(app, '// Scheduled form patch', FORM.rstrip())
    else:
        index = apply_change(index, "<!-- list slot -->",
                             '<input type="checkbox" id="show-extra"><label for="show-extra">Show extra item</label>')
        app = apply_change(app, '// Scheduled list patch', LIST.rstrip())
    index_path.write_text(index, encoding="utf-8")
    app_path.write_text(app, encoding="utf-8")


def manifest(root, family):
    names = ["index.html", "theme.css", "app.mjs", "card.mjs", "data.mjs",
             *(f"assets/{FAMILIES[family][key]}" for key in ("initial_asset", "updated_asset"))]
    files = {name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in names}
    encoded = json.dumps(files, separators=(",", ":"), sort_keys=True)
    return {"fixture_sha256": fixture(family)["fixture_sha256"], "files": files,
            "source_sha256": hashlib.sha256(encoded.encode()).hexdigest()}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("prepare", "patch", "manifest"))
    parser.add_argument("family", choices=FAMILIES)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--cycle", type=int, choices=(1, 2, 3))
    args = parser.parse_args()
    if (args.action == "patch") != (args.cycle is not None):
        parser.error("--cycle is required only for patch")
    try:
        if args.action == "prepare":
            prepare(args.directory, args.family)
        if args.action == "patch":
            patch(args.directory, args.family, args.cycle)
        print(json.dumps(manifest(args.directory, args.family)))
    except (OSError, ValueError) as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()
