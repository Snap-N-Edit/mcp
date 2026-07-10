import { describe, expect, test } from 'vitest';
import { OPERATION_IDS, type OperationId } from '@snapnedit/shared';
import { SnapneditApiError, type RunOptions, type RunResult, type SnapneditClient } from '@snapnedit/sdk';
import { buildTools, TOOL_DESCRIPTORS, type BuiltTool } from '../src/tools.js';

type RecordedRun = { operation: OperationId; input: Uint8Array; opts: RunOptions | undefined };

/**
 * A scripted `SnapneditClient` stub — `run` is the only method any tool
 * handler calls, so `upload`/`createJob`/`getJob` throw if a bug ever makes
 * a handler call them directly instead of going through `run`. Records
 * every `run` call so tests can assert the exact `(operation, input, opts)`
 * a handler passed through.
 */
function stubSdk(
  runImpl: (operation: OperationId, input: Uint8Array, opts?: RunOptions) => Promise<RunResult>,
): { sdk: SnapneditClient; calls: RecordedRun[] } {
  const calls: RecordedRun[] = [];
  const sdk: SnapneditClient = {
    run: async (operation, input, opts) => {
      const bytes = input instanceof Uint8Array ? input : new Uint8Array(await input.arrayBuffer());
      calls.push({ operation, input: bytes, opts });
      return runImpl(operation, bytes, opts);
    },
    upload: async () => {
      throw new Error('stubSdk: upload() should never be called directly by a tool handler');
    },
    createJob: async () => {
      throw new Error('stubSdk: createJob() should never be called directly by a tool handler');
    },
    getJob: async () => {
      throw new Error('stubSdk: getJob() should never be called directly by a tool handler');
    },
  };
  return { sdk, calls };
}

function toolByName(tools: readonly BuiltTool[], name: string): BuiltTool {
  const found = tools.find((tool) => tool.name === name);
  if (!found) {
    throw new Error(`no tool registered with name "${name}" (have: ${tools.map((t) => t.name).join(', ')})`);
  }
  return found;
}

function b64(bytes: number[]): string {
  return Buffer.from(bytes).toString('base64');
}

/** Narrows a `RunOptions['mask']`/`input` (`Uint8Array | Blob | undefined`) down to plain numbers for `toEqual` assertions, without an `as Uint8Array` assertion cast. */
function bytesOf(value: Uint8Array | Blob | undefined): number[] {
  if (!(value instanceof Uint8Array)) {
    throw new Error(`expected a Uint8Array, got ${value === undefined ? 'undefined' : typeof value}`);
  }
  return Array.from(value);
}

const outputBytes = new Uint8Array([9, 8, 7, 6, 5]);
const okResult: RunResult = { output: outputBytes, mime: 'image/png' };

describe('TOOL_DESCRIPTORS — exhaustive coverage over OPERATION_IDS', () => {
  test('every OperationId maps to exactly one descriptor, no op missing and no extra', () => {
    const operations = TOOL_DESCRIPTORS.map((d) => d.operation).sort();
    expect(operations).toEqual([...OPERATION_IDS].sort());
    expect(new Set(operations).size).toBe(OPERATION_IDS.length);
  });

  test('every descriptor has a unique, non-empty tool name', () => {
    const names = TOOL_DESCRIPTORS.map((d) => d.name);
    expect(names.every((n) => n.length > 0)).toBe(true);
    expect(new Set(names).size).toBe(names.length);
  });

  test('mask-guided ops (magic-eraser, generative-fill, remove-watermark) are the only requiresMask:true entries', () => {
    const maskOps = TOOL_DESCRIPTORS.filter((d) => d.requiresMask).map((d) => d.operation).sort();
    expect(maskOps).toEqual(['generative-fill', 'magic-eraser', 'remove-watermark']);
  });
});

describe('buildTools — exhaustive coverage', () => {
  test('produces exactly one BuiltTool per OperationId, names matching TOOL_DESCRIPTORS', () => {
    const { sdk } = stubSdk(async () => okResult);
    const tools = buildTools(sdk);
    expect(tools).toHaveLength(OPERATION_IDS.length);
    expect(tools.map((t) => t.name).sort()).toEqual(TOOL_DESCRIPTORS.map((d) => d.name).sort());
  });
});

