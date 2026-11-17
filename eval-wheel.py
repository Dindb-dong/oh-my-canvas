"""Inject synthetic wheel events directly into the native App::wheel path."""
from contextlib import ExitStack
from pathlib import Path
from tempfile import TemporaryDirectory
import importlib.util
import sys
import time
import math

out = Path(__file__).resolve().parent
import qa_support as qa
installed = Path("/Applications/Oh My Canvas.app/Contents/MacOS")
desktop = Path(sys.argv[1]).resolve(strict=True)

with TemporaryDirectory(dir=out, prefix="wheel-profile-") as folder, ExitStack() as stack:
    profile = Path(folder)
    qa.launch_service(stack, installed, profile)
    native = qa.connect(stack, installed, profile, "omc")
    document = native("create_document", title="Scroll input evaluation")["documentId"]
    for i in range(32):
        native("create_shape", documentId=document, type="rect", x=i * 15, y=20,
               width=10, height=10, properties={"name": f"Layer {i + 1:02d}"})
    qa.launch(stack, [desktop, "--profile", profile, "--automation-background",
                      "--smoke-exit-ms", "60000", "--smoke-size", "1280x800"])
    ui = qa.connect(stack, installed, profile, "figcraft")

    def inspect():
        result = ui("inspect_ui")
        assert not any(window["focused"] for window in result.get("windows", []))
        return result

    def event(mode, distance=0.):
        return ui("pointer", kind="hover", x=mode, y=distance)["qaLayerScroll"]

    def offset(mode, distance=0.):
        return event(mode, distance)["offset"]

    qa.wait_for("unfocused Home", inspect, lambda state: state.get("attached") and state.get("home"))
    native("open_document", id=document, focus=True)
    qa.wait_for("active editor", inspect, lambda state: not state["home"] and state["documentId"])
    metrics = qa.wait_for("layer tree populated", lambda: event(4), lambda state: state["rows"] == 32)
    assert metrics["offset"] == 0 and metrics["viewport"] > 32
    assert offset(1, 0.5) == 0.25
    assert offset(1, 8.5) == 4.5
    assert offset(1, -1.5) == 3.75
    assert offset(3, 18.0) == 3.75
    maximum = 37 * metrics["rows"] - metrics["viewport"]
    assert offset(1, 10000.) == maximum
    assert offset(1, -10000.) == 0
    assert offset(2, 1.) == 0
    positions = [offset(4)]
    for _ in range(10):
        time.sleep(0.025)
        positions.append(offset(4))
    assert any(0. < position < 30. for position in positions), positions
    assert positions == sorted(positions), positions
    assert math.isclose(positions[-1], 30., abs_tol=0.01), positions
    print("PASS: fractional offsets 0.25, 4.5, 3.75 at 2x; header ignores scroll; ends clamp at 0 and", maximum)
    print("PASS: mouse-wheel line eased through", [round(pos, 2) for pos in positions], "px")
    inspect()
