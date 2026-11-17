"""Independently measure the field-relay card raster from a Paper board JPEG."""
import argparse
import hashlib
import json
from pathlib import Path
from statistics import median
import subprocess


def sample_board(fixture, scope, raw, width, height, rgb):
    if fixture["source_family_id"] != "field-relay":
        raise ValueError("Raster calibration applies only to the field-relay layout")
    board = raw["details"][scope["boardId"]]
    if width != board["width"] or height != board["height"] or len(rgb) != 3 * width * height:
        raise ValueError("Image must match the native board dimensions at 1x")

    def pixel(x, y):
        offset = (y * width + x) * 3
        return rgb[offset:offset + 3]

    result = {}
    calibration = set()
    for row in fixture["start"]["nodes"]:
        if "bindings" not in row:
            continue
        identifier = scope["nodes"][row["key"]]
        native = raw["details"][identifier]
        x = native["worldX"] - board["worldX"]
        y = native["worldY"] - board["worldY"]
        if (type(x) is not int or type(y) is not int or native["width"] != 130 or native["height"] != 92
                or not 0 <= x <= width - 130 or not 0 <= y <= height - 92):
            raise ValueError(f"Unknown raster bounds for {row['key']}")
        interior = [pixel(x + px, y + py) for px in range(60, 105, 4) for py in range(76, 86, 2)]
        channel_medians = [round(median(values)) for values in zip(*interior)]
        if any(any(abs(value - reference) > 5 for value, reference in zip(sample, channel_medians))
               for sample in interior):
            raise ValueError(f"Nonuniform card background for {row['key']}")
        ink_rows = [dy for dy in range(35, 70) if sum(
            min(pixel(x + dx, y + dy)) >= 215 for dx in range(6, 59)
        ) >= 2]
        if not ink_rows or ink_rows != list(range(ink_rows[0], ink_rows[0] + len(ink_rows))) or not 7 <= len(ink_rows) <= 11:
            raise ValueError(f"Could not locate the fixed Verified line for {row['key']}")
        if "gap" not in row["bindings"]:
            local_gap = raw["computed"]["styles"][identifier]["gap"]
            if local_gap != f"{row['gap']}px":
                raise ValueError(f"Unexpected local gap calibration value for {row['key']}")
            calibration.add((row["gap"], ink_rows[0]))
        result[identifier] = {"fill_rgb": channel_medians, "ink_y": ink_rows[0]}

    offsets = {first_ink - gap for gap, first_ink in calibration}
    if len(calibration) != 2 or len(offsets) != 1:
        raise ValueError("Both unchanged local gap overrides must calibrate the same raster offset")
    offset = offsets.pop()
    for values in result.values():
        values["gap"] = values["ink_y"] - offset
    return {"cards": result, "gap_calibration": sorted(calibration), "font_offset_px": offset}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("fixture", type=Path)
    parser.add_argument("scope", type=Path)
    parser.add_argument("capture", type=Path)
    parser.add_argument("jpeg", type=Path)
    args = parser.parse_args()

    def load(path):
        return json.loads(path.read_text(encoding="utf-8"))

    fixture = load(args.fixture)
    scope = load(args.scope)
    raw = load(args.capture)["raw"]
    if args.jpeg.read_bytes()[:3] != b"\xff\xd8\xff":
        parser.error("screenshot must be the original Paper board JPEG")
    dimensions = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", str(args.jpeg)],
        stdout=subprocess.PIPE, check=True, text=True,
    ).stdout.strip()
    width, height = (int(value) for value in dimensions.split(","))
    rgb = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(args.jpeg), "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
        stdout=subprocess.PIPE, check=True,
    ).stdout
    result = sample_board(fixture, scope, raw, width, height, rgb)
    output = {"schema": "paper-ld03-field-relay-raster/1", "fileId": scope["fileId"],
              "boardId": scope["boardId"], "fixture_sha256": fixture["fixture_sha256"],
              "screenshot_sha256": hashlib.sha256(args.jpeg.read_bytes()).hexdigest(),
              "capture_sha256": hashlib.sha256(args.capture.read_bytes()).hexdigest(), **result}
    print(json.dumps(output))


if __name__ == "__main__":
    main()
