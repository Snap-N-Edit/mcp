import { z } from 'zod';
import type { SnapneditClient, DesignSpec } from '@snapnedit/sdk';
import { SnapneditApiError } from '@snapnedit/sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { BuiltTool } from './tools.js';

/**
 * DESIGN tools — the agent-facing way to CREATE a design (not just run an AI op
 * on an image): `create_design` compiles a declarative spec into an editor
 * document, and `render_design` renders that spec straight to a PNG. Both proxy
 * to the api's `/designs` + `/designs/render` through `@snapnedit/sdk`. The zod
 * shape below mirrors the api's `designSpecSchema` (the api validates again).
 */

const baseLayerShape = {
  x: z.number().describe('center x in document px'),
  y: z.number().describe('center y in document px'),
  rotation: z.number().optional().describe('degrees, clockwise'),
  opacity: z.number().min(0).max(1).optional(),
};

const textLayer = z.object({
  type: z.literal('text'),
  text: z.string(),
  fontSize: z.number().positive().optional(),
  fontFamily: z.string().optional(),
  color: z.string().optional().describe('CSS color, e.g. "#ffffff"'),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  align: z.enum(['left', 'center', 'right']).optional(),
  ...baseLayerShape,
});
const imageLayer = z.object({
  type: z.literal('image'),
  url: z.string().describe('image URL (fetched at render time)'),
  width: z.number().positive(),
  height: z.number().positive(),
  ...baseLayerShape,
});
const shapeLayer = z.object({
  type: z.literal('shape'),
  shape: z.enum(['rect', 'ellipse', 'line', 'triangle', 'star']),
  width: z.number().positive(),
  height: z.number().positive(),
  fill: z.string().nullable().optional(),
  stroke: z.string().nullable().optional(),
  strokeWidth: z.number().optional(),
  ...baseLayerShape,
});
const elementLayer = z.object({
  type: z.literal('element'),
  svg: z.string().describe('inline SVG (use currentColor for the recolorable fill)'),
  color: z.string().optional(),
  size: z.number().positive().optional(),
  ...baseLayerShape,
});

const designSpecShape = {
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  background: z.string().optional().describe('"transparent" or a solid CSS color like "#ffffff"'),
  layers: z.array(z.discriminatedUnion('type', [textLayer, imageLayer, shapeLayer, elementLayer])).default([]),
};

const designSpecSchema = z.object(designSpecShape);

function textResult(text: string, isError = false): CallToolResult {
  return isError ? { content: [{ type: 'text', text }], isError: true } : { content: [{ type: 'text', text }] };
}

function apiErrorResult(err: unknown, tool: string): CallToolResult {
  if (err instanceof SnapneditApiError) {
    return textResult(`snapnedit api error (${err.code}, status ${err.status}): ${err.message}`, true);
  }
  return textResult(`snapnedit-mcp: unexpected error running "${tool}": ${err instanceof Error ? err.message : String(err)}`, true);
}

/** Builds the two design tools (`create_design`, `render_design`) bound to `sdk`. */
export function buildDesignTools(sdk: SnapneditClient): readonly BuiltTool[] {
  return [
    {
      name: 'create_design',
      config: {
        title: 'create_design',
        description:
          'Create a multi-layer design (canvas + text/image/shape/element layers) from a declarative spec. Returns the compiled editor document as JSON. Use render_design to get an image.',
        inputSchema: designSpecShape,
      },
      handler: async (rawArgs: Record<string, unknown>): Promise<CallToolResult> => {
        const parsed = designSpecSchema.safeParse(rawArgs);
        if (!parsed.success) {
          return textResult(`invalid design spec: ${parsed.error.message}`, true);
        }
        try {
          const { document } = await sdk.createDesign(parsed.data as DesignSpec);
          return textResult(JSON.stringify(document));
        } catch (err) {
          return apiErrorResult(err, 'create_design');
        }
      },
    },
    {
      name: 'render_design',
      config: {
        title: 'render_design',
        description:
          'Render a design spec (same shape as create_design) straight to an image. Returns a PNG (or JPEG). Server-side, no browser.',
        inputSchema: { ...designSpecShape, format: z.enum(['png', 'jpeg']).optional() },
      },
      handler: async (rawArgs: Record<string, unknown>): Promise<CallToolResult> => {
        const { format: rawFormat, ...specArgs } = rawArgs;
        const parsed = designSpecSchema.safeParse(specArgs);
        if (!parsed.success) {
          return textResult(`invalid design spec: ${parsed.error.message}`, true);
        }
        const format = rawFormat === 'jpeg' ? 'jpeg' : 'png';
        try {
          const bytes = await sdk.renderDesign({ spec: parsed.data as DesignSpec, format });
          return { content: [{ type: 'image', data: Buffer.from(bytes).toString('base64'), mimeType: format === 'jpeg' ? 'image/jpeg' : 'image/png' }] };
        } catch (err) {
          return apiErrorResult(err, 'render_design');
        }
      },
    },
  ];
}
