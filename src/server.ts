/**
 * Builds the real `McpServer` for `@snapnedit/mcp`: wires a real
 * `@snapnedit/sdk` client (talking to `baseUrl` with `apiKey`) and
 * registers every {@link TOOL_DESCRIPTORS} tool on it via
 * `tools.ts`'s `registerTools`.
 *
 * Kept separate from `index.ts` (the stdio bin entrypoint) so this
 * construction — everything except the transport — is exercisable without
 * ever touching stdin/stdout or `process.env`.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createClient } from '@snapnedit/sdk';
import { registerTools } from './tools.js';

const SERVER_NAME = 'snapnedit';
const SERVER_VERSION = '0.1.0';

export interface CreateMcpServerOptions {
  /** Sent as `Authorization: Bearer <apiKey>` on every request the underlying `@snapnedit/sdk` client makes — see `packages/sdk/src/client.ts`. */
  apiKey: string;
  /** Origin of the snapnedit api, e.g. `https://api.snapnedit.com` or `http://localhost:8787`. */
  baseUrl: string;
}

/** Constructs an `McpServer` with every `OperationId` registered as a tool, backed by a real `@snapnedit/sdk` client. Does not connect a transport — callers (`index.ts`) do that separately. */
export function createMcpServer(options: CreateMcpServerOptions): McpServer {
  const sdk = createClient({ baseUrl: options.baseUrl, apiKey: options.apiKey });
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerTools(server, sdk);
  return server;
}
