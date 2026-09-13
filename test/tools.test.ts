import { describe, expect, test } from 'vitest';
import { OPERATION_IDS, OPERATION_PARAMS, OPERATION_REQUIRES_MASK, type OperationId } from '@snapnedit/shared';
import {
  SnapneditApiError,
  type DesignSpec,
  type JobDelivery,
  type JobUrlInput,
  type RunOptions,
  type RunResult,
  type SnapneditClient,
} from '@snapnedit/sdk';
import { buildTools, TOOL_DESCRIPTORS, type BuiltTool } from '../src/tools.js';
import { buildDesignTools } from '../src/designTools.js';
import { buildStorageTools } from '../src/storageTools.js';

/**
 * The SAVED-DESTINATION half of a `SnapneditClient`. Every method throws by
 * default, so a handler that reaches for one it has no business calling fails
 * loudly; `overrides` supplies the one a given test is actually about.
 */
type DestinationMethods = Pick<
  SnapneditClient,
  | 'listDestinations'
  | 'listDestinationSummaries'
  | 'createDestination'
  | 'updateDestination'
  | 'deleteDestination'
  | 'testDestination'
  | 'presignDestinationUpload'
>;

function destinationStubs(overrides: Partial<DestinationMethods> = {}): DestinationMethods {
  const unexpected = (name: string) => async (): Promise<never> => {
    throw new Error(`stub: ${name}() should never be called by this handler`);
  };
  return {
    listDestinations: overrides.listDestinations ?? unexpected('listDestinations'),
    listDestinationSummaries: overrides.listDestinationSummaries ?? unexpected('listDestinationSummaries'),
    createDestination: overrides.createDestination ?? unexpected('createDestination'),
    updateDestination: overrides.updateDestination ?? unexpected('updateDestination'),
    deleteDestination: overrides.deleteDestination ?? unexpected('deleteDestination'),
    testDestination: overrides.testDestination ?? unexpected('testDestination'),
    presignDestinationUpload: overrides.presignDestinationUpload ?? unexpected('presignDestinationUpload'),
  };
}

type RecordedRun = { operation: OperationId; input: Uint8Array | JobUrlInput; opts: RunOptions | undefined };

/**
 * A scripted `SnapneditClient` stub — `run` is the only method any tool
 * handler calls, so `upload`/`createJob`/`getJob` throw if a bug ever makes
 * a handler call them directly instead of going through `run`. Records
 * every `run` call so tests can assert the exact `(operation, input, opts)`
 * a handler passed through.
 */
