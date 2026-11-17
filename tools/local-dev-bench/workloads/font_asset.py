"""Validate an explicitly supplied OpenType fixture's metadata and character map."""
import hashlib
import struct


FONT_LIMIT = 32 * 1024 * 1024


def _u16(data, offset):
    return struct.unpack_from(">H", data, offset)[0]


def _u32(data, offset):
    return struct.unpack_from(">I", data, offset)[0]


def _tables(data):
    if data[:4] not in {b"\0\1\0\0", b"OTTO"}:
        raise ValueError("font fixture must be one SFNT OpenType face")
    tables = {}
    for offset in range(12, 12 + 16 * _u16(data, 4), 16):
        tag, _, position, length = struct.unpack_from(">4sIII", data, offset)
        if position + length > len(data) or tag in tables:
            raise ValueError("invalid OpenType table directory")
        tables[tag] = data[position:position + length]
    return tables


def _glyph_format4(data, codepoint):
    segments = _u16(data, 6) // 2
    for index in range(segments):
        high = _u16(data, 14 + index * 2)
        low = _u16(data, 16 + (segments + index) * 2)
        if low <= codepoint <= high:
            delta = _u16(data, 16 + (2 * segments + index) * 2)
            address = 16 + (3 * segments + index) * 2
            distance = _u16(data, address)
            if not distance:
                return (codepoint + delta) & 0xffff
            glyph = _u16(data, address + distance + (codepoint - low) * 2)
            return (glyph + delta) & 0xffff if glyph else 0
    return 0


def _glyph_format12(data, codepoint):
    count = _u32(data, 12)
    for index in range(count):
        low, high, first = struct.unpack_from(">III", data, 16 + index * 12)
        if low <= codepoint <= high:
            return first + codepoint - low
    return 0


def _unicode_maps(data):
    options = []
    for index in range(_u16(data, 2)):
        platform, encoding, offset = struct.unpack_from(">HHI", data, 4 + index * 8)
        if platform != 0 and (platform, encoding) not in {(3, 1), (3, 10)}:
            continue
        kind = _u16(data, offset)
        if kind == 4:
            length = _u16(data, offset + 2)
        elif kind == 12:
            length = _u32(data, offset + 4)
        else:
            continue
        if length <= 0 or offset + length > len(data):
            raise ValueError("invalid OpenType cmap length")
        options.append((kind, data[offset:offset + length]))
    return options


def _family(data):
    count, start = struct.unpack_from(">HH", data, 2)
    names = []
    for index in range(count):
        platform, _, language, name, length, offset = struct.unpack_from(">HHHHHH", data, 6 + index * 12)
        if platform not in (0, 3) or name not in (1, 16):
            continue
        string = data[start + offset:start + offset + length]
        if len(string) != length:
            raise ValueError("invalid OpenType name length")
        result = string.decode("utf-16-be").strip()
        if result:
            names.append(((name == 16, language == 0x409), result))
    if not names:
        raise ValueError("font does not declare a Unicode family name")
    return max(names)[1]


def read_font(path, license_id, glyphs):
    if path.suffix.lower() not in {".otf", ".ttf"} or not isinstance(license_id, str) or not license_id.strip():
        raise ValueError("supply an authorized .otf or .ttf font and its redistribution license identifier")
    with path.open("rb") as handle:
        data = handle.read(FONT_LIMIT + 1)
    if len(data) > FONT_LIMIT:
        raise ValueError("font fixture exceeds 32 MiB")
    try:
        tables = _tables(data)
        family = _family(tables[b"name"])
        maps = _unicode_maps(tables[b"cmap"])
        if not maps:
            raise ValueError("font has no supported Unicode cmap")
        # A platform with both formats normally prefers the full Unicode map.
        kind, cmap = max(maps, key=lambda entry: entry[0])
        mapper = _glyph_format12 if kind == 12 else _glyph_format4
        glyph_count = _u16(tables[b"maxp"], 4)
        missing = [char for char in glyphs if not 0 < mapper(cmap, ord(char)) < glyph_count]
    except (KeyError, struct.error, UnicodeDecodeError) as error:
        raise ValueError("malformed OpenType font fixture") from error
    if missing:
        raise ValueError("font fixture is missing required glyphs: " + "".join(missing))
    return ({
        "name": "fixture-font" + path.suffix.lower(),
        "family": family,
        "sha256": hashlib.sha256(data).hexdigest(),
        "license": license_id,
        "registered_glyphs": glyphs,
    }, data)