describe('handler — no-param, no-mask op (remove_background)', () => {
  test('decodes base64 image, calls sdk.run(operation, decodedBytes, {params:{}}), returns base64 image content', async () => {
    const { sdk, calls } = stubSdk(async () => okResult);
    const tool = toolByName(buildTools(sdk), 'remove_background');

    const inputBytes = [1, 2, 3, 4];
    const result = await tool.handler({ image: b64(inputBytes) });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.operation).toBe('remove-background');
    expect(Array.from(calls[0]?.input ?? [])).toEqual(inputBytes);
    expect(calls[0]?.opts).toEqual({ params: {} });

    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([{ type: 'image', data: b64(Array.from(outputBytes)), mimeType: 'image/png' }]);
  });

  test('forwards an explicit mime through to sdk.run', async () => {
    const { sdk, calls } = stubSdk(async () => okResult);
    const tool = toolByName(buildTools(sdk), 'remove_background');

    await tool.handler({ image: b64([1]), mime: 'image/jpeg' });

    expect(calls[0]?.opts).toEqual({ params: {}, mime: 'image/jpeg' });
  });
});

describe('handler — params forwarding', () => {
  test('upscale forwards `factor` inside params', async () => {
    const { sdk, calls } = stubSdk(async () => okResult);
    const tool = toolByName(buildTools(sdk), 'upscale');

    await tool.handler({ image: b64([1]), factor: '4' });

    expect(calls[0]?.operation).toBe('upscale');
    expect(calls[0]?.opts).toEqual({ params: { factor: '4' } });
  });

  test('style_transfer forwards `style` inside params', async () => {
    const { sdk, calls } = stubSdk(async () => okResult);
    const tool = toolByName(buildTools(sdk), 'style_transfer');

    await tool.handler({ image: b64([1]), style: 'pastel' });

    expect(calls[0]?.operation).toBe('style-transfer');
    expect(calls[0]?.opts).toEqual({ params: { style: 'pastel' } });
  });

  test('generative_fill requires `prompt` — missing it is rejected as invalid input, not forwarded to sdk.run', async () => {
    const { sdk, calls } = stubSdk(async () => okResult);
    const tool = toolByName(buildTools(sdk), 'generative_fill');

    const result = await tool.handler({ image: b64([1]), mask: b64([2]) });

    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe('handler — mask-guided ops', () => {
  test('magic_eraser: missing mask is rejected as invalid input, not forwarded to sdk.run', async () => {
    const { sdk, calls } = stubSdk(async () => okResult);
    const tool = toolByName(buildTools(sdk), 'magic_eraser');

    const result = await tool.handler({ image: b64([1]) });

    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test('magic_eraser: a provided mask is decoded and forwarded as opts.mask', async () => {
    const { sdk, calls } = stubSdk(async () => okResult);
    const tool = toolByName(buildTools(sdk), 'magic_eraser');

    const maskBytes = [10, 11, 12];
    await tool.handler({ image: b64([1]), mask: b64(maskBytes) });

    expect(calls[0]?.operation).toBe('magic-eraser');
    const opts = calls[0]?.opts;
    expect(opts?.mask).toBeInstanceOf(Uint8Array);
    expect(bytesOf(opts?.mask)).toEqual(maskBytes);
    expect(opts?.params).toEqual({});
  });

  test('generative_fill: mask + prompt are both forwarded', async () => {
    const { sdk, calls } = stubSdk(async () => okResult);
    const tool = toolByName(buildTools(sdk), 'generative_fill');

    await tool.handler({ image: b64([1]), mask: b64([2]), prompt: 'a red balloon' });

    expect(calls[0]?.operation).toBe('generative-fill');
    expect(calls[0]?.opts?.params).toEqual({ prompt: 'a red balloon' });
    expect(bytesOf(calls[0]?.opts?.mask)).toEqual([2]);
  });
});

describe('handler — error mapping', () => {
  test('a SnapneditApiError from sdk.run becomes an isError tool result, not a thrown rejection', async () => {
    const { sdk } = stubSdk(async () => {
      throw new SnapneditApiError('provider_failed', 502, 'upstream provider errored');
    });
    const tool = toolByName(buildTools(sdk), 'remove_background');

    const result = await tool.handler({ image: b64([1]) });

    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    const [block] = result.content;
    expect(block?.type).toBe('text');
    expect(block?.type === 'text' ? block.text : '').toContain('provider_failed');
  });

  test('an unexpected (non-SnapneditApiError) throw from sdk.run also becomes an isError result', async () => {
    const { sdk } = stubSdk(async () => {
      throw new Error('boom');
    });
    const tool = toolByName(buildTools(sdk), 'unblur');

    const result = await tool.handler({ image: b64([1]) });

    expect(result.isError).toBe(true);
    const [block] = result.content;
    expect(block?.type === 'text' ? block.text : '').toContain('boom');
  });

  test('non-base64-shaped required fields (missing image) are rejected before sdk.run is called', async () => {
    const { sdk, calls } = stubSdk(async () => okResult);
    const tool = toolByName(buildTools(sdk), 'colorize');

    const result = await tool.handler({});

    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});
