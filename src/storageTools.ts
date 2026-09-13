import { z } from 'zod';
import { SnapneditApiError, type SnapneditClient } from '@snapnedit/sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { BuiltTool } from './tools.js';

/**
 * SAVED STORAGE DESTINATION tools — the read-only half of the feature,
 * exposed to an agent so it can USE the account's buckets without ever
 * handling their credentials.
 *
 * Two tools, deliberately:
 *
 *  - `list_storage_destinations` — which buckets exist, so the agent can pick
 *    one for an image tool's `destination_id` (or tell the user which is the
 *    default).
 *  - `test_storage_destination` — a real write probe, for when a delivery
 *    failed and the question is whether the bucket is reachable at all.
 *
 * WHAT IS NOT HERE, and will not be: create, update and delete. Creating a
 * destination means handing over an access key id and a secret access key,
 * and anything an MCP tool receives is by construction written into an agent
 * transcript — logged, replayed, and often shipped to a model provider. A
 * long-lived cloud credential must not travel that path. Those three
 * operations live in the dashboard (and in `@snapnedit/sdk`, for a server the
 * account controls), and the tool list says so rather than leaving an agent
 * to guess why it cannot find them.
 *
 * Both are scoped to the account of the `SNAPNEDIT_API_KEY` this server runs
 * with — the agent supplies no credential of its own, and cannot reach
 * another account's destinations.
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

const testInputShape = {
  destination_id: z
    .string()
    .min(1)
    .describe('Id of the storage destination to test, as reported by `list_storage_destinations`.'),
};

/** The storage tools bound to `sdk` — see the module doc for why there are exactly two. */
export function buildStorageTools(sdk: SnapneditClient): readonly BuiltTool[] {
  return [
    {
      name: 'list_storage_destinations',
      config: {
        title: 'list_storage_destinations',
        description:
          "List the snapnedit account's saved storage destinations (its own S3-compatible buckets). Use the returned id as `destination_id` on any image tool to have the finished result written straight into that bucket. Read-only: creating, editing and deleting destinations is deliberately not available here, because it would mean putting cloud credentials in this conversation — do that in the snapnedit dashboard.",
        inputSchema: {},
      },
      handler: async (): Promise<CallToolResult> => {
        try {
          const destinations = await sdk.listDestinations();
          // Projected down to what an agent can act on: which bucket, which
          // id, which is the default, and whether it keeps a copy. The key
          // fragment, region, endpoint and test history are noise here (and
          // the fewer account details in a transcript, the better).
          return textResult(
            JSON.stringify(
              destinations.map((destination) => ({
                id: destination.id,
                name: destination.name,
                provider: destination.provider,
                bucket: destination.bucket,
                keyPrefix: destination.keyPrefix,
                isDefault: destination.isDefault,
                deleteAfterDelivery: destination.deleteAfterDelivery,
              })),
            ),
          );
        } catch (err) {
          return apiErrorResult(err, 'list_storage_destinations');
        }
      },
    },
    {
      name: 'test_storage_destination',
      config: {
        title: 'test_storage_destination',
        description:
          'Check that a saved storage destination really works: snapnedit writes a tiny probe object under its key prefix and deletes it again. Returns { ok, latencyMs } or { ok: false, error }. Use it when a delivery failed and you need to know whether the bucket or the credentials are the problem.',
        inputSchema: testInputShape,
      },
      handler: async (rawArgs: Record<string, unknown>): Promise<CallToolResult> => {
        const parsed = z.object(testInputShape).safeParse(rawArgs);
        if (!parsed.success) {
          return {
            content: [{ type: 'text', text: `invalid input for tool "test_storage_destination": ${parsed.error.message}` }],
            isError: true,
          };
        }
        try {
          const result = await sdk.testDestination(parsed.data.destination_id);
          // A failed PROBE is a successful tool call: the agent asked whether
          // the bucket works and got a truthful answer, so this is not an
          // `isError` result.
          return textResult(JSON.stringify(result));
        } catch (err) {
          return apiErrorResult(err, 'test_storage_destination');
        }
      },
    },
  ];
}
