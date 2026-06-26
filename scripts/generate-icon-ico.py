#!/usr/bin/env python3
"""Build a Windows-compatible BMP-based icon.ico for Tauri.

Tauri embeds icons/icon.ico into the .exe at compile time (tauri-winres).
Requirements (https://v2.tauri.app/develop/icons/):
  - ICO must use BMP/DIB entries (not PNG-in-ICO; windres rejects those)
  - Layers for 16, 24, 32, 48, 64, and 256 px; 32 px should be first
"""
from __future__ import annotations

import struct
import sys
import zlib
from pathlib import Path

# Tauri docs: 32px first, then the rest.
ICO_SIZES = (32, 16, 24, 48, 64, 256)


def read_png_rgba(path: Path) -> tuple[int, int, bytes]:
    data = path.read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"{path}: not a PNG")

    pos = 8
    width = height = 0
    color_type = bit_depth = 0
    idat = bytearray()

    while pos < len(data):
        length = struct.unpack(">I", data[pos : pos + 4])[0]
        chunk_type = data[pos + 4 : pos + 8]
        chunk = data[pos + 8 : pos + 8 + length]
        if chunk_type == b"IHDR":
            width, height, bit_depth, color_type = struct.unpack(">IIBB", chunk[:10])
        elif chunk_type == b"IDAT":
            idat.extend(chunk)
        elif chunk_type == b"IEND":
            break
        pos += 12 + length

    if color_type != 6 or bit_depth != 8:
        raise ValueError(f"{path}: expected 8-bit RGBA PNG")

    raw = zlib.decompress(bytes(idat))
    stride = width * 4
    out = bytearray(width * height * 4)
    prev = bytearray(stride)
    i = 0

    for y in range(height):
        filt = raw[i]
        i += 1
        scan = bytearray(raw[i : i + stride])
        i += stride

        if filt == 1:
            for x in range(4, stride):
                scan[x] = (scan[x] + scan[x - 4]) & 0xFF
        elif filt == 2:
            for x in range(stride):
                scan[x] = (scan[x] + prev[x]) & 0xFF
        elif filt == 3:
            for x in range(stride):
                left = scan[x - 4] if x >= 4 else 0
                up = prev[x]
                scan[x] = (scan[x] + ((left + up) // 2)) & 0xFF
        elif filt == 4:
            for x in range(stride):
                left = scan[x - 4] if x >= 4 else 0
                up = prev[x]
                up_left = prev[x - 4] if x >= 4 else 0
                scan[x] = (scan[x] + paeth(left, up, up_left)) & 0xFF

        row_off = y * stride
        out[row_off : row_off + stride] = scan
        prev = scan

    return width, height, bytes(out)


def paeth(a: int, b: int, c: int) -> int:
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    if pb <= pc:
        return b
    return c


def sample_bilinear(w: int, h: int, rgba: bytes, fx: float, fy: float) -> tuple[int, int, int, int]:
    fx = max(0.0, min(w - 1.001, fx))
    fy = max(0.0, min(h - 1.001, fy))
    x0, y0 = int(fx), int(fy)
    x1, y1 = min(x0 + 1, w - 1), min(y0 + 1, h - 1)
    tx, ty = fx - x0, fy - y0

    def pix(x: int, y: int) -> tuple[float, float, float, float]:
        i = (y * w + x) * 4
        return rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]

    c00, c10 = pix(x0, y0), pix(x1, y0)
    c01, c11 = pix(x0, y1), pix(x1, y1)
    out = []
    for ch in range(4):
        top = c00[ch] * (1 - tx) + c10[ch] * tx
        bot = c01[ch] * (1 - tx) + c11[ch] * tx
        out.append(int(top * (1 - ty) + bot * ty + 0.5))
    return out[0], out[1], out[2], out[3]


def resize_rgba(sw: int, sh: int, rgba: bytes, dw: int, dh: int) -> bytes:
    if sw == dw and sh == dh:
        return rgba
    out = bytearray(dw * dh * 4)
    for y in range(dh):
        fy = (y + 0.5) * sh / dh - 0.5
        for x in range(dw):
            fx = (x + 0.5) * sw / dw - 0.5
            r, g, b, a = sample_bilinear(sw, sh, rgba, fx, fy)
            i = (y * dw + x) * 4
            out[i : i + 4] = bytes((r, g, b, a))
    return bytes(out)


def rgba_to_ico_bmp(width: int, height: int, rgba: bytes) -> bytes:
    header = struct.pack(
        "<IIIHHIIIIII",
        40,
        width,
        height * 2,
        1,
        32,
        0,
        width * height * 4 + ((width + 31) // 32) * 4 * height,
        0,
        0,
        0,
        0,
    )

    xor = bytearray()
    for y in range(height - 1, -1, -1):
        row = rgba[y * width * 4 : (y + 1) * width * 4]
        for x in range(0, len(row), 4):
            r, g, b, a = row[x], row[x + 1], row[x + 2], row[x + 3]
            xor.extend((b, g, r, a))

    and_row_bytes = ((width + 31) // 32) * 4
    and_mask = bytearray(and_row_bytes * height)
    for y in range(height):
        row_off = y * width * 4
        for x in range(width):
            if rgba[row_off + x * 4 + 3] < 128:
                byte_i = y * and_row_bytes + (x // 8)
                and_mask[byte_i] |= 1 << (7 - (x % 8))

    return header + bytes(xor) + bytes(and_mask)


def build_ico(sizes: tuple[int, ...], rgba_by_size: dict[int, bytes], out_path: Path) -> None:
    images: list[tuple[int, int, bytes]] = []
    for size in sizes:
        rgba = rgba_by_size[size]
        images.append((size, size, rgba_to_ico_bmp(size, size, rgba)))

    count = len(images)
    header = struct.pack("<HHH", 0, 1, count)
    offset = 6 + 16 * count

    directory = bytearray()
    blobs = bytearray()
    for w, h, bmp in images:
        bw = 0 if w >= 256 else w
        bh = 0 if h >= 256 else h
        size = len(bmp)
        directory.extend(struct.pack("<BBBBHHII", bw, bh, 0, 0, 1, 32, size, offset))
        blobs.extend(bmp)
        offset += size

    out_path.write_bytes(header + bytes(directory) + bytes(blobs))


def main() -> int:
    icons_dir = Path(__file__).resolve().parents[1] / "src-tauri" / "icons"
    source = icons_dir / "source.png"
    if not source.exists():
        source = icons_dir / "128x128@2x.png"
    if not source.exists():
        print("missing source.png or 128x128@2x.png", file=sys.stderr)
        return 1

    sw, sh, src_rgba = read_png_rgba(source)
    rgba_by_size = {size: resize_rgba(sw, sh, src_rgba, size, size) for size in ICO_SIZES}

    out = icons_dir / "icon.ico"
    build_ico(ICO_SIZES, rgba_by_size, out)
    print(
        f"Wrote {out} ({out.stat().st_size} bytes) "
        f"with BMP layers (px, 32 first): {list(ICO_SIZES)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
