"""Editable defect fixtures with reversible injection operations for LD07."""
import copy
import hashlib
import struct
import zlib


VARIANTS = {
    "transit-departures": {
        "title": "Platform departures",
        "board": [24, 24, 760, 395],
        "panel": [54, 108, 420, 185],
        "cards": ["Airport", "Central", "Ferry", "Museum", "University"],
        "card_size": (116, 46),
        "layout_field": "wrap",
        "faulty_layout": False,
        "correct_color": "#24548e",
        "decoy_color": "#9b4a2b",
        "style_field": "bindings.fill",
        "symptom": ("Some destinations extend outside the departures panel. "
                    "The service banner looks like the nearby notice."),
        "banner": "Normal service",
        "decoy": "Lift inspection",
    },
    "clinic-check-in": {
        "title": "Clinic check-in",
        "board": [30, 20, 690, 430],
        "panel": [60, 124, 354, 198],
        "cards": ["Triage", "Check in", "Vitals", "Consult", "Checkout", "Follow-up"],
        "card_size": (102, 42),
        "layout_field": "gap",
        "faulty_layout": 42,
        "correct_color": "#28765f",
        "decoy_color": "#7e477b",
        "style_field": "value",
        "symptom": ("The check-in stages sit in extra rows with wider spaces. "
                    "The two arrival badges clash with the surrounding board."),
        "banner": "Arrived",
        "decoy": "Pending review",
    },
}


def _resolve_views(state):
    """Resolve fill references and the one native flow from the current model."""
    nodes = {row["key"]: row for row in state["nodes"]}
    styles = {row["key"]: row for row in state["styles"]}
    panel = nodes["board/flow"]
    left, top, width, _ = panel["bounds"]
    padding = panel["padding"]
    gap = panel["gap"]
    x = left + padding
    y = top + padding
    for row in state["nodes"]:
        if row["parent"] != panel["key"]:
            continue
        _, _, card_width, card_height = row["bounds"]
        if panel["wrap"] and x > left + padding and x + card_width > left + width - padding:
            x = left + padding
            y += card_height + gap
        row["bounds"][:2] = [x, y]
        nodes[row["key"] + "/label"]["bounds"][:2] = [x + 6, y + 8]
        x += card_width + gap
    for row in state["nodes"]:
        if "bindings" in row:
            row["fill"] = styles[row["bindings"]["fill"]]["value"]
    return state


def apply_operations(snapshot, operations):
    state = copy.deepcopy(snapshot)
    for operation in operations:
        row = next(item for item in state[operation["collection"]] if item["key"] == operation["key"])
        field = operation["field"]
        if field == "bindings.fill":
            row = row["bindings"]
            field = "fill"
        if type(row[field]) is not type(operation["from"]) or row[field] != operation["from"]:
            raise ValueError(f"unexpected value for {operation['key']}.{operation['field']}")
        row[field] = operation["to"]
    return _resolve_views(state)


