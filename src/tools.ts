/**
 * MCP tool descriptors + registration for `@snapnedit/mcp` — the mapping
 * from `@snapnedit/shared`'s `OPERATION_IDS` to MCP tools, and the pure
 * handler-building logic behind them.
 *
 * Deliberately decoupled from `apps/api/src/catalog.ts`'s
 * `operationCatalog` (per Task 4's brief: "prefer a small self-contained
 * descriptor so MCP stays decoupled") — this package talks to the
 * snapnedit api purely over `@snapnedit/sdk`, the same way any third-party
 * MCP client would, and has no business importing api-internal metadata.
 *
 * What each tool is CALLED and what it says about itself stays hand-written
 * here (that copy is genuinely MCP's own product surface). What each tool
 * ACCEPTS no longer is: `params` is derived from `@snapnedit/shared`'s
 * `OPERATION_PARAMS` — the same zod schemas the engine parses with and
 * `POST /jobs` validates against — and `requiresMask` from
 * `OPERATION_REQUIRES_MASK`. A hand-copied enum here could (and did
 * elsewhere) advertise a default the server doesn't honor; now an agent's
 * tool schema and the server's validator cannot disagree. Only the
 * per-param `.describe()` prose is layered on top, by key.
 *
 * That makes `@snapnedit/shared` a RUNTIME dependency of this package rather
 * than the type-only one it used to be — a deliberate trade: the alternative
 * is keeping sixteen enum copies in sync by hand.
 *
 * `TOOL_DESCRIPTOR_MAP` below is typed `Record<OperationId, _>`, so adding a
 * new id to `@snapnedit/shared`'s `OPERATION_IDS` without adding an entry
 * here is a compile error — the same exhaustiveness trick
 * `apps/api/src/catalog.ts`'s `operationCatalog` uses (including redundantly
 * repeating the key as an `operation` field inside each entry, then deriving
 * the public array via `Object.values`, exactly as that file's
 * `allowedUploadMimes` does).
 */
import { OPERATION_PARAMS, OPERATION_REQUIRES_MASK, type OperationId } from '@snapnedit/shared';
import { SnapneditApiError, type RunOptions, type SnapneditClient } from '@snapnedit/sdk';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { buildDesignTools } from './designTools.js';
import { buildStorageTools } from './storageTools.js';
import { buildUsageTools } from './usageTools.js';

/**
 * One entry per `OperationId`, describing the MCP tool that exposes it.
 * `params` is a zod raw shape (the SAME shape `McpServer#registerTool`'s
 * `inputSchema` takes — see `docs/server.md`'s `registerTool` examples
 * confirmed via context7) for whatever params the operation needs BEYOND
 * the input image (and mask, for `requiresMask` operations) — e.g.
 * `upscale`'s `factor`, `generative-fill`'s `prompt`.
 */
export interface ToolDescriptor {
  readonly operation: OperationId;
  readonly name: string;
  readonly description: string;
  readonly params: Readonly<Record<string, z.ZodTypeAny>>;
  readonly requiresMask: boolean;
}

/**
 * The MCP raw shape for `operation`'s params: every key of its
 * `OPERATION_PARAMS` schema, verbatim (enums, defaults and coercions
 * included), with this package's own agent-facing prose attached per key via
 * `.describe()`. A key with no prose is passed through unchanged.
 *
 * Cross-field rules (e.g. `resize-image`'s "at least one of width/height")
 * live on the zod OBJECT, not on any single key, so they cannot ride along
 * in a raw shape — the descriptions below spell them out instead, and the
 * api enforces them for real.
 */
function paramsShapeFor(
  operation: OperationId,
  descriptions: Readonly<Record<string, string>> = {},
): Readonly<Record<string, z.ZodTypeAny>> {
  const shape = OPERATION_PARAMS[operation].shape as Readonly<Record<string, z.ZodTypeAny>>;
  return Object.fromEntries(
    Object.entries(shape).map(([key, schema]) => {
      const description = descriptions[key];
      return [key, description === undefined ? schema : schema.describe(description)];
    }),
  );
}

