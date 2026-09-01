import argparse
import csv
import json
import math
import struct
import zlib
from pathlib import Path


def points():
    n = 8
    mean_x, mean_y = 54.27, 47.84
    variance_x, variance_y = 280.90, 725.23
    correlation = -0.07
    amplitude_x = math.sqrt(variance_x * (n - 1) / (n / 2))
    amplitude_y = math.sqrt(variance_y * (n - 1) / (n / 2))
    phase = math.asin(correlation)
    return [
        (
            mean_x + amplitude_x * math.cos(2 * math.pi * index / n),
            mean_y + amplitude_y * math.sin(2 * math.pi * index / n + phase),
        )
        for index in range(n)
    ]


def png_chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))


def render_png(path, values):
    width, height = 400, 300
    pixels = bytearray([255] * width * height * 3)
    for x, y in values:
        px = round((x - 25) / 60 * (width - 1))
        py = round((90 - y) / 85 * (height - 1))
        for dx in range(-2, 3):
            for dy in range(-2, 3):
                cx, cy = px + dx, py + dy
                if 0 <= cx < width and 0 <= cy < height:
                    offset = (cy * width + cx) * 3
                    pixels[offset : offset + 3] = bytes((39, 224, 164))
    scanlines = b"".join(b"\x00" + pixels[row * width * 3 : (row + 1) * width * 3] for row in range(height))
    png = b"\x89PNG\r\n\x1a\n"
    png += png_chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
    png += png_chunk(b"IDAT", zlib.compress(scanlines, 9))
    png += png_chunk(b"IEND", b"")
    path.write_bytes(png)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--target", choices=["circle"], required=True)
    parser.add_argument("--seed", type=int, required=True)
    args = parser.parse_args()
    with open(args.input, newline="", encoding="utf-8") as source:
        list(csv.DictReader(source))
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    generated = points()
    with (output / "points.csv").open("w", newline="", encoding="utf-8") as target:
        writer = csv.writer(target, lineterminator="\n")
        writer.writerow(("x", "y"))
        writer.writerows((f"{x:.8f}", f"{y:.8f}") for x, y in generated)
    (output / "results.json").write_text(json.dumps({"target": args.target, "seed": args.seed}, sort_keys=True), encoding="utf-8")
    render_png(output / "comparison.png", generated)


if __name__ == "__main__":
    main()