function stubSdk(
  runImpl: (operation: OperationId, input: Uint8Array | JobUrlInput, opts?: RunOptions) => Promise<RunResult>,
): { sdk: SnapneditClient; calls: RecordedRun[] } {
  const calls: RecordedRun[] = [];
  const sdk: SnapneditClient = {
    run: async (operation, input, opts) => {
      // A bring-your-own-storage run passes `{ url }` straight through; a
      // classic one passes bytes (normalized here so a Blob and a Uint8Array
      // record identically).
      const recorded: Uint8Array | JobUrlInput =
        input instanceof Uint8Array ? input : 'url' in input ? input : new Uint8Array(await input.arrayBuffer());
      calls.push({ operation, input: recorded, opts });
      return runImpl(operation, recorded, opts);
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
    createDesign: async () => {
      throw new Error('stubSdk: createDesign() should never be called by an image-op tool handler');
    },
    createDesignPages: async () => {
      throw new Error('stubSdk: createDesignPages() should never be called by an image-op tool handler');
    },
    renderDesign: async () => {
      throw new Error('stubSdk: renderDesign() should never be called by an image-op tool handler');
    },
    ...destinationStubs(),
  };
  return { sdk, calls };
}

/**
 * A `SnapneditClient` stub for the DESIGN tools — records `createDesign`
 * specs + `renderDesign` calls; the image-op methods throw (a design tool
 * must never reach `run`/`upload`). `overrides` lets a test swap in a
 * throwing `createDesign`/`renderDesign` to exercise the error path.
 */
function designStubSdk(
  overrides: Partial<Pick<SnapneditClient, 'createDesign' | 'renderDesign'>> = {},
): {
  sdk: SnapneditClient;
  createdSpecs: DesignSpec[];
  renderCalls: { spec?: DesignSpec | undefined; pages?: DesignSpec[] | undefined; format?: 'png' | 'jpeg' | 'pdf' | undefined }[];
  pageCalls: DesignSpec[][];
} {
  const createdSpecs: DesignSpec[] = [];
  const renderCalls: { spec?: DesignSpec | undefined; pages?: DesignSpec[] | undefined; format?: 'png' | 'jpeg' | 'pdf' | undefined }[] = [];
  const pageCalls: DesignSpec[][] = [];
  const throwImageOp = (name: string) => async (): Promise<never> => {
    throw new Error(`designStubSdk: ${name}() should never be called by a design tool handler`);
  };
  const sdk: SnapneditClient = {
    run: throwImageOp('run'),
    upload: throwImageOp('upload'),
    createJob: throwImageOp('createJob'),
    getJob: throwImageOp('getJob'),
    createDesignPages: async (spec) => {
      pageCalls.push(spec.pages);
      return { documents: spec.pages.map((p, i) => ({ id: `doc-${i}`, width: p.width })) };
    },
    createDesign:
      overrides.createDesign ??
      (async (spec) => {
        createdSpecs.push(spec);
        return { document: { id: 'doc-1', width: spec.width } };
      }),
    renderDesign:
      overrides.renderDesign ??
      (async (input) => {
        renderCalls.push({ spec: input.spec, pages: input.pages, format: input.format });
        return new Uint8Array([1, 2, 3]);
      }),
    ...destinationStubs(),
  };
  return { sdk, createdSpecs, renderCalls, pageCalls };
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

/** Narrows a recorded `run` input down to plain numbers, failing loudly on the `{ url }` form. */
function inputBytesOf(value: Uint8Array | JobUrlInput | undefined): number[] {
  if (!(value instanceof Uint8Array)) {
    throw new Error(`expected byte input, got ${JSON.stringify(value)}`);
  }
  return Array.from(value);
}

const outputBytes = new Uint8Array([9, 8, 7, 6, 5]);

/** A `run()` result of the ordinary, downloaded kind — plus whatever bring-your-own-storage envelope a test wants on top. */
function okResultWith(envelope: Partial<Pick<RunResult, 'delivery' | 'destination' | 'input'>> = {}): RunResult {
  return {
    downloaded: true,
    output: outputBytes,
    mime: 'image/png',
    jobId: 'job-1',
    download: { url: 'https://api.example.com/results/out.png', expiresAt: '2099-01-01T00:00:00.000Z' },
    input: { kind: 'asset' },
    destination: null,
    delivery: null,
    ...envelope,
  };
}

const okResult: RunResult = okResultWith();

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

  test('`requiresMask` is taken from @snapnedit/shared, not hand-copied', () => {
    for (const descriptor of TOOL_DESCRIPTORS) {
      expect(descriptor.requiresMask, `requiresMask mismatch for "${descriptor.operation}"`).toBe(
        OPERATION_REQUIRES_MASK[descriptor.operation],
      );
    }
  });

  test('every descriptor\'s `params` keys are exactly OPERATION_PARAMS[operation].shape\'s keys', () => {
    for (const descriptor of TOOL_DESCRIPTORS) {
      const schemaKeys = Object.keys(OPERATION_PARAMS[descriptor.operation].shape);
      expect(Object.keys(descriptor.params), `param drift for "${descriptor.operation}"`).toEqual(schemaKeys);
    }
  });

  test('a derived enum param really is the schema\'s enum — the api accepts every option and nothing else', () => {
    // Spot-check via the schema itself: the descriptor holds the SAME zod
    // node (only `.describe()`d), so parsing through it is parsing through
    // the server's own contract.
    const upscale = TOOL_DESCRIPTORS.find((d) => d.operation === 'upscale');
    expect(upscale?.params.factor?.safeParse('4').success).toBe(true);
    expect(upscale?.params.factor?.safeParse('3').success).toBe(false);
    // ...and the shared default rides along, so an omitted param is filled in.
    expect(upscale?.params.factor?.safeParse(undefined).data).toBe('2');
  });

  test('resize_image is exposed, free of masks, and carries the full resize param set', () => {
    const resize = TOOL_DESCRIPTORS.find((d) => d.operation === 'resize-image');
    expect(resize?.name).toBe('resize_image');
    expect(resize?.requiresMask).toBe(false);
    expect(Object.keys(resize?.params ?? {})).toEqual(['width', 'height', 'fit', 'format', 'quality']);
    expect(resize?.description).toContain('FREE');
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
    expect(inputBytesOf(calls[0]?.input)).toEqual(inputBytes);
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
    // `mode` is not sent by the caller: the descriptor's params shape comes
    // straight from `OPERATION_PARAMS['generative-fill']`, whose `mode` carries
    // `.default('quality')`, so zod fills it in during arg validation.
    expect(calls[0]?.opts?.params).toEqual({ prompt: 'a red balloon', mode: 'quality' });
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

/**
 * BRING YOUR OWN STORAGE — `input_url` instead of inline base64, and
 * `destination_put_url` (+ `destination_headers`) so the finished image is
 * PUT straight into the caller's bucket. Neither the input nor the output
 * bytes pass through the agent in that mode.
 */
describe('bring your own storage', () => {
  const putUrl = 'https://bucket.example.com/out.png?X-Amz-Signature=sig';

  test('every image tool advertises input_url, destination_put_url and destination_headers, with image OPTIONAL', () => {
    const { sdk } = stubSdk(async () => okResult);
    for (const tool of buildTools(sdk)) {
      const shape = tool.config.inputSchema;
      expect(Object.keys(shape), `${tool.name} is missing a byos arg`).toEqual(
        expect.arrayContaining(['image', 'input_url', 'destination_put_url', 'destination_headers']),
      );
      // `image` is optional in the SCHEMA precisely because `input_url` can
      // stand in for it (the handler enforces exactly-one).
      expect(shape.image?.safeParse(undefined).success, `${tool.name}.image should be optional`).toBe(true);
      expect(shape.input_url?.safeParse(undefined).success).toBe(true);
      expect(shape.input_url?.safeParse('https://bucket.example.com/in.png').success).toBe(true);
      expect(shape.destination_headers?.safeParse({ 'content-type': 'image/png' }).success).toBe(true);
      expect(shape.destination_headers?.safeParse({ 'content-type': 7 }).success).toBe(false);
    }
  });

  test('input_url is forwarded to sdk.run as { url } — no bytes decoded, nothing uploaded', async () => {
    const { sdk, calls } = stubSdk(async () => okResult);
    const tool = toolByName(buildTools(sdk), 'remove_background');

    const result = await tool.handler({ input_url: 'https://bucket.example.com/in.png' });

    expect(result.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toEqual({ url: 'https://bucket.example.com/in.png' });
    expect(calls[0]?.opts).toEqual({ params: {} });
  });

  test('destination_put_url + destination_headers become the SDK/api destination wire shape', async () => {
    const { sdk, calls } = stubSdk(async () => okResult);
    const tool = toolByName(buildTools(sdk), 'upscale');

    await tool.handler({
      input_url: 'https://bucket.example.com/in.png',
      destination_put_url: putUrl,
      destination_headers: { 'content-type': 'image/png', 'x-amz-acl': 'private' },
      factor: '4',
    });

    expect(calls[0]?.opts?.destination).toEqual({
      type: 'presigned-put',
      url: putUrl,
      headers: { 'content-type': 'image/png', 'x-amz-acl': 'private' },
    });
    expect(calls[0]?.opts?.params).toEqual({ factor: '4' });
  });

  test('a destination with no headers omits the key entirely (rather than sending headers: undefined)', async () => {
    const { sdk, calls } = stubSdk(async () => okResult);
    const tool = toolByName(buildTools(sdk), 'remove_background');

    await tool.handler({ image: b64([1]), destination_put_url: putUrl });

    expect(calls[0]?.opts?.destination).toEqual({ type: 'presigned-put', url: putUrl });
  });

  test('supplying BOTH image and input_url is rejected before sdk.run', async () => {
    const { sdk, calls } = stubSdk(async () => okResult);
    const tool = toolByName(buildTools(sdk), 'remove_background');

    const result = await tool.handler({ image: b64([1]), input_url: 'https://bucket.example.com/in.png' });

    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test('supplying NEITHER image nor input_url is rejected before sdk.run', async () => {
    const { sdk, calls } = stubSdk(async () => okResult);
    const tool = toolByName(buildTools(sdk), 'remove_background');

    const result = await tool.handler({ mime: 'image/png' });

    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test('destination_headers without destination_put_url is rejected (it would be silently dropped otherwise)', async () => {
    const { sdk, calls } = stubSdk(async () => okResult);
    const tool = toolByName(buildTools(sdk), 'remove_background');

    const result = await tool.handler({ image: b64([1]), destination_headers: { 'content-type': 'image/png' } });

    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test('a delivered result returns the delivery report as JSON text, not image bytes', async () => {
    const delivery: JobDelivery = { status: 'delivered', attempts: 1, statusCode: 200 };
    const { sdk } = stubSdk(async () => ({
      downloaded: false,
      jobId: 'job-delivered',
      download: { url: 'https://api.example.com/results/out.png', expiresAt: 'x' },
      input: { kind: 'url' },
      destination: { type: 'presigned-put' },
      delivery,
    }));
    const tool = toolByName(buildTools(sdk), 'remove_background');

    const result = await tool.handler({ input_url: 'https://bucket.example.com/in.png', destination_put_url: putUrl });

    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    const [block] = result.content;
    expect(block?.type).toBe('text');
    expect(JSON.parse(block?.type === 'text' ? block.text : '{}')).toEqual({
      jobId: 'job-delivered',
      delivered: true,
      delivery,
      download: 'https://api.example.com/results/out.png',
    });
  });

  test('a FAILED delivery still returns the image (the job succeeded) plus the delivery record', async () => {
    const delivery: JobDelivery = { status: 'failed', attempts: 3, statusCode: 403, error: 'destination returned 403' };
    const { sdk } = stubSdk(async () => okResultWith({ delivery, destination: { type: 'presigned-put' } }));
    const tool = toolByName(buildTools(sdk), 'remove_background');

    const result = await tool.handler({ image: b64([1]), destination_put_url: putUrl });

    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(2);
    expect(result.content[0]?.type).toBe('image');
    const [, note] = result.content;
    expect(JSON.parse(note?.type === 'text' ? note.text : '{}')).toEqual({ jobId: 'job-1', delivery });
  });

  test('an ordinary run (no destination) still returns just the image block — no empty delivery noise', async () => {
    const { sdk } = stubSdk(async () => okResult);
    const tool = toolByName(buildTools(sdk), 'remove_background');

    const result = await tool.handler({ image: b64([1]) });

    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe('image');
  });

  test('every image tool also advertises destination_id, optional', () => {
    const { sdk } = stubSdk(async () => okResult);
    for (const tool of buildTools(sdk)) {
      const shape = tool.config.inputSchema;
      expect(Object.keys(shape), `${tool.name} is missing destination_id`).toContain('destination_id');
      expect(shape.destination_id?.safeParse(undefined).success).toBe(true);
      expect(shape.destination_id?.safeParse('dst-1').success).toBe(true);
      expect(shape.destination_id?.safeParse('').success).toBe(false);
    }
  });

  test('destination_id becomes the saved-destination wire shape — only the id travels', async () => {
    const { sdk, calls } = stubSdk(async () => okResult);
    const tool = toolByName(buildTools(sdk), 'remove_background');

    await tool.handler({ image: b64([1]), destination_id: 'dst-1' });

    expect(calls[0]?.opts?.destination).toEqual({ type: 'saved', id: 'dst-1' });
  });

  test('destination_id and destination_put_url are mutually exclusive, refused before any credit is spent', async () => {
    const { sdk, calls } = stubSdk(async () => okResult);
    const tool = toolByName(buildTools(sdk), 'remove_background');

    const result = await tool.handler({ image: b64([1]), destination_id: 'dst-1', destination_put_url: putUrl });

    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test('a saved-destination delivery report carries bucket + key (a presigned one has neither)', async () => {
    const delivery: JobDelivery = {
      status: 'delivered',
      attempts: 1,
      statusCode: 200,
      bucket: 'my-app-images',
      key: 'snapnedit/2026/09/13/job-saved.png',
    };
    const { sdk } = stubSdk(async () => ({
      downloaded: false,
      jobId: 'job-saved',
      download: { url: 'https://api.example.com/results/out.png', expiresAt: 'x' },
      input: { kind: 'asset' },
      destination: { type: 'saved', id: 'dst-1', name: 'Production' },
      delivery,
    }));
    const tool = toolByName(buildTools(sdk), 'remove_background');

    const result = await tool.handler({ image: b64([1]), destination_id: 'dst-1' });

    const [block] = result.content;
    expect(JSON.parse(block?.type === 'text' ? block.text : '{}')).toEqual({
      jobId: 'job-saved',
      delivered: true,
      delivery,
      bucket: 'my-app-images',
      key: 'snapnedit/2026/09/13/job-saved.png',
      download: 'https://api.example.com/results/out.png',
    });
  });

  test('deleteAfterDelivery: download comes back null instead of blowing up on a missing url', async () => {
    const delivery: JobDelivery = {
      status: 'delivered',
      attempts: 1,
      statusCode: 200,
      bucket: 'my-app-images',
      key: 'snapnedit/2026/09/13/job-gone.png',
      localCopyDeleted: true,
    };
    const { sdk } = stubSdk(async () => ({
      downloaded: false,
      jobId: 'job-gone',
      download: null,
      input: { kind: 'asset' },
      destination: { type: 'saved', id: 'dst-1', name: 'Production' },
      delivery,
    }));
    const tool = toolByName(buildTools(sdk), 'remove_background');

    const result = await tool.handler({ image: b64([1]), destination_id: 'dst-1' });

    expect(result.isError).toBeUndefined();
    const [block] = result.content;
    expect(JSON.parse(block?.type === 'text' ? block.text : '{}')).toMatchObject({
      jobId: 'job-gone',
      delivered: true,
      download: null,
    });
  });
});

/**
 * The SAVED STORAGE DESTINATION tools. What matters as much as what they do
 * is what is ABSENT: no create/update/delete, because those take an access
 * key and a secret, and an MCP tool's arguments end up in an agent
 * transcript.
 */
describe('storage tools — list_storage_destinations / test_storage_destination', () => {
  const row = {
    id: 'dst-1',
    name: 'Production',
    provider: 'aws-s3' as const,
    bucket: 'my-app-images',
    region: 'us-east-1',
    endpoint: null,
    forcePathStyle: false,
    keyPrefix: 'snapnedit/',
    accessKeyIdLast4: 'MPLE',
    isDefault: true,
    deleteAfterDelivery: false,
    lastTest: { status: 'ok' as const, at: '2026-09-13T00:00:00.000Z' },
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-13T00:00:00.000Z',
  };

  /** A client stub whose ONLY live methods are the storage ones under test. */
  function storageStubSdk(overrides: Partial<DestinationMethods>): SnapneditClient {
    const throwUnexpected = (name: string) => async (): Promise<never> => {
      throw new Error(`storageStubSdk: ${name}() should never be called by a storage tool handler`);
    };
    return {
      run: throwUnexpected('run'),
      upload: throwUnexpected('upload'),
      createJob: throwUnexpected('createJob'),
      getJob: throwUnexpected('getJob'),
      createDesign: throwUnexpected('createDesign'),
      createDesignPages: throwUnexpected('createDesignPages'),
      renderDesign: throwUnexpected('renderDesign'),
      ...destinationStubs(overrides),
    };
  }

  test('exposes exactly the two READ-ONLY tools — no create, update or delete', () => {
    const names = buildStorageTools(storageStubSdk({})).map((tool) => tool.name);
    expect(names).toEqual(['list_storage_destinations', 'test_storage_destination']);
    for (const forbidden of ['create_storage_destination', 'update_storage_destination', 'delete_storage_destination']) {
      expect(names).not.toContain(forbidden);
    }
  });

  test('list_storage_destinations reports ids to use as destination_id, and no credential fragment', async () => {
    const sdk = storageStubSdk({ listDestinations: async () => [row] });
    const tool = toolByName(buildStorageTools(sdk), 'list_storage_destinations');

    const result = await tool.handler({});

    expect(result.isError).toBeUndefined();
    const [block] = result.content;
    const parsed: unknown = JSON.parse(block?.type === 'text' ? block.text : '[]');
    expect(parsed).toEqual([
      {
        id: 'dst-1',
        name: 'Production',
        provider: 'aws-s3',
        bucket: 'my-app-images',
        keyPrefix: 'snapnedit/',
        isDefault: true,
        deleteAfterDelivery: false,
      },
    ]);
    // Nothing about HOW the bucket is reached leaks into the transcript.
    expect(block?.type === 'text' ? block.text : '').not.toContain('MPLE');
    expect(block?.type === 'text' ? block.text : '').not.toContain('us-east-1');
  });

  test('test_storage_destination reports a FAILED probe as a normal (non-error) result', async () => {
    const sdk = storageStubSdk({ testDestination: async () => ({ ok: false, latencyMs: 12, error: 'AccessDenied' }) });
    const tool = toolByName(buildStorageTools(sdk), 'test_storage_destination');

    const result = await tool.handler({ destination_id: 'dst-1' });

    // The tool call worked; the bucket didn't. Those are different things.
    expect(result.isError).toBeUndefined();
    const [block] = result.content;
    expect(JSON.parse(block?.type === 'text' ? block.text : '{}')).toEqual({
      ok: false,
      latencyMs: 12,
      error: 'AccessDenied',
    });
  });

  test('test_storage_destination requires an id, and maps an api error to an error result', async () => {
    const missing = await toolByName(buildStorageTools(storageStubSdk({})), 'test_storage_destination').handler({});
    expect(missing.isError).toBe(true);

    const sdk = storageStubSdk({
      testDestination: async () => {
        throw new SnapneditApiError('not_found', 404, 'storage destination not found: dst-9');
      },
    });
    const result = await toolByName(buildStorageTools(sdk), 'test_storage_destination').handler({ destination_id: 'dst-9' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.type === 'text' ? result.content[0].text : '').toContain('not_found');
  });
});

describe('design tools — create_design / render_design', () => {
  const spec = { width: 800, height: 600, background: '#ffffff', layers: [{ type: 'text', text: 'Hi', x: 400, y: 300 }] };

  test('buildDesignTools exposes exactly create_design + render_design', () => {
    const { sdk } = designStubSdk();
    const names = buildDesignTools(sdk).map((t) => t.name).sort();
    expect(names).toEqual(['create_design', 'render_design']);
  });

  test('create_design validates the spec, calls sdk.createDesign, returns the document JSON as text', async () => {
    const { sdk, createdSpecs } = designStubSdk();
    const tool = toolByName(buildDesignTools(sdk), 'create_design');

    const result = await tool.handler(spec);

    expect(result.isError).toBeUndefined();
    expect(createdSpecs).toHaveLength(1);
    expect(createdSpecs[0]?.width).toBe(800);
    const [block] = result.content;
    const text = block?.type === 'text' ? block.text : '';
    expect(JSON.parse(text)).toEqual({ id: 'doc-1', width: 800 });
  });

  test('create_design rejects an invalid spec before calling the sdk', async () => {
    const { sdk, createdSpecs } = designStubSdk();
    const tool = toolByName(buildDesignTools(sdk), 'create_design');

    const result = await tool.handler({ width: -1, height: 600 });

    expect(result.isError).toBe(true);
    expect(createdSpecs).toHaveLength(0);
  });

  test('render_design strips format, calls sdk.renderDesign, returns a base64 image block', async () => {
    const { sdk, renderCalls } = designStubSdk();
    const tool = toolByName(buildDesignTools(sdk), 'render_design');

    const result = await tool.handler({ ...spec, format: 'jpeg' });

    expect(result.isError).toBeUndefined();
    expect(renderCalls).toHaveLength(1);
    expect(renderCalls[0]?.format).toBe('jpeg');
    expect(renderCalls[0]?.spec?.width).toBe(800);
    const [block] = result.content;
    expect(block?.type).toBe('image');
    if (block?.type === 'image') {
      expect(block.mimeType).toBe('image/jpeg');
      expect(Array.from(Buffer.from(block.data, 'base64'))).toEqual([1, 2, 3]);
    }
  });

  test('render_design defaults to png when no format given', async () => {
    const { sdk, renderCalls } = designStubSdk();
    const tool = toolByName(buildDesignTools(sdk), 'render_design');

    const result = await tool.handler(spec);

    expect(renderCalls[0]?.format).toBe('png');
    const [block] = result.content;
    expect(block?.type === 'image' ? block.mimeType : '').toBe('image/png');
  });

  test('a SnapneditApiError from createDesign becomes an isError result', async () => {
    const { sdk } = designStubSdk({
      createDesign: async () => {
        throw new SnapneditApiError('payment_required', 402, 'no credits');
      },
    });
    const tool = toolByName(buildDesignTools(sdk), 'create_design');

    const result = await tool.handler(spec);

    expect(result.isError).toBe(true);
    const [block] = result.content;
    expect(block?.type === 'text' ? block.text : '').toContain('payment_required');
  });

  test('render_design with `pages` renders a multi-page PDF (resource block, format pdf)', async () => {
    const { sdk, renderCalls } = designStubSdk();
    const tool = toolByName(buildDesignTools(sdk), 'render_design');

    const result = await tool.handler({
      pages: [
        { width: 100, height: 100, layers: [] },
        { width: 120, height: 80, layers: [] },
      ],
    });

    expect(result.isError).toBeUndefined();
    expect(renderCalls).toHaveLength(1);
    expect(renderCalls[0]?.format).toBe('pdf');
    expect(renderCalls[0]?.pages).toHaveLength(2);
    const [block] = result.content;
    expect(block?.type).toBe('resource');
    if (block?.type === 'resource') {
      expect(block.resource.mimeType).toBe('application/pdf');
    }
  });

  test('create_design accepts full-parity layers (frame + image adjustments/crop + text effects)', async () => {
    const { sdk, createdSpecs } = designStubSdk();
    const tool = toolByName(buildDesignTools(sdk), 'create_design');

    const result = await tool.handler({
      width: 400,
      height: 400,
      layers: [
        { type: 'frame', frameShape: 'ellipse', x: 200, y: 200, width: 300, height: 300, fill: { url: 'https://cdn.example.com/p.jpg', width: 800, height: 600, zoom: 1.2 } },
        { type: 'image', url: 'https://cdn.example.com/q.jpg', x: 100, y: 100, width: 200, height: 200, adjustments: { brightness: 0.2, saturation: -0.5 }, crop: { shape: 'rect', x: 0, y: 0, width: 100, height: 100 } },
        { type: 'text', text: 'Hi', x: 200, y: 380, stroke: '#ff0000', strokeWidth: 3, shadow: { color: '#000', blur: 2, offsetX: 1, offsetY: 1 }, blendMode: 'multiply' },
      ],
    });

    expect(result.isError).toBeUndefined();
    expect(createdSpecs).toHaveLength(1);
    expect(createdSpecs[0]?.layers?.map((l) => l.type)).toEqual(['frame', 'image', 'text']);
  });
});