/** `Record<OperationId, _>` — see the module doc comment above for why this shape (not a plain array literal) is the exhaustiveness guard. */
const TOOL_DESCRIPTOR_MAP: Record<OperationId, ToolDescriptor> = {
  'remove-background': {
    operation: 'remove-background',
    name: 'remove_background',
    description: 'Automatically remove the background from a photo, producing a transparent-background PNG.',
    params: paramsShapeFor('remove-background'),
    requiresMask: OPERATION_REQUIRES_MASK['remove-background'],
  },
  upscale: {
    operation: 'upscale',
    name: 'upscale',
    description: 'Increase an image’s resolution using AI upscaling while preserving detail and texture.',
    params: paramsShapeFor('upscale', { factor: 'Upscale factor. Defaults to "2".' }),
    requiresMask: OPERATION_REQUIRES_MASK['upscale'],
  },
  unblur: {
    operation: 'unblur',
    name: 'unblur',
    description: 'Sharpen a blurry or out-of-focus photo and recover lost detail.',
    params: paramsShapeFor('unblur'),
    requiresMask: OPERATION_REQUIRES_MASK['unblur'],
  },
  colorize: {
    operation: 'colorize',
    name: 'colorize',
    description: 'Colorize a black-and-white photo with realistic, AI-generated color.',
    params: paramsShapeFor('colorize'),
    requiresMask: OPERATION_REQUIRES_MASK['colorize'],
  },
  'style-transfer': {
    operation: 'style-transfer',
    name: 'style_transfer',
    description: 'Restyle a photo with a painterly art filter (vivid, pastel, mosaic, or storm).',
    params: paramsShapeFor('style-transfer', { style: 'Target art filter. Defaults to "vivid".' }),
    requiresMask: OPERATION_REQUIRES_MASK['style-transfer'],
  },
  retouch: {
    operation: 'retouch',
    name: 'retouch',
    description: 'Smooth skin, remove blemishes, and enhance a portrait automatically.',
    params: paramsShapeFor('retouch'),
    requiresMask: OPERATION_REQUIRES_MASK['retouch'],
  },
  beautify: {
    operation: 'beautify',
    name: 'beautify',
    description:
      'Cosmetic portrait beauty retouch: detect the face and apply edge-preserving skin smoothing (eyes, hair, and edges stay sharp) plus subtle teeth-whiten and eye-brighten.',
    params: paramsShapeFor('beautify', { amount: 'How strong the retouch is (0..1). Defaults to "0.6" (a natural look).' }),
    requiresMask: OPERATION_REQUIRES_MASK['beautify'],
  },
  'magic-eraser': {
    operation: 'magic-eraser',
    name: 'magic_eraser',
    description: 'Erase the masked region of a photo (an unwanted object, person, or watermark) with content-aware AI fill.',
    params: paramsShapeFor('magic-eraser'),
    requiresMask: OPERATION_REQUIRES_MASK['magic-eraser'],
  },
  'generative-fill': {
    operation: 'generative-fill',
    name: 'generative_fill',
    description: 'Generate new content inside the masked region of a photo, guided by a text prompt.',
    params: paramsShapeFor('generative-fill', {
      prompt: 'Text prompt describing what to generate inside the masked region.',
      mode: 'Speed/quality: "quality" (default, ~25s, faithful to the prompt) or "fast" (~7s, weaker adherence).',
    }),
    requiresMask: OPERATION_REQUIRES_MASK['generative-fill'],
  },
  'remove-watermark': {
    operation: 'remove-watermark',
    name: 'remove_watermark',
    description: 'Erase the masked watermark, logo, or text overlay from a photo with content-aware AI inpainting.',
    params: paramsShapeFor('remove-watermark'),
    requiresMask: OPERATION_REQUIRES_MASK['remove-watermark'],
  },
  'ai-denoise': {
    operation: 'ai-denoise',
    name: 'ai_denoise',
    description:
      'Remove sensor grain and noise from a photo with a learned denoiser that preserves edges and fine detail.',
    params: paramsShapeFor('ai-denoise', { strength: 'How strongly to blend the denoised result over the original. Defaults to "1" (full).' }),
    requiresMask: OPERATION_REQUIRES_MASK['ai-denoise'],
  },
  'replace-sky': {
    operation: 'replace-sky',
    name: 'replace_sky',
    description:
      'Replace the sky in a photo with a chosen preset sky (blue sky, sunset, dramatic clouds, golden hour, night, or overcast), blending the horizon softly.',
    params: paramsShapeFor('replace-sky', { sky: 'Which sky preset to composite in. Defaults to "blue-sky".' }),
    requiresMask: OPERATION_REQUIRES_MASK['replace-sky'],
  },
  relight: {
    operation: 'relight',
    name: 'relight',
    description:
      'Re-light a portrait or scene from a chosen light direction (left, right, front, top, or backlit), baking a relit image.',
    params: paramsShapeFor('relight', { direction: 'Where the key light comes from. Defaults to "front".' }),
    requiresMask: OPERATION_REQUIRES_MASK['relight'],
  },
  'replace-background': {
    operation: 'replace-background',
    name: 'replace_background',
    description:
      'Cut out the subject and composite it over a chosen background preset (white, black, studio grey, or a studio-blue/sunset/ocean/lavender gradient), baking a finished image with a feathered edge.',
    params: paramsShapeFor('replace-background', { background: 'Which background preset to composite the subject over. Defaults to "white".' }),
    requiresMask: OPERATION_REQUIRES_MASK['replace-background'],
  },
  'strip-metadata': {
    operation: 'strip-metadata',
    name: 'strip_metadata',
    description:
      'Strip provenance/metadata tags — C2PA Content Credentials, AI-generator XMP tags, and EXIF — from a PNG or JPEG so it is not flagged as AI-generated, without changing the visible pixels. Does NOT remove visible watermarks or robust invisible pixel watermarks (e.g. SynthID).',
    params: paramsShapeFor('strip-metadata'),
    requiresMask: OPERATION_REQUIRES_MASK['strip-metadata'],
  },
  'auto-remove-watermark': {
    operation: 'auto-remove-watermark',
    name: 'auto_remove_watermark',
    description:
      'Automatically detect a visible watermark, logo, or text overlay stamped on a photo — no mask or brushing needed — and erase it by content-aware inpainting. The automatic sibling of remove_watermark (which needs a hand-painted mask). Works best on semi-transparent or text watermarks; may miss very complex or opaque logos — fall back to magic_eraser / remove_watermark and brush the region for those.',
    params: paramsShapeFor('auto-remove-watermark', { strength: 'How aggressively to dilate (pad) the detected watermark region before inpainting. Defaults to "medium".' }),
    requiresMask: OPERATION_REQUIRES_MASK['auto-remove-watermark'],
  },
  'resize-image': {
    operation: 'resize-image',
    name: 'resize_image',
    description:
      'Resize an image to an exact width and/or height and re-encode it as PNG, JPEG or WebP. Plain deterministic geometry — no model runs, so it is FREE (0 credits) and returns immediately. Give at least one of width/height; "cover" and "fill" need both.',
    params: paramsShapeFor('resize-image', {
      width: 'Target width in pixels (1..8192). Optional if height is given.',
      height: 'Target height in pixels (1..8192). Optional if width is given.',
      fit: 'How to reconcile the target box with the source aspect ratio: "inside" (default, keep aspect and fit within), "cover" (keep aspect and crop to fill) or "fill" (stretch). "cover" and "fill" require BOTH width and height.',
      format: 'Output encoding. Defaults to "png".',
      quality: 'Encoder quality 1..100, for "jpeg"/"webp" only. Defaults to 90.',
    }),
    requiresMask: OPERATION_REQUIRES_MASK['resize-image'],
  },
};

