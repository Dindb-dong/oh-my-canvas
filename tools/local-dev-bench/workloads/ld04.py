"""Responsive wrap fixtures with a private width registration."""
import hashlib
import json


VISIBLE_WIDTHS = (1440, 768, 390)
FONT_SIZE = {"heading": 26, "detail": 14}
VARIANTS = {
    "street-market": {
        "title": "Market row",
        "cards": [
            ("North gate", "Fruit · 08:30"), ("Paper stalls", "Goods · 09:15", "East aisle"),
            ("Tea stand", "Drinks · 09:30"), ("Cedar grove", "Plants · 10:00", "Unload from lane two"),
            ("Map table", "Prints · 10:30"), ("Clay house", "Crafts · 11:30", "Bring packing paper"),
            ("Dock bakery", "Food · 12:00"), ("Oak kitchen", "Food · 12:20", "Check power point"),
        ],
        "padding": 16, "gap": 16, "minimum": 230, "basis": 270, "maximum": 360,
        "demo_width": 1014, "tail": None,
    },
    "lab-queue": {
        "title": "Lab intake",
        "cards": [
            ("Microscope", "Bench A", "Recheck lens", "Hold until 17:00"), ("Sample freezer", "Bay 2"),
            ("Print room", "Label batch 9"), ("Centrifuge", "Bench B", "Needs balance check"),
            ("Reference scan", "Bay 4", "Upload signed log"), ("Rinse station", "Bench D"),
            ("Vial cabinet", "Bay 2", "Replace divider"), ("Bench meter", "Bench G"),
            ("Tissue archive", "Bay 1", "Move to cold storage"),
        ],
        "padding": 20, "gap": 12, "minimum": 200, "basis": 248, "maximum": 304,
        "demo_width": 614, "tail": "Intake closes at 17:00",
    },
}


def registration(variant, supplied=None):
    source = VARIANTS[variant]
    qualified = supplied is not None
    if supplied is None:
        supplied = {"width": source["demo_width"], "nonce": "fixture demonstration only"}
    if not isinstance(supplied, dict) or supplied.keys() != {"width", "nonce"}:
        raise ValueError("LD04 registration requires width and nonce")
    width, nonce = supplied["width"], supplied["nonce"]
    if type(width) is not int or not 390 < width < 1440 or width in VISIBLE_WIDTHS:
        raise ValueError("LD04 withheld width must be an intermediate integer outside the public widths")
    if not isinstance(nonce, str) or len(nonce.strip()) < 16:
        raise ValueError("LD04 registration requires a private nonce of at least 16 characters")
    digest = hashlib.sha256(json.dumps(
        ["omc-ld04-width/1", variant, nonce, width], separators=(",", ":"), ensure_ascii=False
    ).encode("utf-8")).hexdigest()
    return width, digest, qualified


def _snapshot(source, width, *, responsive):
    pad, gap = source["padding"], source["gap"]
    inner = width - 2 * pad
    nodes = []

    def add(key, kind, parent, bounds, **properties):
        nodes.append({"key": key, "kind": kind, "parent": parent, "bounds": bounds, **properties})

    def text(key, parent, bounds, value, role):
        add(key, "text", parent, bounds, text=value, font_family="Inter",
            font_size=FONT_SIZE[role], fully_visible=True)

    add("canvas", "frame", None, [0, 0, width, 0])
    if source["tail"]:
        add("heading", "frame", "canvas", [pad, pad, inner, 48])
        text("title", "heading", [pad + 12, pad + 10, inner - 24, 30], source["title"], "heading")
        start_y = pad + 48 + 24
    else:
        text("title", "canvas", [pad, pad, inner, 30], source["title"], "heading")
        start_y = pad + 30 + 20

    add("collection", "frame", "canvas", [pad, start_y, inner, 0],
        layout="horizontal-wrap" if responsive else "fixed",
        height_rule="content" if responsive else "fixed",
        gap=gap, align="start", overflow_x="none")
    collection = nodes[-1]
    columns = max(1, (inner + gap) // (source["basis"] + gap))
    cards = source["cards"]
    y = start_y
    for start in range(0, len(cards), columns):
        row = cards[start:start + columns]
        slot = min(source["maximum"], (inner - (len(row) - 1) * gap) / len(row))
        tallest = 0
        for index, lines in enumerate(row, start):
            x = pad + (index - start) * (slot + gap)
            height = 24 + len(lines) * 20 + (len(lines) - 1) * 4
            tallest = max(tallest, height)
            key = f"card/{index}"
            constraints = {
                "min_width": source["minimum"], "max_width": source["maximum"],
                "basis_width": source["basis"],
            } if responsive else {}
            add(key, "frame", "collection", [x, y, slot, height], **constraints,
                height_rule="content" if responsive else "fixed")
            for line, value in enumerate(lines):
                text(f"{key}/line-{line}", key, [x + 12, y + 12 + line * 24, slot - 24, 20],
                     value, "detail")
        y += tallest + gap
    bottom = y - gap
    collection["bounds"][3] = bottom - start_y
    if source["tail"]:
        text("footer", "canvas", [pad, bottom + 16, inner, 20], source["tail"], "detail")
        bottom += 36
    nodes[0]["bounds"][3] = bottom + pad
    return {"nodes": nodes, "styles": []}


def fixture(variant, private_registration=None):
    source = VARIANTS[variant]
    width, commitment, qualified = registration(variant, private_registration)
    widths = [*VISIBLE_WIDTHS[1:], width, VISIBLE_WIDTHS[0]]
    start = _snapshot(source, 1440, responsive=False)
    expected = _snapshot(source, 1440, responsive=True)
    return {
        "brief": ("Adapt the existing desktop collection in place so changing the canvas width alone "
                  "wraps the same editable cards in reading order at 1440, 768 and 390 pixels. "
                  "Keep spacing, clamp card widths, derive height from content, and prevent clipping "
                  "or horizontal overflow. A privately precommitted intermediate width is also tested."),
        "viewport": {"width": 1440, "height": 960, "scale": 1},
        "font": {"family": "Inter", "release_hash": None, "qualification": "pin the same installed font"},
        "assets": [],
        "start": start,
        "expected": expected,
        "probe": expected,
        "public_widths": list(VISIBLE_WIDTHS),
        "withheld_width_commitment": commitment,
        "private_width_registered": qualified,
        "responsive_steps": [{"width": w, **_snapshot(source, w, responsive=True)} for w in widths],
        "probe_actions": [
            {"op": "set_node", "key": "canvas", "property": "width", "value": w}
            for w in widths
        ],
        "logical_objects": len(start["nodes"]),
    }
