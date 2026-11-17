"""Dashboard fixtures with independently authored data and layout structures."""
import copy
import hashlib
import struct
import zlib


VARIANTS = {
    "harbor-ops": {
        "title": "Harbor operations",
        "subtitle": "Monday dispatch · North Harbor",
        "nav": ["Overview", "Dispatch", "Vessels", "Incidents", "Crews", "Reports"],
        "metrics": [
            ("Vessels on shift", "24", "+3 since yesterday"),
            ("Berths open", "07", "Two reserved"),
            ("Loads cleared", "128", "90% of daily target"),
            ("Delays", "04", "One needs review"),
        ],
        "filters": ["Today", "All berths", "All carriers", "Any status"],
        "table": "Dispatch queue",
        "columns": ["Vessel", "Berth", "Cargo", "ETA", "Lead", "Status"],
        "rows": [
            ["Sea Lark", "B-01", "Steel", "07:15", "Morgan", "Cleared"],
            ["Juniper", "B-03", "Timber", "08:10", "Rivera", "On time"],
            ["Saltwind", "B-05", "Grain", "08:40", "Patel", "Waiting"],
            ["North Star", "B-02", "Crates", "09:25", "Chen", "Cleared"],
            ["Tern", "B-09", "Sugar", "10:05", "Diaz", "On time"],
            ["Blue Finch", "B-04", "Tiles", "10:45", "Khan", "Delayed"],
            ["Mainsail", "B-06", "Coffee", "11:30", "Liu", "At berth"],
            ["Pelican", "B-11", "Pulp", "12:10", "Ali", "On time"],
        ],
        "detail": ["Sea Lark", "Assigned berth B-01", "Ops lead Morgan", "Steel · 40 crates",
                   "Gate check complete", "Weather window closes at 14:00"],
        "palette": [(20, 52, 94), (72, 167, 163), (224, 238, 241)],
    },
    "reading-room": {
        "title": "Reading room service",
        "subtitle": "Study week · East library",
        "nav": ["Today", "Rooms", "Reservations", "Returns", "Help desk"],
        "metrics": [
            ("Seats reserved", "186", "35 remaining"),
            ("Open requests", "12", "5 due this hour"),
            ("Rooms available", "6", "East building"),
            ("Returns sorted", "74", "Three trolleys"),
        ],
        "filters": ["This week", "East library", "All queues"],
        "table": "Service requests",
        "columns": ["Request", "Area", "Due", "Queue", "State"],
        "rows": [
            ["Map cabinet key", "Archives", "09:00", "Reading", "Ready"],
            ["Large-print kit", "Room E1", "09:15", "Access", "Assigned"],
            ["Locker reset", "North hall", "09:35", "Access", "Queued"],
            ["Atlas return", "Maps", "10:20", "Returns", "Ready"],
            ["Desk lamp", "Room E3", "10:45", "Facilities", "Assigned"],
            ["Microfilm reel", "Archives", "11:30", "Reading", "Queued"],
            ["Laptop charger", "Room E2", "12:00", "Loan", "Ready"],
            ["Group booking", "Room E7", "13:15", "Bookings", "Assigned"],
            ["Study carrel", "West hall", "14:00", "Bookings", "Queued"],
        ],
        "detail": ["Map cabinet key", "Archives · cabinet 4", "Reading queue", "Due at 09:00",
                   "Bring ID to the desk", "Key returns before noon"],
        "palette": [(66, 36, 78), (180, 95, 118), (242, 227, 225)],
    },
}


def _chunk(tag, data):
    body = tag + data
    return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))