/**
 * `TOOL_DESCRIPTOR_MAP` flattened to an array — the public list
 * `buildTools`/`registerTools` default to, and what `test/tools.test.ts`
 * asserts exhaustive coverage over. Order matches the map's declaration
 * order (`Object.values` over a string-keyed object literal, same as
 * `apps/api/src/catalog.ts`'s `allowedUploadMimes`).
 */
export const TOOL_DESCRIPTORS: readonly ToolDescriptor[] = Object.values(TOOL_DESCRIPTOR_MAP);

/**
 * BRING YOUR OWN STORAGE, shared across every image tool: instead of pushing
 * base64 through the agent's context, the caller can name a url the SERVER
 * fetches the input from and a presigned PUT the SERVER delivers the result
 * to. Both are billed to (and require) the API key this server already runs
 * with, so an agent never handles a credential of its own.
 */
const BYOS_INPUT_SHAPE: Readonly<Record<string, z.ZodTypeAny>> = {
  input_url: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Alternative to `image`: an https URL (e.g. a short-lived presigned GET) the snapnedit SERVER fetches the input image from — the bytes never pass through this agent. Give exactly one of `image` or `input_url`. Requires the server to be configured with an API key (it is).',
    ),
  destination_put_url: z
    .string()
    .min(1)
    .optional()
    .describe(
      'An https presigned PUT URL the snapnedit SERVER uploads the finished image to (your own S3/GCS/Azure bucket). When given, the result is delivered there and this tool returns a JSON delivery report instead of the image bytes — nothing flows through this agent. Requires the server to be configured with an API key (it is).',
    ),
  destination_headers: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      'Headers the presigned PUT signature requires, e.g. { "content-type": "image/png" }. Only content-type, cache-control, content-disposition and x-amz-* / x-goog-* / x-ms-* are accepted (16 max). Only valid together with `destination_put_url`.',
    ),
  destination_id: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Id of a SAVED storage destination on the snapnedit account (call `list_storage_destinations` to see them). The server signs the upload itself, so no URL is needed — use this INSTEAD of `destination_put_url`, never both. If the account has a default destination, results go there even with neither argument.',
    ),
};

