---
name: pixel-snap
description: Convert upscaled pixel art images back to clean, sharp pixel art. Detects grid size, extracts true pixel colors, and outputs crisp results. Supports icon mode (remove background, crop, center) and scene mode (preserve full image).
disable-model-invocation: true
argument-hint: [input-file] [options]
---

# Pixel Art Snap

Convert upscaled/blurry pixel art images back to clean, sharp pixel art.

## Script Location

The script is at: `${CLAUDE_PLUGIN_ROOT}/pixel-art-snap.js`

It requires the `sharp` npm package. If not installed, run:
```
cd ${CLAUDE_PLUGIN_ROOT} && npm install sharp
```

## Usage

Run the script with:
```
node ${CLAUDE_PLUGIN_ROOT}/pixel-art-snap.js [input] [output] [options]
```

### Arguments from user

The user's arguments: $ARGUMENTS

### Options

- `--mode=auto|icon|scene` — Post-processing mode (default: auto-detect)
  - `icon`: remove white background, crop, center on square, scale
  - `scene`: keep full image, scale with nearest-neighbor
- `--size=1024` — Target output size in pixels (default: 1024)
- `--grid=N` — Force grid size in pixels (skip auto-detection)
- `--threshold=240` — White background threshold (default: 240)

### Workflow

1. Parse the user's arguments to determine input file and options
2. If no input file is specified, ask the user for one
3. Run the script with the appropriate arguments
4. Report the results (grid size detected, mode used, output path)
5. If the user wants to preview the result, read the output image file

### Examples

```bash
# Basic usage
node ${CLAUDE_PLUGIN_ROOT}/pixel-art-snap.js ~/images/sprite.png

# Specify output and size
node ${CLAUDE_PLUGIN_ROOT}/pixel-art-snap.js input.png output.png --size=512

# Force icon mode with custom grid
node ${CLAUDE_PLUGIN_ROOT}/pixel-art-snap.js sprite.png --mode=icon --grid=16
```
