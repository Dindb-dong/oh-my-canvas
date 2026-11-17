"""Conservation catalog for a scoped edit with semantic distractors."""
import copy


VARIANTS = ("conservation-atlas",)

PAGES = (
    ("inbound", "Inbound intake", ("Textiles", "Natural history", "Glass", "Watercolors")),
    ("intake", "Inspection intake", ("Framed work", "Books", "Ceramics", "Sheet metal")),
    ("receipts", "Receipt reconciliation", ("Loan returns", "Archive files", "Deposits", "Outdoor work")),
    ("estate", "Estate collection", ("Furniture", "Fabric rolls", "Ephemera", "Photographs")),
    ("holding", "Temporary holding", ("Stone", "Equipment", "Lacquer", "Plaster")),
    ("outgoing", "Outgoing loans", ("Paper", "Ceramics", "Mixed media", "Metal")),
    ("carts", "Cart staging", ("West cart", "East cart", "Transfer", "Hardware")),
    ("studies", "Study material", ("Pigment", "Wood", "Light tests", "Woven studies")),
    ("arrival", "Conservation arrivals", ("Mounts", "Loan arrivals", "Media", "Wet room")),
    ("reserve", "Reserve collection", ("Ceramics", "Cartons", "Large pieces", "Field study")),
)
STATIONS = (
    ("Table", "Station", "Rack", "Cart"),
    ("Bench", "Desk", "Shelf", "Cabinet"),
    ("Desk", "Pallet", "Bay", "Cart"),
    ("Shelf", "Rack", "Drawer", "Cabinet"),
)
TARGET = ("arrival", 1, 2)
TARGET_NAME = "Ceramics review"
TARGET_RECEIPT = "AC-270"
OLD_STATUS = "Condition check pending"
NEW_STATUS = "Ready for registrar review"
OLD_GAP = 8
NEW_GAP = 14
OLD_RADIUS = 4
NEW_RADIUS = 10


def _station_identity(slug, section, slot, label):
    if (slug, section, slot) in (TARGET, ("outgoing", 1, 2), ("reserve", 0, 1)):
        return TARGET_NAME, TARGET_RECEIPT if (slug, section, slot) == TARGET else "AC-207"
    if (slug, section, slot) == ("arrival", 1, 1):
        return "Ceramics review intake", TARGET_RECEIPT
    if (slug, section, slot) == ("arrival", 0, 2):
        return "Ceramics review reserve", "AC-271"
    return f"{label} {STATIONS[section][slot]}", f"{slug[:2].upper()}-{100 + 10 * section + slot}"


def fixture(variant):
    if variant not in VARIANTS:
        raise KeyError(variant)
    nodes = []
    pages = []
    target_key = None

    def add(key, kind, page, parent, bounds, **fields):
        row = {"key": key, "kind": kind, "page": page, "parent": parent, "bounds": bounds, **fields}
        nodes.append(row)
        return row

    for slug, title, groups in PAGES:
        pages.append({"key": slug, "name": title})
        for section, label in enumerate(groups):
            section_key = f"{slug}/zone-{section}"
            x = 26 + section % 2 * 600
            y = 28 + section // 2 * 394
            add(section_key, "frame", slug, None, [x, y, 574, 368], name=label, fill="#f0efe9")
            for slot in range(4):
                key = f"{section_key}/station-{slot}"
                name, receipt = _station_identity(slug, section, slot, label)
                if (slug, section, slot) == TARGET:
                    target_key = key
                left = x + 16 + slot % 2 * 276
                top = y + 16 + slot // 2 * 170
                add(key, "frame", slug, section_key, [left, top, 254, 166], name=name,
                    layout="vertical", padding=8, gap=OLD_GAP, fill="#ffffff")
                items = (
                    ("title", "text", 238, 20, {"text": name}),
                    ("receipt", "text", 238, 18, {"text": receipt}),
                    ("status", "text", 238, 22, {"text": OLD_STATUS}),
                    ("marker", "rectangle", 114, 18, {"radius": OLD_RADIUS, "fill": "#286a62"}),
                    ("retention", "text", 238, 16, {"text": f"Catalog shelf {slot + 1}"}),
                )
                item_y = top + 8
                for order, (role, kind, width, height, fields) in enumerate(items):
                    add(f"{key}/{role}", kind, slug, key, [left + 8, item_y, width, height],
                        order=order, name=role, **fields)
                    item_y += height + OLD_GAP

    start = {"pages": pages, "nodes": nodes, "styles": []}
    expected = copy.deepcopy(start)
    by_key = {node["key"]: node for node in expected["nodes"]}
    by_key[target_key]["gap"] = NEW_GAP
    by_key[target_key + "/status"]["text"] = NEW_STATUS
    by_key[target_key + "/marker"]["radius"] = NEW_RADIUS
    for child in expected["nodes"]:
        if child["parent"] == target_key:
            child["bounds"][1] += child["order"] * (NEW_GAP - OLD_GAP)

    return {
        "brief": (
            f"In the section called {TARGET_NAME} whose receipt reads {TARGET_RECEIPT}, "
            f"change the status to “{NEW_STATUS}”, set the section gap to {NEW_GAP} px, "
            f"and set the condition marker radius to {NEW_RADIUS} px. Preserve all unrelated content."
        ),
        "viewport": {"width": 1242, "height": 824, "scale": 1},
        "assets": [],
        "start": start,
        "expected": expected,
        "working_page": TARGET[0],
        "logical_objects": len(nodes),
        "edit": [
            {"key": target_key + "/status", "field": "text", "from": OLD_STATUS, "to": NEW_STATUS},
            {"key": target_key, "field": "gap", "from": OLD_GAP, "to": NEW_GAP},
            {"key": target_key + "/marker", "field": "radius", "from": OLD_RADIUS, "to": NEW_RADIUS},
        ],
    }


def acceptance(contract, evidence, phases, failures):
    for label in ("before", "copy_before"):
        snapshot = evidence.get(label)
        if not isinstance(snapshot, dict) or snapshot.get("selected_native_ids") != []:
            failures.append(f"{label}: starting selection was not independently observed clear")

    actual_edit = evidence.get("edit")
    if (not isinstance(actual_edit, list) or len(actual_edit) != len(contract["edit"])
            or not all(item in actual_edit for item in contract["edit"])):
        failures.append("edit: expected exactly the three registered field writes")

    history = evidence.get("copy_history")
    if (not isinstance(history, dict) or type(history.get("undo_count")) is not int
            or history["undo_count"] < 1 or type(history.get("redo_count")) is not int
            or history["redo_count"] != history["undo_count"]):
        failures.append("copy_history: actual native Undo and Redo counts are required")

    copy_identity = phases["copy_before"]
    if copy_identity:
        if phases["before"] and copy_identity[0] == phases["before"][0]:
            failures.append("copy_before: Undo/Redo verification requires a distinct document")
        for phase in ("copy_edited", "copy_undo", "copy_redo"):
            if phases[phase] and copy_identity != phases[phase]:
                failures.append(f"{phase}: copy page or native object identities changed")
