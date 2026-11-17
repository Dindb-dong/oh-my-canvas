"""Independently verify Penpot's board-export pixels and normalize LD06 facts."""

import argparse
import hashlib
import json
from pathlib import Path

from PIL import Image


def crop_for(width, height, target_width, target_height):
    scale = max(target_width / width, target_height / height)
    cropped_width, cropped_height = target_width / scale, target_height / scale
    return [(width - cropped_width) / 2, (height - cropped_height) / 2,
            cropped_width, cropped_height]


def pixel_crop(source, rendered, bounds, crop):
    x, y, width, height = map(round, bounds)
    cx, cy, cw, ch = crop
    matches = samples = 0
    for dy in range(4, height - 4, 6):
        sy = int(cy + (dy + 0.5) * ch / height)
        for dx in range(4, width - 4, 6):
            sx = int(cx + (dx + 0.5) * cw / width)
            if not (1 <= sx < source.width - 1 and 1 <= sy < source.height - 1):
                continue
            neighbors = {source.getpixel((sx + xx, sy + yy))
                         for xx in (-1, 0, 1) for yy in (-1, 0, 1)}
            if len(neighbors) != 1:
                continue
            samples += 1
            matches += rendered.getpixel((x + dx, y + dy)) in neighbors
    return {"samples": samples, "matches": matches,
            "matches_center_crop": samples >= 30 and matches * 100 >= 98 * samples}


def raster_ink(image, bounds):
    x, y, width, height = map(round, bounds)
    area = image.crop((x, y, x + width, y + height))
    return sum(a > 60 and max(r, g, b) < 75 for r, g, b, a in area.getdata())


def normalize(fixture, native, assets, output):
    by_png = {row["sha256"]: row for row in fixture["assets"] if "rgba_sha256" in row}
    candidate = {"handoff": None}
    raster = {}
    for phase, observed in native["phases"].items():
        candidate[phase] = observed
        image_path = output / f"{phase}.png"
        rendered = None
        if image_path.is_file():
            with Image.open(image_path) as image:
                if image.size == (fixture["viewport"]["width"], fixture["viewport"]["height"]):
                    rendered = image.convert("RGBA")
        phase_raster = raster[phase] = {"board_size_verified": rendered is not None,
                                         "center_crop": {}, "text_ink": {}}
        for node in observed["nodes"]:
            if node["kind"] == "text" and rendered is not None:
                phase_raster["text_ink"][node["key"]] = raster_ink(rendered, node["bounds"])
            if node["kind"] != "image":
                continue
            meta = by_png.get(node["stored_png_sha256"])
            if meta is None:
                continue
            source_path = assets / meta["name"]
            if hashlib.sha256(source_path.read_bytes()).hexdigest() != node["stored_png_sha256"]:
                continue
            with Image.open(source_path) as source:
                source = source.convert("RGBA")
            if list(source.size) != node["native_image_size"]:
                continue
            rgba_digest = hashlib.sha256(source.tobytes()).hexdigest()
            if rgba_digest != meta["rgba_sha256"]:
                continue
            node["asset_rgba_sha256"] = rgba_digest
            if not node["native_center_cover"] or rendered is None:
                continue
            crop = crop_for(source.width, source.height, *node["bounds"][2:])
            comparison = pixel_crop(source, rendered, node["bounds"], crop)
            phase_raster["center_crop"][node["key"]] = comparison
            if comparison["matches_center_crop"]:
                node["crop_source_px"] = crop
    return candidate, raster


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("fixture", type=Path)
    parser.add_argument("assets", type=Path)
    parser.add_argument("observations", type=Path)
    parser.add_argument("candidate", type=Path)
    args = parser.parse_args()
    fixture = json.loads(args.fixture.read_text(encoding="utf-8"))
    native = json.loads(args.observations.read_text(encoding="utf-8"))
    evidence, raster = normalize(fixture, native, args.assets, args.observations.parent)
    for path, value in ((args.candidate, evidence), (args.observations.with_name("raster-report.json"), raster)):
        with path.open("x", encoding="utf-8") as file:
            json.dump(value, file, ensure_ascii=False, indent=2)
            file.write("\n")
