import { z } from 'zod';
import type { SnapneditClient, DesignSpec } from '@snapnedit/sdk';
import { SnapneditApiError } from '@snapnedit/sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { BuiltTool } from './tools.js';

/**
 * DESIGN tools — the agent-facing way to CREATE a design (not just run an AI op
 * on an image): `create_design` compiles a declarative spec into an editor
 * document, and `render_design` renders that spec straight to a PNG/JPEG (or a
 * PDF for multi-page). Both proxy to the api's `/designs` + `/designs/render`
 * through `@snapnedit/sdk`.
 *
 * The zod shape below is a FULL-PARITY mirror of the api's `designSpecSchema`
 * (kept local so this package stays decoupled from `editor-core`, the same
 * self-contained-descriptor principle `tools.ts` follows; the api re-validates).
 * Every editor layer type + style is expressible here.
 */

const blendModeSchema = z.enum(['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten']);

const effectsSchema = z.object({
  shadow: z.object({ color: z.string(), blur: z.number(), offsetX: z.number(), offsetY: z.number(), opacity: z.number().min(0).max(1).optional() }).nullable().optional(),
  blur: z.number().nonnegative().optional(),
  glow: z.object({ color: z.string(), blur: z.number() }).nullable().optional(),
});

const baseLayerShape = {
  x: z.number().describe('center x in document px'),
  y: z.number().describe('center y in document px'),
  rotation: z.number().optional().describe('degrees, clockwise'),
  scaleX: z.number().optional().describe('horizontal scale (negative flips)'),
  scaleY: z.number().optional().describe('vertical scale (negative flips)'),
  opacity: z.number().min(0).max(1).optional(),
  blendMode: blendModeSchema.optional(),
  visible: z.boolean().optional(),
  locked: z.boolean().optional(),
  name: z.string().optional(),
  effects: effectsSchema.optional().describe('drop shadow / blur / glow'),
};

const textRun = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  color: z.string().optional(),
  fontFamily: z.string().optional(),
  fontSize: z.number().positive().optional(),
});
const textShadow = z.object({ color: z.string(), blur: z.number(), offsetX: z.number(), offsetY: z.number() });
const adjustments = z.object({
  brightness: z.number().optional(),
  contrast: z.number().optional(),
  saturation: z.number().optional(),
  exposure: z.number().optional(),
  temperature: z.number().optional(),
  tint: z.number().optional(),
  hue: z.number().optional(),
});
const crop = z.object({
  shape: z.enum(['rect', 'ellipse']),
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
});
const frameFill = z.object({
  url: z.string(),
  width: z.number().positive(),
  height: z.number().positive(),
  zoom: z.number().positive().optional(),
  offsetX: z.number().optional(),
  offsetY: z.number().optional(),
});

const textLayer = z.object({
  type: z.literal('text'),
  text: z.string(),
  fontSize: z.number().positive().optional(),
  fontFamily: z.string().optional(),
  color: z.string().optional().describe('CSS color, e.g. "#ffffff"'),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  align: z.enum(['left', 'center', 'right']).optional(),
  letterSpacing: z.number().optional(),
  stroke: z.string().nullable().optional().describe('outline color, or null for none'),
  strokeWidth: z.number().optional(),
  shadow: textShadow.nullable().optional(),
  runs: z.array(textRun).optional().describe('multi-style character-range overrides'),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  ...baseLayerShape,
});
const imageLayer = z.object({
  type: z.literal('image'),
  url: z.string().describe('image URL (fetched at render time)'),
  width: z.number().positive().describe('natural pixel width'),
  height: z.number().positive().describe('natural pixel height'),
  adjustments: adjustments.optional(),
  crop: crop.optional(),
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
  size: z.number().positive().optional().describe('square box shorthand'),
  width: z.number().positive().optional(),
  height: z.number().positive().optional(),
  ...baseLayerShape,
});
const frameLayer = z.object({
  type: z.literal('frame'),
  frameShape: z.enum(['rect', 'ellipse']).optional(),
  width: z.number().positive(),
  height: z.number().positive(),
  fill: frameFill.nullable().optional().describe('contained image, or null for an empty placeholder'),
  ...baseLayerShape,
});

const pathLayer = z.object({
  type: z.literal('path'),
  points: z.array(z.object({ x: z.number(), y: z.number() })).min(2).describe('absolute doc-space points; position derived from these'),
  stroke: z.string().optional(),
  strokeWidth: z.number().positive().optional(),
  fill: z.string().nullable().optional(),
  closed: z.boolean().optional(),
  ...baseLayerShape,
});

const layerSchema = z.discriminatedUnion('type', [textLayer, imageLayer, shapeLayer, elementLayer, frameLayer, pathLayer]);

const designSpecShape = {
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  background: z
    .union([z.string(), z.object({ from: z.string(), to: z.string(), angle: z.number().optional() })])
    .optional()
    .describe('"transparent", a solid CSS color like "#ffffff", or a gradient {from,to,angle} (angle: 0=→, 90=↓)'),
  layers: z.array(layerSchema).default([]),
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
          'Create a multi-layer design (canvas + text/image/shape/element/frame layers) from a declarative spec. Full editor parity: text stroke/shadow/rich-text, image adjustments/crop, frames, blend modes. Returns the compiled editor document as JSON. Use render_design to get an image.',
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
          'Render a design straight to an image (server-side, no browser). Provide a single-page spec for a PNG/JPEG, OR `pages` (an array of specs) for a multi-page PDF. Same layer shape as create_design.',
        inputSchema: {
          ...designSpecShape,
          pages: z.array(designSpecSchema).optional().describe('multi-page: an array of page specs (renders a PDF)'),
          format: z.enum(['png', 'jpeg', 'pdf']).optional(),
        },
      },
      handler: async (rawArgs: Record<string, unknown>): Promise<CallToolResult> => {
        const { format: rawFormat, pages: rawPages, ...specArgs } = rawArgs;
        const format = rawFormat === 'jpeg' ? 'jpeg' : rawFormat === 'pdf' ? 'pdf' : 'png';

        // Multi-page path -> a PDF.
        if (rawPages !== undefined) {
          const parsedPages = z.array(designSpecSchema).safeParse(rawPages);
          if (!parsedPages.success) {
            return textResult(`invalid pages: ${parsedPages.error.message}`, true);
          }
          try {
            const bytes = await sdk.renderDesign({ pages: parsedPages.data as DesignSpec[], format: 'pdf' });
            return { content: [{ type: 'resource', resource: { uri: 'design://render.pdf', mimeType: 'application/pdf', blob: Buffer.from(bytes).toString('base64') } }] };
          } catch (err) {
            return apiErrorResult(err, 'render_design');
          }
        }

        const parsed = designSpecSchema.safeParse(specArgs);
        if (!parsed.success) {
          return textResult(`invalid design spec: ${parsed.error.message}`, true);
        }
        try {
          const bytes = await sdk.renderDesign({ spec: parsed.data as DesignSpec, format });
          if (format === 'pdf') {
            return { content: [{ type: 'resource', resource: { uri: 'design://render.pdf', mimeType: 'application/pdf', blob: Buffer.from(bytes).toString('base64') } }] };
          }
          return { content: [{ type: 'image', data: Buffer.from(bytes).toString('base64'), mimeType: format === 'jpeg' ? 'image/jpeg' : 'image/png' }] };
        } catch (err) {
          return apiErrorResult(err, 'render_design');
        }
      },
    },
  ];
}
