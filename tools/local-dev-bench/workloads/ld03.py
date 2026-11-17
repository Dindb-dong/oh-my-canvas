"""Prebound shared-value fixtures for LD03's core and propagation probe."""
import copy


VARIANTS = {
    "field-relay": {
        "title": "Field relay roster",
        "groups": [
            ("Survey", ["Baseline", "Traverse", "Summit", "Keyline", "Altitude", "Control", "Trace", "Datum"]),
            ("Dispatch", ["Ridge", "Quarry", "Shelter", "Runnel", "Cairn", "Valley", "Spur", "Crossing"]),
            ("Comms", ["Beacon", "Signal", "Channel", "Mast", "Uplink", "Carrier", "Repeat", "Relay"]),
            ("Supply", ["Fuel", "Water", "Tent", "Torch", "Ration", "Battery", "Cable", "Tarp"]),
            ("Review", ["Notes", "Chart", "Log", "Readout", "Handoff", "Docket", "Route", "Report"]),
        ],
        "before": ("#2864dc", 12),
        "after": ("#136b62", 20),
        "probe": ("#843f80", 24),
        "overrides": {2: ("fill", "#a05122"), 18: ("gap", 8), 27: ("gap", 16), 34: ("fill", "#782653")},
    },
    "edition-grid": {
        "title": "Edition coverage",
        "groups": [
            ("Desk", ["News", "Letters", "Weather", "Briefs", "Index", "Calendar", "Links", "Copy", "Inbox", "Tips"]),
            ("Features", ["Profile", "History", "Music", "Design", "Food", "Review", "Essay", "Art", "Travel", "Books"]),
            ("Production", ["Covers", "Galley", "Stock", "Plate", "Proof", "Color", "Spine", "Binding", "Ink", "Trim"]),
            ("Delivery", ["North", "South", "Rural", "City", "Metro", "Rail", "Boat", "Shop", "Mail", "Returns"]),
        ],
        "before": ("#884e20", 10),
        "after": ("#275b9d", 18),
        "probe": ("#186541", 22),
        "overrides": {0: ("gap", 6), 17: ("fill", "#713464"), 28: ("fill", "#bf4e20"), 39: ("gap", 14)},
    },
}


def fixture(variant):
    source = VARIANTS[variant]
    fill, gap = source["before"]
    nodes = [{"key": "board", "kind": "frame", "parent": None}]
    styles = [
        {"key": "target.accent", "kind": "color", "value": fill},
        {"key": "target.spacing", "kind": "length", "value": gap},
        {"key": "keep.accent", "kind": "color", "value": fill},
        {"key": "keep.spacing", "kind": "length", "value": gap},
    ]

    def add(key, kind, parent, **properties):
        nodes.append({"key": key, "kind": kind, "parent": parent, **properties})

    def card(key, parent, title, family, override=None):
        values = {"fill": fill, "gap": gap}
        bindings = {"fill": family + ".accent", "gap": family + ".spacing"}
        if override:
            prop, value = override
            values[prop] = value
            del bindings[prop]
        add(key, "frame", parent, layout="vertical", bindings=bindings, **values)
        add(key + "/label", "text", key, text=title)
        add(key + "/state", "text", key, text="Verified")

    add("board/title", "text", "board", text=source["title"])
    if variant == "edition-grid":
        add("board/editorial", "frame", "board")
        add("board/distribution", "frame", "board")

    offset = 0
    for index, (label, titles) in enumerate(source["groups"]):
        group = f"target/{index}"
        parent = "board"
        if variant == "edition-grid":
            parent = "board/editorial" if index < 2 else "board/distribution"
        add(group, "frame", parent)
        add(group + "/label", "text", group, text=label)
        for local_index, title in enumerate(titles):
            card(f"{group}/{local_index}", group, title, "target",
                 source["overrides"].get(offset + local_index))
        offset += len(titles)

    add("keep", "frame", "board")
    add("keep/title", "text", "keep", text="Archive · reference only")
    for index, label in enumerate(("Baseline", "Historic", "Frozen", "Archive")):
        card(f"keep/{index}", "keep", label, "keep")

    def updated(values):
        target = dict(zip(("target.accent", "target.spacing"), values))
        updated_styles = [{**style, "value": target.get(style["key"], style["value"])} for style in styles]
        updated_nodes = copy.deepcopy(nodes)
        for node in updated_nodes:
            for prop, style in node.get("bindings", {}).items():
                if style in target:
                    node[prop] = target[style]
        return {"nodes": updated_nodes, "styles": updated_styles}

    return {
        "brief": (f"Change the target accent to {source['after'][0]} and target spacing to "
                  f"{source['after'][1]} px using the existing shared references. Preserve all four "
                  "local property overrides, the visually similar archive family, and reference identities."),
        "viewport": {"width": 1440, "height": 960, "scale": 1},
        "assets": [],
        "start": {"nodes": nodes, "styles": styles},
        "expected": updated(source["after"]),
        "probe": updated(source["probe"]),
        "probe_actions": [
            {"op": "set_style", "key": key, "value": value}
            for key, value in zip(("target.accent", "target.spacing"), source["probe"])
        ],
        "logical_objects": len(nodes),
        "target_references": offset,
        "local_overrides": len(source["overrides"]),
    }