def fixture(variant):
    source = VARIANTS[variant]
    nodes = []
    styles = [
        {"key": "service/accent", "kind": "color", "value": source["correct_color"]},
        {"key": "notice/accent", "kind": "color", "value": source["decoy_color"]},
    ]

    def add(key, kind, parent, bounds, **fields):
        nodes.append({"key": key, "kind": kind, "parent": parent, "bounds": bounds, **fields})

    def badge(key, label, style, bounds):
        add(key, "frame", "board", bounds, bindings={"fill": style})
        x, y, width, height = bounds
        add(key + "/label", "text", key, [x + 8, y + 6, width - 16, height - 12], text=label)

    left, top, width, height = source["board"]
    add("board", "frame", None, [left, top, width, height], fill="#f5f3ee")
    add("board/title", "text", "board", [left + 30, top + 24, 380, 44], text=source["title"])
    add("board/flow", "frame", "board", list(source["panel"]), fill="#e7edf0", layout="horizontal",
        wrap=True, gap=12, padding=12, clip=False)
    for index, label in enumerate(source["cards"]):
        key = f"board/flow/{index}"
        card_width, card_height = source["card_size"]
        add(key, "frame", "board/flow", [0, 0, card_width, card_height],
            fill="#ffffff", order=index)
        add(key + "/label", "text", key, [0, 0, card_width - 12, card_height - 16], text=label)

    badge("board/service", source["banner"], "service/accent", [left + 30, top + height - 74, 166, 30])
    if source["style_field"] == "value":
        badge("board/service-mirror", source["banner"], "service/accent", [left + 216, top + height - 74, 130, 30])
    badge("board/notice", source["decoy"], "notice/accent", [left + 366, top + height - 74, 144, 30])
    add("board/footer", "text", "board", [left + 30, top + height - 34, 220, 20],
        text="Updated at 08:40")
    healthy = _resolve_views({"nodes": nodes, "styles": styles})

    layout_field = source["layout_field"]
    layout = {"collection": "nodes", "key": "board/flow", "field": layout_field,
              "from": True if layout_field == "wrap" else 12, "to": source["faulty_layout"]}
    style = ({"collection": "nodes", "key": "board/service", "field": source["style_field"],
              "from": "service/accent", "to": "notice/accent"}
             if source["style_field"] == "bindings.fill" else
             {"collection": "styles", "key": "service/accent", "field": source["style_field"],
              "from": source["correct_color"], "to": source["decoy_color"]})
    injections = [layout, style]
    return {
        "brief": (source["symptom"] + " Inspect the editable file, identify the two root causes, "
                  "and repair them with the smallest edits. Preserve unrelated content and record your diagnosis."),
        "symptom_screenshot_name": "symptom.png",
        "viewport": {"width": 880, "height": 520, "scale": 1},
        "assets": [],
        "start": apply_operations(healthy, injections),
        "expected": healthy,
        "injections": injections,
        "repair_actions": [{**item, "from": item["to"], "to": item["from"]} for item in injections],
        "logical_objects": len(nodes),
    }


def screenshot_metadata(data):
    """Identify the evaluator's independently retained screenshot PNG."""
    if not isinstance(data, bytes) or data[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    offset = 8
    width = height = 0
    has_pixels = False
    while offset + 12 <= len(data):
        length, kind = struct.unpack_from(">I4s", data, offset)
        end = offset + length + 12
        if end > len(data):
            return None
        checksum = struct.unpack_from(">I", data, end - 4)[0]
        if zlib.crc32(data[offset + 4:end - 4]) != checksum:
            return None
        if offset == 8:
            if kind != b"IHDR" or length != 13:
                return None
            width, height = struct.unpack_from(">II", data, offset + 8)
        if kind == b"IDAT" and length:
            has_pixels = True
        if kind == b"IEND":
            if length or end != len(data) or not has_pixels or not width or not height:
                return None
            return {"sha256": hashlib.sha256(data).hexdigest(), "width": width, "height": height}
        offset = end
    return None


def acceptance(contract, evidence, screenshot_data, failures):
    metadata = screenshot_metadata(screenshot_data)
    before = evidence.get("before")
    capture = evidence.get("symptom_capture")
    if (metadata is None or not isinstance(before, dict)
            or capture != {**metadata, "document_id": before.get("document_id"), "phase": "before"}):
        failures.append("symptom_capture: independent pre-repair screenshot is missing or differs")
    expected = contract["repair_actions"]
    diagnoses = [{field: row[field] for field in ("collection", "key", "field", "from")} for row in expected]
    for name, items in (("diagnoses", diagnoses), ("repair_actions", expected)):
        observed = evidence.get(name)
        if not isinstance(observed, list) or len(observed) != 2 or any(
            sum(type(actual) is dict and actual.keys() == required.keys() and all(
                type(actual[field]) is type(value) and actual[field] == value
                for field, value in required.items()
            ) for actual in observed) != 1 for required in items
        ):
            failures.append(f"{name}: requires exactly the two registered root causes or corrective operations")