def make_assets(source):
    assets = []
    for name, width, height in (("badge", 32, 32), ("detail-map", 96, 48)):
        rows = []
        for y in range(height):
            row = []
            for x in range(width):
                block = (x // 8 + y // 8 + x // 24 * (y // 16)) % 3
                row.extend((*source["palette"][block], 255))
            rows.append(bytes(row))
        png = (b"\x89PNG\r\n\x1a\n"
               + _chunk(b"IHDR", struct.pack(">2I5B", width, height, 8, 6, 0, 0, 0))
               + _chunk(b"sRGB", b"\0")
               + _chunk(b"IDAT", zlib.compress(b"".join(b"\0" + row for row in rows), 0))
               + _chunk(b"IEND", b""))
        assets.append(({
            "name": name + ".png",
            "width": width,
            "height": height,
            "color_space": "sRGB",
            "media_type": "image/png",
            "license": "CC0-1.0",
            "sha256": hashlib.sha256(png).hexdigest(),
            "rgba_sha256": hashlib.sha256(b"".join(rows)).hexdigest(),
        }, png))
    return assets


def fixture(variant):
    source = VARIANTS[variant]
    assets = [meta for meta, _ in make_assets(source)]
    nodes = []

    def add(key, kind, parent, bounds, **properties):
        nodes.append({"key": key, "kind": kind, "parent": parent, "bounds": bounds, **properties})

    def label(key, parent, bounds, value, size=16):
        add(key, "text", parent, bounds, text=value, font_family="Inter", font_size=size)

    def image(key, parent, bounds, index):
        add(key, "image", parent, bounds, asset_rgba_sha256=assets[index]["rgba_sha256"])

    width, height = 1440, 960
    harbor = variant == "harbor-ops"
    add("dashboard", "frame", None, [0, 0, width, height])
    if harbor:
        area_x, area_width = 248, 1168
        header_y, metrics_y, filters_y, content_y = 24, 128, 264, 328
        table_x, table_width, detail_x, detail_width = 248, 760, 1032, 384
        add("nav", "frame", "dashboard", [0, 0, 224, height])
        image("nav/brand", "nav", [24, 24, 32, 32], 0)
        label("nav/site", "nav", [68, 29, 136, 22], "Port desk")
        for index, name in enumerate(source["nav"]):
            label(f"nav/{index}", "nav", [24, 104 + index * 52, 176, 24], name)
    else:
        area_x, area_width = 24, 1392
        header_y, metrics_y, filters_y, content_y = 88, 168, 288, 352
        table_x, table_width, detail_x, detail_width = 408, 1008, 24, 360
        add("nav", "frame", "dashboard", [0, 0, width, 64])
        image("nav/brand", "nav", [24, 16, 32, 32], 0)
        label("nav/site", "nav", [68, 21, 180, 22], "Library desk")
        for index, name in enumerate(source["nav"]):
            label(f"nav/{index}", "nav", [260 + index * 148, 21, 132, 22], name)

    add("header", "frame", "dashboard", [area_x, header_y, area_width, 68])
    label("header/title", "header", [area_x, header_y + 4, 640, 36], source["title"], 32)
    label("header/subtitle", "header", [area_x, header_y + 43, 640, 22], source["subtitle"])

    add("metrics", "frame", "dashboard", [area_x, metrics_y, area_width, 100])
    card_width = (area_width - 48) // 4
    for index, content in enumerate(source["metrics"]):
        x = area_x + index * (card_width + 16)
        key = f"metrics/{index}"
        add(key, "frame", "metrics", [x, metrics_y, card_width, 100])
        for column, (offset, size) in enumerate(((12, 16), (34, 26), (69, 14))):
            label(f"{key}/{column}", key, [x + 12, metrics_y + offset, card_width - 24, size + 4],
                  content[column], size)

    add("filters", "frame", "dashboard", [area_x, filters_y, area_width, 42],
        layout="horizontal", gap=12)
    for index, value in enumerate(source["filters"]):
        label(f"filters/{index}", "filters", [area_x + index * 168, filters_y + 10, 156, 22], value)

    table_height = 96 + len(source["rows"]) * 44
    add("table", "frame", "dashboard", [table_x, content_y, table_width, table_height])
    label("table/title", "table", [table_x + 16, content_y + 12, table_width - 32, 28],
          source["table"], 22)
    column_width = (table_width - 32) // len(source["columns"])
    for row_index, cells in enumerate([source["columns"], *source["rows"]]):
        y = content_y + 50 + row_index * 44
        row = f"table/row-{row_index}"
        add(row, "frame", "table", [table_x + 16, y, table_width - 32, 40])
        for col, value in enumerate(cells):
            label(f"{row}/{col}", row, [table_x + 20 + col * column_width, y + 9, column_width - 8, 22],
                  value, 14)

    add("detail", "frame", "dashboard", [detail_x, content_y, detail_width, 430])
    label("detail/title", "detail", [detail_x + 16, content_y + 12, detail_width - 32, 28],
          source["detail"][0], 22)
    image("detail/map", "detail", [detail_x + 16, content_y + 54, 288, 144], 1)
    for index, value in enumerate(source["detail"][1:]):
        label(f"detail/{index}", "detail", [detail_x + 16, content_y + 220 + index * 31,
              detail_width - 32, 22], value)

    actions = [
        {"op": "set_node", "key": "header/title", "property": "text", "value": "Shift review"},
        {"op": "set_node", "key": "detail/title", "property": "text", "value": "Verified selection"},
        {"op": "set_node", "key": "filters", "property": "gap", "value": 20},
    ]
    probe = copy.deepcopy(nodes)
    for node in probe:
        for action in actions:
            if node["key"] == action["key"]:
                node[action["property"]] = action["value"]
        if node["parent"] == "filters":
            node["bounds"][0] += 8 * int(node["key"].split("/")[-1])

    return {
        "brief": "Create and save the editable dashboard defined by the canvas, assets, text and placement contract.",
        "viewport": {"width": width, "height": height, "scale": 1},
        "font": {"family": "Inter", "release_hash": None, "qualification": "pin the same installed font before scored use"},
        "assets": assets,
        "start": {"nodes": [], "styles": []},
        "expected": {"nodes": nodes, "styles": []},
        "probe": {"nodes": probe, "styles": []},
        "probe_actions": actions,
        "logical_objects": len(nodes),
    }