/** Every tool's full MCP `inputSchema` shape: the input image (+ mask, if required), the bring-your-own-storage url args, plus the descriptor's own params. */
function toolInputShape(descriptor: ToolDescriptor): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {
    // Optional in the SCHEMA (an `input_url` can stand in for it) but not in
    // practice: the handler rejects a call that supplies neither, and one
    // that supplies both. A raw zod shape cannot express "exactly one of",
    // so the prose says it and the handler enforces it.
    image: z
      .string()
      .min(1)
      .optional()
      .describe('Base64-encoded input image bytes (no "data:" URL prefix). Give exactly one of `image` or `input_url`.'),
    mime: z
      .string()
      .optional()
      .describe('MIME type of `image`, e.g. "image/png". Defaults to a generic binary type if omitted. Ignored with `input_url` (the server sniffs the fetched bytes).'),
    ...BYOS_INPUT_SHAPE,
  };
  if (descriptor.requiresMask) {
    shape.mask = z
      .string()
      .min(1)
      .describe('Base64-encoded mask image bytes (no "data:" URL prefix) — required for this operation. Masks are always inline; there is no URL form.');
  }
  return { ...shape, ...descriptor.params };
}

function textResult(text: string, isError = false): CallToolResult {
  return isError ? { content: [{ type: 'text', text }], isError: true } : { content: [{ type: 'text', text }] };
}

function decodeBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'));
}

function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/**
 * Narrows a validated-but-loosely-typed `destination_headers` arg to
 * `Record<string, string>`. Zod already proved it is a string->string record
 * (see `BYOS_INPUT_SHAPE`); this re-derives that fact for the type system
 * without an `as` cast, the same no-blind-casts convention the rest of this
 * handler follows. Returns `undefined` for an absent or empty record.
 */
