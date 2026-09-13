import { z } from 'zod';
import { SnapneditApiError, type SnapneditClient, type UsageQuery } from '@snapnedit/sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { BuiltTool } from './tools.js';

/**
 * USAGE TRACKING — one read-only tool, `get_usage`.
 *
 * It exists because "how much have I spent?" and "which of my customer sites
 * is burning the credits?" are questions an agent can answer far better than
 * a human clicking through a dashboard, and because a coding agent that just
 * ran twenty background removals should be able to check what that cost.
 *
 * Scoped to the account of the `SNAPNEDIT_API_KEY` the server runs with, like
 * every other tool here — the agent supplies no credential of its own and
 * cannot read another account's usage.
 *
 * The `keys` roster is TRIMMED before it reaches the transcript: an agent
 * needs a key's id, its name and how close it is to its daily cap; it does
 * not need the key's kind, its origins or its creation history, and the
 * fewer account details in a model transcript, the better.
 */

/** Renders `err` as an MCP error result, matching `tools.ts`'s handler convention. */
function apiErrorResult(err: unknown, tool: string): CallToolResult {
  if (err instanceof SnapneditApiError) {
    return {
      content: [{ type: 'text', text: `snapnedit api error (${err.code}, status ${err.status}): ${err.message}` }],
      isError: true,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text', text: `snapnedit-mcp: unexpected error running "${tool}": ${message}` }], isError: true };
}

function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The tool's arguments, in MCP's snake_case rather than the SDK's camelCase —
 * consistent with `destination_id`/`destination_put_url` on the image tools.
 * Every one is optional: `get_usage` with no arguments is the last 30 days.
 */
export const usageInputShape = {
  from: z
    .string()
    .regex(ISO_DATE, 'from must be a YYYY-MM-DD date')
    .optional()
    .describe('Start of the range, inclusive, as YYYY-MM-DD. Defaults to 30 days ago. The range may not exceed 366 days.'),
  to: z
    .string()
    .regex(ISO_DATE, 'to must be a YYYY-MM-DD date')
    .optional()
    .describe('End of the range, inclusive, as YYYY-MM-DD. Defaults to today.'),
  group_by: z
    .enum(['day', 'key', 'origin', 'operation', 'source'])
    .optional()
    .describe(
      'How to bucket the series. "day" (the default) is the time axis; "operation" answers what the credits went on; "origin" answers which embedding site or native app spent them; "key" is per API key; "source" splits API vs embed vs website.',
    ),
  source: z
    .enum(['api', 'embed', 'session', 'anonymous'])
    .optional()
    .describe(
      'Count only jobs from this source: "api" (a secret key), "embed" (an embedded editor session), "session" (a signed-in website visitor) or "anonymous" (a visitor with no account). The last two are free.',
    ),
  operation: z.string().min(1).optional().describe('Count only jobs for this operation id, e.g. "upscale".'),
  key_id: z.string().min(1).optional().describe('Count only jobs billed to this API key id, as reported in the `keys` list.'),
  origin: z
    .string()
    .min(1)
    .optional()
    .describe('Count only jobs from this embed origin — a site origin such as "https://acme.example", or "native:<app id>" for a native app.'),
};

/** The usage tool bound to `sdk`. */
export function buildUsageTools(sdk: SnapneditClient): readonly BuiltTool[] {
  return [
    {
      name: 'get_usage',
      config: {
        title: 'get_usage',
        description:
          "Read the snapnedit account's usage: how many jobs ran, how many credits they cost, how many came back from cache, how many failed, how many results were delivered to storage, and how many embed sessions there were — for any date range, bucketed by day, API key, embed origin, operation or source. Also returns each API key's spend so far TODAY against its daily credit cap. Read-only.",
        inputSchema: usageInputShape,
      },
      handler: async (rawArgs: Record<string, unknown>): Promise<CallToolResult> => {
        const parsed = z.object(usageInputShape).safeParse(rawArgs);
        if (!parsed.success) {
          return {
            content: [{ type: 'text', text: `invalid input for tool "get_usage": ${parsed.error.message}` }],
            isError: true,
          };
        }
        const args = parsed.data;
        // snake_case in, camelCase out. Built with conditional spreads so an
        // omitted filter is an ABSENT key rather than an explicit
        // `undefined` — the api distinguishes "no filter" from an empty one.
        const query: UsageQuery = {
          ...(args.from !== undefined ? { from: args.from } : {}),
          ...(args.to !== undefined ? { to: args.to } : {}),
          ...(args.group_by !== undefined ? { groupBy: args.group_by } : {}),
          ...(args.source !== undefined ? { source: args.source } : {}),
          ...(args.operation !== undefined ? { operation: args.operation } : {}),
          ...(args.key_id !== undefined ? { keyId: args.key_id } : {}),
          ...(args.origin !== undefined ? { origin: args.origin } : {}),
        };
        try {
          const report = await sdk.getUsage(query);
          return textResult(
            JSON.stringify({
              range: report.range,
              groupBy: report.groupBy,
              totals: report.totals,
              series: report.series,
              // Trimmed: id + name to address the key, and the two numbers
              // that say whether it is about to be capped.
              keys: report.keys.map((key) => ({
                id: key.id,
                name: key.name,
                usedToday: key.usedToday,
                dailyCreditLimit: key.dailyCreditLimit,
              })),
            }),
          );
        } catch (err) {
          return apiErrorResult(err, 'get_usage');
        }
      },
    },
  ];
}
