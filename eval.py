"""Exercise canvas selection and layer scrolling through the native background editor."""
import base64
from contextlib import ExitStack
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import time

out = Path(__file__).resolve().parent
import qa_support as qa
installed = Path("/Applications/Oh My Canvas.app/Contents/MacOS")
desktop = Path(sys.argv[1]).resolve(strict=True)
mode = sys.argv[2]

with TemporaryDirectory(dir=out, prefix="profile-") as folder, ExitStack() as stack:
    profile = Path(folder)
    qa.launch_service(stack, installed, profile)
    native = qa.connect(stack, installed, profile, "omc")
    document = native("create_document", title="Layer scrolling evaluation")["documentId"]

    def create(name, x, y, width=28, height=22, kind="rect", parent=None):
        args = dict(documentId=document, type=kind, x=x, y=y, width=width, height=height,
                    properties=dict(name=name, fills=[{"type":"solid", "color":"#3366cc"}]))
        if parent is not None:
            args["parentId"] = parent
        return native("create_shape", **args)["rawIds"][0]

    def filler(number):
        create(f"Layer sample {number:02}", 470 + (number % 4) * 34, 24 + (number // 4) * 18)

    for number in range(8):
        filler(number)
    outer = create("Outer Beacon Frame", 40, 48, 128, 105, "frame")
    inner = create("Inner Beacon Frame", 15, 15, 94, 75, "frame", outer)
    child = create("Deep Beacon Shape", 10, 10, 55, 45, parent=inner)
    for number in range(8, 38):
        filler(number)
    standalone = create("Independent Beacon", 220, 112, 64, 51)
    for number in range(38, 62):
        filler(number)

    qa.launch(stack, [desktop, "--profile", profile, "--automation-background",
                      "--smoke-exit-ms", "60000", "--smoke-size", "1280x800"])
    ui = qa.connect(stack, installed, profile, "figcraft")

    def inspect():
        result = ui("inspect_ui")
        assert not any(window["focused"] for window in result.get("windows", []))
        return result

    def capture(name, persist=True):
        image = base64.b64decode(ui("screenshot", window=True)["base64"], validate=True)
        if persist:
            path = out / (mode + "-" + name + ".png")
            path.write_bytes(image)
            return path
        return image

    qa.wait_for("unfocused Home", inspect, lambda state: state.get("attached") and state.get("home"))
    native("open_document", id=document, focus=True)
    qa.wait_for("editor opened", inspect, lambda state: not state["home"] and state["documentId"])
    ui("run_command", command="view.zoom100")
    def fit():
        ui("run_command", command="view.zoomFit")
        return inspect()["view"]["zoom"]

    qa.wait_for("layer scene built", fit, lambda zoom: abs(zoom - 1.0) > 1e-6)
    ui("run_command", command="layers.collapseAll")
    time.sleep(0.15)
    filenames = [capture("initial")]

    def pick(x, y):
        ui("pointer", kind="click", x=x, y=y)
        selected = inspect()["selection"]
        assert len(selected) == 1, selected
        return selected[0]

    nested_selection = pick(80, 86)
    for i in range(7):
        filenames.append(capture(f"frame-sample-{i}"))
        time.sleep(0.02)
    time.sleep(0.3)
    filenames.append(capture("frame-settled"))
    assert pick(235, 125) != nested_selection
    time.sleep(0.32)
    filenames.append(capture("standalone"))
    assert inspect()["layersCollapsed"] == 2

    def pixels(path):
        return subprocess.check_output([
            "ffmpeg", "-v", "error", "-threads", "1", "-i", path,
            "-vf", "crop=454:1096:110:464", "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1",
        ], timeout=10)

    frames = [pixels(path) for path in filenames]
    assert all(len(image) == 454 * 1096 for image in frames)
    if mode == "baseline":
        assert frames[0] == frames[-2]
        print("REPRODUCED: selecting a child in an already-visible collapsed frame leaves the old sidebar pixel-identical.")
    else:
        assert frames[0] != frames[-2], "Visible frame failed to move and receive an outline"
        assert frames[-3] == frames[-2], "Layer scroll did not settle"
        assert frames[-1] != frames[-2], "Standalone selection did not move the sidebar"
        assert len(set(frames[:-2])) >= 3
        def top_row_pixels(path, crop):
            return subprocess.check_output([
                "ffmpeg", "-v", "error", "-threads", "1", "-i", path,
                "-vf", crop, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
            ], timeout=10)
        outline = top_row_pixels(filenames[-2], "crop=4:22:124:478")
        blue_pixels = sum(
            blue > 220 and blue - red > 65 and green - red > 20
            for red, green, blue in zip(outline[::3], outline[1::3], outline[2::3], strict=True)
        )
        assert blue_pixels >= 22, "No outer-frame outline at the top row"
        standalone_fill = top_row_pixels(filenames[-1], "crop=8:22:132:478")
        assert standalone_fill.count(bytes((239, 246, 255))) >= 24, "Standalone row did not reach the top"
        print("PASS: the already-visible outer frame animated to the top and gained a blue outline. One idle interval after the standalone click, its selected row was at the top.")
