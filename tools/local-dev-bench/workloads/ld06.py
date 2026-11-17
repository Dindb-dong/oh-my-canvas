"""Local raster, font, content and source-handoff fixtures."""
import hashlib
import json

from ld01 import png_asset


VARIANTS = {
    "metro-stories": {
        "title": "Metro guide",
        "initial": [
            ("Central Plaza", "서울 광장"), ("Market Gate", "부산 시장"),
            ("Quiet Loop", "제주 산책"), ("River West", "강변 서쪽"),
            ("Studio Lane", "공방 골목"), ("Hillside Stop", "언덕 정류장"),
        ],
        "updates": {2: ("Coastal Loop", "제주 해안"), 5: ("Hill Garden", "언덕 정원")},
        "palette": [(32, 60, 110), (88, 121, 152), (241, 211, 151), (224, 236, 242)],
        "columns": 3,
    },
    "garden-labels": {
        "title": "Garden atlas",
        "initial": [
            ("Entry Birch", "입구 자작나무"), ("Herb Bench", "허브 화단"),
            ("Water Court", "물 정원"), ("Shade Walk", "그늘 산책"),
            ("Young Pines", "어린 소나무"), ("Stone House", "돌 집"),
        ],
        "updates": {1: ("Sage Bench", "세이지 화단"), 4: ("River Pines", "강변 소나무")},
        "palette": [(39, 86, 70), (102, 147, 115), (215, 183, 91), (225, 235, 204)],
        "columns": 2,
    },
}


def required_glyphs(source):
    strings = (line for entries in (source["initial"], source["updates"].values())
               for row in entries for line in row)
    return sorted({char for text in strings for char in text if not char.isspace()})


def make_assets(source):
    assets = []
    repeated = {slot for slot in range(6) if slot not in source['updates']}
    duplicate, original = sorted(repeated)[:2]
    for stage, slots in (("initial", range(6)), ("replacement", source["updates"])):
        for slot in slots:
            # Two separately named initial files intentionally contain identical bytes.
            seed = (duplicate + 1 if slot == original else slot + 1) if stage == "initial" else 8 + slot
            width, height = (128, 96) if seed % 2 else (96, 128)
            rows = []
            for y in range(height):
                row = []
                for x in range(width):
                    tile = (x // (9 + seed) + y // (19 - seed) + seed + (x * y) // 1000) % 4
                    row.extend((*source["palette"][tile], 255))
                rows.append(bytes(row))
            assets.append(png_asset(f"{stage}-image-{slot + 1}.png", width, height, rows))
    labels = {
        "initial": [{"slot": slot, "name": item[0], "caption": item[1]}
                    for slot, item in enumerate(source["initial"])],
        "updates": [{"slot": slot, "name": item[0], "caption": item[1]}
                    for slot, item in source["updates"].items()],
    }
    data = (json.dumps(labels, ensure_ascii=False, sort_keys=True) + "\n").encode("utf-8")
    assets.append(({
        "name": "content.json",
        "media_type": "application/json",
        "license": "CC0-1.0",
        "sha256": hashlib.sha256(data).hexdigest(),
    }, data))
    return assets


def _crop(meta, area):
    _, _, display_width, display_height = area
    width, height = meta["width"], meta["height"]
    if width * display_height > height * display_width:
        cropped_width = height * display_width / display_height
        return [(width - cropped_width) / 2, 0, cropped_width, height]
    cropped_height = width * display_height / display_width
    return [0, (height - cropped_height) / 2, width, cropped_height]


def fixture(variant, font=None):
    source = VARIANTS[variant]
    assets = [meta for meta, _ in make_assets(source)]
    by_name = {meta["name"]: meta for meta in assets}
    initial = [
        {"key": "canvas", "kind": "frame", "parent": None, "bounds": [0, 0, 1040, 920]},
        {"key": "header", "kind": "text", "parent": "canvas", "bounds": [24, 20, 400, 40],
         "text": source["title"]},
    ]
    slots = []
    for slot in range(6):
        columns = source["columns"]
        x = 24 + slot % columns * (332 if columns == 3 else 486)
        y = 88 + slot // columns * (226 if columns == 3 else 244)
        key = f"card/{slot}"
        initial.append({"key": key, "kind": "frame", "parent": "canvas",
                        "bounds": [x, y, 306 if columns == 3 else 454, 200]})
        slots.append((key, x, y))

    glyphs = required_glyphs(source)

    def filled(final):
        nodes = list(initial)
        for slot, (key, x, y) in enumerate(slots):
            replacement = final and slot in source["updates"]
            name, caption = source["updates"][slot] if replacement else source["initial"][slot]
            stage = "replacement" if replacement else "initial"
            meta = by_name[f"{stage}-image-{slot + 1}.png"]
            area = [x + 16, y + 16, 160, 104] if source["columns"] == 3 else [x + 20, y + 20, 148, 116]
            nodes.append({
                "key": key + "/image", "kind": "image", "parent": key, "bounds": area,
                "asset_rgba_sha256": meta["rgba_sha256"], "crop_source_px": _crop(meta, area),
            })
            text_x = x + (16 if source["columns"] == 3 else 190)
            text_y = y + (132 if source["columns"] == 3 else 56)
            for index, (role, line) in enumerate((("name", name), ("caption", caption))):
                nodes.append({
                    "key": key + "/" + role, "kind": "text", "parent": key,
                    "bounds": [text_x, text_y + index * 25, 246, 22],
                    "text": line, "font_family": font["family"] if font else None,
                    "font_sha256": font["sha256"] if font else None,
                    "fully_visible": True,
                })
        return {"nodes": nodes, "styles": []}

    loaded, expected = filled(False), filled(True)
    locations = {}
    for node in expected["nodes"]:
        asset_types = ("asset_rgba_sha256", "font_sha256")
        if any(field in node for field in asset_types):
            locations[node["key"]] = {
                field: node[field]
                for field in ("asset_rgba_sha256", "crop_source_px", "text", "font_sha256", "font_family", "fully_visible")
                if field in node
            }

    return {
        "brief": ("Populate the prepared six-card design from the initial local images, font and "
                  "content JSON. Save the loaded state. Apply the two image and two content "
                  "replacements from the supplied local assets. Reopen the design and provide "
                  "a reproducible local source repository with its assets."),
        "viewport": {"width": 1040, "height": 920, "scale": 1},
        "font": font,
        "required_glyphs": glyphs,
        "font_registered": font is not None,
        "assets": [*assets, *([font] if font else [])],
        "start": {"nodes": initial, "styles": []},
        "loaded": loaded,
        "expected": expected,
        "handoff_values": locations,
        "logical_objects": len(expected["nodes"]),
    }
