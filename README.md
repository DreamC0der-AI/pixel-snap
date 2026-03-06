# pixel-snap

A Claude Code plugin that converts upscaled pixel art images back to clean, sharp pixel art.

## What it does

- Auto-detects grid size via autocorrelation of edge signals
- Extracts true pixel colors using mode-based selection
- Supports **icon mode** (remove background, crop, center) and **scene mode** (preserve full image)
- Outputs crisp, nearest-neighbor scaled results

## Install

```shell
/plugin marketplace add DreamC0der-AI/pixel-snap
/plugin install pixel-snap@dreamcoder-tools
```

## Usage

```shell
/pixel-snap ~/images/sprite.png
/pixel-snap input.png output.png --size=512
/pixel-snap sprite.png --mode=icon --grid=16
```

## Options

| Option | Default | Description |
|---|---|---|
| `--mode=auto\|icon\|scene` | `auto` | Processing mode |
| `--size=N` | `1024` | Target output size in pixels |
| `--grid=N` | auto-detect | Force grid size in pixels |
| `--threshold=N` | `240` | White background threshold (0-255) |

## Modes

- **icon** — Removes white background, crops to content, centers on a square canvas, scales up
- **scene** — Keeps the full image, scales with nearest-neighbor interpolation
- **auto** — Detects whether the image is an icon or scene based on white pixel ratio

## Requirements

- Node.js
- `sharp` npm package (auto-installed on first use)

## License

MIT
