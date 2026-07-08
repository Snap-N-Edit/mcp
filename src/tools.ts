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
 * `OperationId` is imported as a TYPE only — mirroring `@snapnedit/sdk`'s
 * own type-only coupling to `@snapnedit/shared` (see `packages/sdk/src/
 * client.ts`'s module doc comment): this package's only runtime dependency
 * on the api's operation set is `@snapnedit/sdk` itself, never `@snapnedit/
 * shared`'s runtime barrel. `TOOL_DESCRIPTOR_MAP` below is typed
 * `Record<OperationId, _>`, so adding a new id to `@snapnedit/shared`'s
 * `OPERATION_IDS` without adding an entry here is a compile error — the
 * same exhaustiveness trick `apps/api/src/catalog.ts`'s `operationCatalog`
 * uses (including redundantly repeating the key as an `operation` field
 * inside each entry, then deriving the public array via `Object.values`,
 * exactly as that file's `allowedUploadMimes` does).
 */
import type { OperationId } from '@snapnedit/shared';
import { SnapneditApiError, type RunOptions, type SnapneditClient } from '@snapnedit/sdk';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

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

const EMPTY_PARAMS: Readonly<Record<string, z.ZodTypeAny>> = {};

/** `Record<OperationId, _>` — see the module doc comment above for why this shape (not a plain array literal) is the exhaustiveness guard. */
const TOOL_DESCRIPTOR_MAP: Record<OperationId, ToolDescriptor> = {
  'remove-background': {
    operation: 'remove-background',
    name: 'remove_background',
    description: 'Automatically remove the background from a photo, producing a transparent-background PNG.',
    params: EMPTY_PARAMS,
    requiresMask: false,
  },
  upscale: {
    operation: 'upscale',
    name: 'upscale',
    description: 'Increase an image’s resolution using AI upscaling while preserving detail and texture.',
    params: { factor: z.enum(['2', '4']).optional().describe('Upscale factor. Defaults to "2".') },
    requiresMask: false,
  },
  unblur: {
    operation: 'unblur',
    name: 'unblur',
    description: 'Sharpen a blurry or out-of-focus photo and recover lost detail.',
    params: EMPTY_PARAMS,
    requiresMask: false,
  },
  colorize: {
    operation: 'colorize',
    name: 'colorize',
    description: 'Colorize a black-and-white photo with realistic, AI-generated color.',
    params: EMPTY_PARAMS,
    requiresMask: false,
  },
  'style-transfer': {
    operation: 'style-transfer',
    name: 'style_transfer',
    description: 'Restyle a photo into an art style (anime, watercolor, oil painting, or sketch).',
    params: {
      style: z.enum(['anime', 'watercolor', 'oil-painting', 'sketch']).optional().describe('Target art style. Defaults to "anime".'),
    },
    requiresMask: false,
  },
  retouch: {
    operation: 'retouch',
    name: 'retouch',
    description: 'Smooth skin, remove blemishes, and enhance a portrait automatically.',
    params: EMPTY_PARAMS,
    requiresMask: false,
  },
  'magic-eraser': {
    operation: 'magic-eraser',
    name: 'magic_eraser',
    description: 'Erase the masked region of a photo (an unwanted object, person, or watermark) with content-aware AI fill.',
    params: EMPTY_PARAMS,
    requiresMask: true,
  },
  'generative-fill': {
    operation: 'generative-fill',
    name: 'generative_fill',
    description: 'Generate new content inside the masked region of a photo, guided by a text prompt.',
    params: { prompt: z.string().min(1).describe('Text prompt describing what to generate inside the masked region.') },
    requiresMask: true,
  },
  'remove-watermark': {
    operation: 'remove-watermark',
    name: 'remove_watermark',
    description: 'Automatically detect and remove watermarks, logos, and text overlays from a photo — no mask required.',
    params: EMPTY_PARAMS,
    requiresMask: false,
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

/** Every tool's full MCP `inputSchema` shape: the input image (+ mask, if required) plus the descriptor's own params. */
function toolInputShape(descriptor: ToolDescriptor): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {
    image: z.string().min(1).describe('Base64-encoded input image bytes (no "data:" URL prefix).'),
    mime: z
      .string()
      .optional()
      .describe('MIME type of `image`, e.g. "image/png". Defaults to a generic binary type if omitted.'),
  };
  if (descriptor.requiresMask) {
    shape.mask = z
      .string()
      .min(1)
      .describe('Base64-encoded mask image bytes (no "data:" URL prefix) — required for this operation.');
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
    const { image: rawImage, mime: rawMime, mask: rawMask, ...params } = parsed.data;
    if (typeof rawImage !== 'string') {
      return textResult(`invalid input for tool "${descriptor.name}": "image" must be a base64 string`, true);
    }
    const mime = typeof rawMime === 'string' ? rawMime : undefined;
    const mask = typeof rawMask === 'string' ? rawMask : undefined;

    try {
      const inputBytes = decodeBase64(rawImage);
      const opts: RunOptions = { params };
      if (mime !== undefined) {
        opts.mime = mime;
      }
      if (mask !== undefined) {
        opts.mask = decodeBase64(mask);
      }
      const result = await sdk.run(descriptor.operation, inputBytes, opts);
      return {
        content: [{ type: 'image', data: encodeBase64(result.output), mimeType: result.mime }],
      };
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
  for (const tool of buildTools(sdk, descriptors)) {
    server.registerTool(tool.name, tool.config, tool.handler);
  }
}
