#!/usr/bin/env node
/**
 * Runnable entrypoint for `@snapnedit/mcp` (the `snapnedit-mcp` bin) — reads
 * `SNAPNEDIT_API_KEY`/`SNAPNEDIT_BASE_URL` from the environment, builds the
 * server via `server.ts`'s `createMcpServer`, and connects it over stdio.
 * Self-hostable / runnable via `npx snapnedit-mcp` with no local AI engine —
 * every tool call is proxied to the snapnedit api through `@snapnedit/sdk`.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './server.js';

/** Reads a required env var, failing fast with a clear, actionable message rather than letting a later `undefined` surface as a confusing api error. */
function requireEnv(name: string, env: NodeJS.ProcessEnv): string {
  const value = env[name];
  if (!value) {
    throw new Error(
      `${name} is required. Set it before starting snapnedit-mcp, e.g.:\n` +
        `  SNAPNEDIT_API_KEY=sk_... SNAPNEDIT_BASE_URL=https://api.snapnedit.com npx snapnedit-mcp`,
    );
  }
  return value;
}

async function main(): Promise<void> {
  const apiKey = requireEnv('SNAPNEDIT_API_KEY', process.env);
  const baseUrl = requireEnv('SNAPNEDIT_BASE_URL', process.env);

  const server = createMcpServer({ apiKey, baseUrl });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  // eslint-disable-next-line no-console -- stdout is the MCP transport; stderr is the only safe place for diagnostics.
  console.error(`snapnedit-mcp: ${message}`);
  process.exitCode = 1;
});