function asHeaderRecord(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/**
 * Builds the (`sdk`, `descriptor`)-bound MCP tool handler: validates the
 * raw MCP tool-call args against this tool's own input shape (so the
 * handler is safe to invoke directly — e.g. from a test — without going
 * through `McpServer`'s own argument parsing first), decodes the base64
 * image (+ mask, if present), calls `sdk.run`, and returns the output as a
 * base64-encoded MCP `image` content block.
 *
 * A {@link SnapneditApiError} from `sdk.run` (a failed job, a non-2xx api
 * response, insufficient credits, etc.) is caught and turned into an
 * `isError: true` tool result — never a thrown rejection — so a caller
 * driving this handler directly (as the tests do) sees the same shape an
 * MCP client would over the wire.
 */
export function createToolHandler(
  sdk: SnapneditClient,
  descriptor: ToolDescriptor,
): (args: Record<string, unknown>) => Promise<CallToolResult> {
  const argsSchema = z.object(toolInputShape(descriptor));

  return async function handleToolCall(rawArgs: Record<string, unknown>): Promise<CallToolResult> {
    const parsed = argsSchema.safeParse(rawArgs);
    if (!parsed.success) {
      return textResult(`invalid input for tool "${descriptor.name}": ${parsed.error.message}`, true);
    }
    // `parsed.data`'s static type is only as precise as `z.object()` can
    // infer from a dynamically-built `Record<string, ZodTypeAny>` shape
    // (see `toolInputShape` — the exact set of keys isn't known until
    // runtime, since it varies per operation) — narrower than what the
    // schema actually validated. Rather than cast that imprecision away,
    // `image`/`mime`/`mask` are narrowed by hand with `typeof`, the same
    // no-blind-casts convention `packages/sdk/src/client.ts`'s
    // `asString`/`asRecord` helpers use for the same reason.
    const {
      image: rawImage,
      mime: rawMime,
      mask: rawMask,
      input_url: rawInputUrl,
      destination_put_url: rawDestinationUrl,
      destination_headers: rawDestinationHeaders,
      destination_id: rawDestinationId,
      ...params
    } = parsed.data;
    const image = typeof rawImage === 'string' ? rawImage : undefined;
    const inputUrl = typeof rawInputUrl === 'string' ? rawInputUrl : undefined;
    // "Exactly one of" is a cross-field rule a raw zod shape cannot carry
    // (see `toolInputShape`), so it is enforced here — before any credit is
    // spent, and with a message that tells the agent which way to fix it.
    if (image !== undefined && inputUrl !== undefined) {
      return textResult(`invalid input for tool "${descriptor.name}": give either "image" or "input_url", not both`, true);
    }
    if (image === undefined && inputUrl === undefined) {
      return textResult(`invalid input for tool "${descriptor.name}": one of "image" (base64) or "input_url" is required`, true);
    }
    const mime = typeof rawMime === 'string' ? rawMime : undefined;
    const mask = typeof rawMask === 'string' ? rawMask : undefined;
    const destinationUrl = typeof rawDestinationUrl === 'string' ? rawDestinationUrl : undefined;
    const destinationId = typeof rawDestinationId === 'string' ? rawDestinationId : undefined;
    const destinationHeaders = asHeaderRecord(rawDestinationHeaders);
    if (destinationUrl === undefined && destinationHeaders !== undefined) {
      return textResult(
        `invalid input for tool "${descriptor.name}": "destination_headers" only applies together with "destination_put_url"`,
        true,
      );
    }
    // The two destination forms are alternatives, not a merge: one is a url
    // the CALLER signed, the other a bucket the SERVER signs for. Supplying
    // both is a mistake worth naming rather than silently resolving.
    if (destinationUrl !== undefined && destinationId !== undefined) {
      return textResult(
        `invalid input for tool "${descriptor.name}": give either "destination_put_url" or "destination_id", not both`,
        true,
      );
    }

    try {
      const input = inputUrl !== undefined ? { url: inputUrl } : decodeBase64(image ?? '');
      const opts: RunOptions = { params };
      if (mime !== undefined) {
        opts.mime = mime;
      }
      if (mask !== undefined) {
        opts.mask = decodeBase64(mask);
      }
      if (destinationUrl !== undefined) {
        // The SDK takes the wire shape verbatim; the api validates the url
        // (https, public host) and the header allowlist for real.
        opts.destination = {
          type: 'presigned-put',
          url: destinationUrl,
          ...(destinationHeaders !== undefined ? { headers: destinationHeaders } : {}),
        };
      } else if (destinationId !== undefined) {
        // A SAVED destination: only the id travels. The api checks it belongs
        // to this key's account (a foreign id is a 404) and the worker signs
        // the upload with the credentials it holds — none of which the agent
        // ever sees.
        opts.destination = { type: 'saved', id: destinationId };
      }
      const result = await sdk.run(descriptor.operation, input, opts);
      // Delivered to the caller's own bucket: there are no bytes to hand
      // back (and pulling them through the agent's context would defeat the
      // point), so the tool reports the delivery outcome instead.
      if (!result.downloaded) {
        return textResult(
          JSON.stringify({
            jobId: result.jobId,
            delivered: result.delivery?.status === 'delivered',
            delivery: result.delivery,
            // A saved destination reports WHERE it landed; a presigned PUT
            // does not (the caller signed the url, so they already know).
            ...(result.delivery?.bucket !== undefined ? { bucket: result.delivery.bucket } : {}),
            ...(result.delivery?.key !== undefined ? { key: result.delivery.key } : {}),
            // `null` when the destination has `deleteAfterDelivery` set: our
            // copy is gone, the caller's bucket has the only one.
            download: result.download?.url ?? null,
          }),
        );
      }
      const image64 = encodeBase64(result.output);
      const content: CallToolResult['content'] = [{ type: 'image', data: image64, mimeType: result.mime }];
      // A destination whose delivery FAILED still returns the image (the job
      // succeeded), plus the failure so the agent can say why the bucket copy
      // is missing.
      if (result.delivery) {
        content.push({ type: 'text', text: JSON.stringify({ jobId: result.jobId, delivery: result.delivery }) });
      }
      return { content };
    } catch (err) {
      if (err instanceof SnapneditApiError) {
        return textResult(`snapnedit api error (${err.code}, status ${err.status}): ${err.message}`, true);
      }
      const message = err instanceof Error ? err.message : String(err);
      return textResult(`snapnedit-mcp: unexpected error running "${descriptor.name}": ${message}`, true);
    }
  };
}

/** One built tool: its MCP registration args (`name`, `config`) plus the bound `handler` — everything `registerTools` needs to hand to `server.registerTool`, and everything a test needs to drive the handler directly with no `McpServer` in the loop. */
export interface BuiltTool {
  readonly name: string;
  readonly config: { readonly title: string; readonly description: string; readonly inputSchema: Record<string, z.ZodTypeAny> };
  readonly handler: (args: Record<string, unknown>) => Promise<CallToolResult>;
}

/** Maps every descriptor in `descriptors` (default {@link TOOL_DESCRIPTORS}, i.e. every `OperationId`) to a {@link BuiltTool} bound to `sdk`. Pure — no `McpServer` involved — so this is what `test/tools.test.ts` exercises directly. */
export function buildTools(sdk: SnapneditClient, descriptors: readonly ToolDescriptor[] = TOOL_DESCRIPTORS): readonly BuiltTool[] {
  return descriptors.map((descriptor) => ({
    name: descriptor.name,
    config: {
      title: descriptor.name,
      description: descriptor.description,
      inputSchema: toolInputShape(descriptor),
    },
    handler: createToolHandler(sdk, descriptor),
  }));
}

/** Registers every {@link buildTools} result on a real `McpServer` via `server.registerTool`. The one function that actually needs a live MCP server — `server.ts`'s `createMcpServer` is its only caller; `test/tools.test.ts` exercises `buildTools`'s handlers directly instead, with no `McpServer` in the loop. */
export function registerTools(
  server: McpServer,
  sdk: SnapneditClient,
  descriptors: readonly ToolDescriptor[] = TOOL_DESCRIPTORS,
): void {
  // The per-operation AI tools, PLUS the design tools (create_design /
  // render_design) — the latter let an agent compose a design, not just edit
  // an image (see `designTools.ts`) — PLUS the read-only saved-storage tools
  // (see `storageTools.ts`), which let an agent name a bucket for a result
  // without ever seeing its credentials, PLUS the read-only usage tool (see
  // `usageTools.ts`), so an agent can answer what its own work cost.
  for (const tool of [...buildTools(sdk, descriptors), ...buildDesignTools(sdk), ...buildStorageTools(sdk), ...buildUsageTools(sdk)]) {
    server.registerTool(tool.name, tool.config, tool.handler);
  }
}
