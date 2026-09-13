# @snapnedit/mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server that gives an AI agent
the [snapnedit](https://snapnedit.com) photo-editing and design tools: remove a
background, upscale, erase an object, replace a sky, compose a multi-layer design and
render it to PNG/JPEG/PDF — all as MCP tools over stdio.

The server runs no models locally. Every tool call is proxied to the snapnedit API
through [`@snapnedit/sdk`](https://github.com/Snap-N-Edit/sdk) with your API key, so
running it costs nothing but the credits the operations consume.

## Running it

Two environment variables are required (both read in `src/index.ts`; the process exits
with a message if either is missing):

| Variable | Meaning |
| --- | --- |
| `SNAPNEDIT_API_KEY` | Your API key (`sk_live_...`), created in the snapnedit dashboard. Sent as `Authorization: Bearer <key>`. |
| `SNAPNEDIT_BASE_URL` | Origin of the API, e.g. `https://api.snapnedit.com` (or `http://localhost:8787` against a local stack). |

```sh
SNAPNEDIT_API_KEY=sk_live_... SNAPNEDIT_BASE_URL=https://api.snapnedit.com npx snapnedit-mcp
```

The server speaks MCP over stdio — stdout is the transport, so diagnostics go to stderr.
It is normally launched by an MCP client rather than by hand.

> Publishing to npm is imminent — until it lands, build from the monorepo
> (`npm ci && npm run build`) and run `node packages/mcp/dist/index.js`.

## Registering it

### Claude Code

```sh
claude mcp add snapnedit \
  --env SNAPNEDIT_API_KEY=sk_live_... \
  --env SNAPNEDIT_BASE_URL=https://api.snapnedit.com \
  -- npx -y snapnedit-mcp
```

### Claude Desktop

In `claude_desktop_config.json` (macOS:
`~/Library/Application Support/Claude/claude_desktop_config.json`; Windows:
`%APPDATA%\Claude\claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "snapnedit": {
      "command": "npx",
      "args": ["-y", "snapnedit-mcp"],
      "env": {
        "SNAPNEDIT_API_KEY": "sk_live_...",
        "SNAPNEDIT_BASE_URL": "https://api.snapnedit.com"
      }
    }
  }
}
```

Restart Claude Desktop after editing the file. Running from a local build instead of
npm looks the same with `"command": "node"` and
`"args": ["/absolute/path/to/packages/mcp/dist/index.js"]`.

## Tools

Every image tool takes `image` (base64-encoded bytes, no `data:` prefix) and an optional
`mime`; three of them also require a base64 `mask`. Each returns the edited image as an
MCP image content block. Errors from the API (bad input, insufficient credits, a failed
job) come back as an error result, not a crash.

| Tool | Extra input | What it does |
| --- | --- | --- |
| `remove_background` | — | Removes the background, producing a transparent-background PNG. |
| `upscale` | `factor`: `2` \| `4` | Increases resolution with AI upscaling while preserving detail. |
| `unblur` | — | Sharpens a blurry or out-of-focus photo and recovers detail. |
| `colorize` | — | Colorizes a black-and-white photo with realistic color. |
| `style_transfer` | `style`: `vivid` \| `pastel` \| `mosaic` \| `storm` | Restyles a photo with a painterly art filter. |
| `retouch` | — | Smooths skin, removes blemishes, enhances a portrait automatically. |
| `beautify` | `amount`: `0.3` \| `0.6` \| `0.9` \| `1` | Face-aware beauty retouch: edge-preserving skin smoothing plus subtle teeth-whiten and eye-brighten. |
| `magic_eraser` | **mask** | Erases the masked object, person or overlay with content-aware fill. |
| `generative_fill` | **mask**, `prompt` (required), `mode`: `fast` \| `quality` | Generates new content inside the masked region from a text prompt. |
| `remove_watermark` | **mask** | Erases a masked watermark, logo or text overlay by inpainting. |
| `ai_denoise` | `strength`: `0.25` \| `0.5` \| `0.75` \| `1` | Removes sensor grain and noise while preserving edges. |
| `replace_sky` | `sky`: `blue-sky` \| `sunset` \| `dramatic-clouds` \| `golden-hour` \| `night` \| `overcast` | Replaces the sky with a preset, blending the horizon. |
| `relight` | `direction`: `left` \| `right` \| `front` \| `top` \| `backlit` | Re-lights a portrait or scene from a chosen light direction. |
| `replace_background` | `background`: `white` \| `black` \| `studio-grey` \| `studio-blue` \| `sunset` \| `ocean` \| `lavender` | Cuts out the subject and composites it over a background preset. |
| `strip_metadata` | — | Strips C2PA Content Credentials, AI-generator XMP tags and EXIF without changing pixels. Does not remove visible or invisible pixel watermarks. |
| `auto_remove_watermark` | `strength`: `low` \| `medium` \| `high` | Detects a visible watermark automatically (no mask) and inpaints it away. |
| `resize_image` | `width`, `height` (1..8192; at least one), `fit`: `inside` \| `cover` \| `fill`, `format`: `png` \| `jpeg` \| `webp`, `quality`: 1..100 | Resizes to exact dimensions and re-encodes. Free (0 credits) — plain geometry, no model runs. |
| `create_design` | a design spec | Compiles a canvas + text/image/shape/element/frame layers into an editor document (returned as JSON). |
| `render_design` | a design spec, or `pages`; `format`: `png` \| `jpeg` \| `pdf` | Renders a design straight to an image server-side; `pages` renders a multi-page PDF. |

Which operations a given deployment actually serves is up to that deployment — some may
be disabled, in which case the tool call returns an API error.

## Example prompt

> Here's a product photo. Remove the background, upscale it 2×, then build me a
> 1080×1080 square post: the cutout centered on a dark background with the headline
> "New arrival" across the top, and render it as a PNG.

The agent chains `remove_background` → `upscale` → `render_design` and hands back the
finished image.

## Development

This package is developed inside the private snapnedit monorepo and mirrored to
[github.com/Snap-N-Edit/mcp](https://github.com/Snap-N-Edit/mcp) with its history. The
mirror is read-only for code (it references sibling workspace packages, so it does not
build on its own) — file issues and feature requests there, and pull requests are
welcome as proposals; the change lands through the monorepo and the mirror is refreshed
on every release.

Licensed under the [MIT License](./LICENSE).
