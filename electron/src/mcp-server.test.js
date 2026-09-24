'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { startMcpServer, TOOLS, EDIT_OPERATIONS } = require('./mcp-server');

function harness(callEditor = async (request) => ({ apiVersion: 1, projectRevision: 3, result: request })) {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', (chunk) => { text += chunk.toString('utf8'); });
  const close = startMcpServer(callEditor, { input, output });
  const request = (message) => input.write(JSON.stringify(message) + '\n');
  const responses = async (count) => {
    const lines = () => text.split('\n').filter((line) => line.trim());
    for (let tries = 0; tries < 100 && lines().length < count; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    return lines().map(JSON.parse);
  };
  return { request, responses, close };
}

test('negotiates MCP and lists the editor tools', async () => {
  const mcp = harness();
  mcp.request({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  mcp.request({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const replies = await mcp.responses(2);
  assert.equal(replies[0].result.protocolVersion, '2025-06-18');
  assert.ok(replies[1].result.tools.some((entry) => entry.name === 'get_frames'));
  assert.ok(replies[1].result.tools.some((entry) => entry.name === 'get_editor_capabilities'));
  assert.ok(replies[1].result.tools.some((entry) => entry.name === 'apply_edit_batch'));
  assert.ok(replies[1].result.tools.some((entry) => entry.name === 'queue_media_import'));
  assert.ok(replies[1].result.tools.some((entry) => entry.name === 'get_import_status'));
  assert.ok(replies[1].result.tools.some((entry) => entry.name === 'cancel_import'));
  assert.ok(replies[1].result.tools.some((entry) => entry.name === 'get_diagnostics'));
  assert.ok(replies[1].result.tools.some((entry) => entry.name === 'get_recovery_state'));
  assert.ok(replies[1].result.tools.some((entry) => entry.name === 'checkpoint_project'));
  assert.ok(replies[1].result.tools.some((entry) => entry.name === 'close_editor'));
  assert.ok(replies[1].result.tools.some((entry) => entry.name === 'restart_editor'));
  assert.ok(replies[1].result.tools.some((entry) => entry.name === 'get_operation_status'));
  assert.ok(replies[1].result.tools.some((entry) => entry.name === 'cancel_operation'));
  assert.ok(replies[1].result.tools.some((entry) => entry.name === 'get_waveform_page'));
  assert.ok(replies[1].result.tools.some((entry) => entry.name === 'set_project_soundtrack'));
  assert.ok(replies[1].result.tools.some((entry) => entry.name === 'finish_editing'));
  assert.ok(replies[1].result.tools.some((entry) => entry.name === 'analyze_noise'));
  assert.ok(replies[1].result.tools.some((entry) => entry.name === 'suppress_noise'));
  const batch = replies[1].result.tools.find((entry) => entry.name === 'apply_edit_batch');
  const operations = batch.inputSchema.properties.operations.items.oneOf;
  assert.ok(operations.some((entry) => entry.properties.type.const === 'add_text_clip'));
  assert.ok(operations.some((entry) => entry.properties.type.const === 'set_tag'));
  const videoEffect = operations.find((entry) => entry.properties.type.const === 'set_video_effect');
  assert.ok(videoEffect);
  assert.deepEqual(videoEffect.required, ['type', 'clipId', 'effectId']);
  assert.equal(videoEffect.properties.intensity.minimum, 0);
  assert.equal(videoEffect.properties.intensity.maximum, 1);
  const addPushIn = operations.find((entry) => entry.properties.type.const === 'add_push_in');
  assert.ok(addPushIn);
  assert.deepEqual(addPushIn.required, ['type', 'clipId', 'start', 'end']);
  assert.equal(addPushIn.properties.scalePercent.minimum, 2);
  assert.equal(addPushIn.properties.scalePercent.maximum, 80);
  assert.equal(addPushIn.properties.rampSeconds.minimum, 0);
  assert.equal(addPushIn.properties.rampSeconds.maximum, 5);
  assert.ok(operations.some((entry) => entry.properties.type.const === 'update_push_in'));
  assert.ok(operations.some((entry) => entry.properties.type.const === 'remove_push_in'));
  const noiseSetting = operations.find((entry) => entry.properties.type.const === 'set_noise_suppression');
  assert.ok(noiseSetting);
  assert.deepEqual(noiseSetting.required, ['type', 'clipId', 'enabled']);
  const attachAudio = operations.find((entry) => entry.properties.type.const === 'attach_audio');
  assert.match(attachAudio.properties.clipId.description, /Omit for the project default soundtrack/);
  const addCaption = operations.find((entry) => entry.properties.type.const === 'add_caption');
  assert.ok(addCaption.properties.caption);
  assert.match(addCaption.properties.caption.description, /behind-subject/);
  assert.ok(replies[1].result.tools.find((entry) => entry.name === 'get_frames').inputSchema.properties.requestId);
  assert.ok(replies[1].result.tools.find((entry) => entry.name === 'get_contact_sheet').inputSchema.properties.requestId);
  assert.ok(replies[1].result.tools.find((entry) => entry.name === 'export').inputSchema.properties.requestId);
  for (const name of ['add_media', 'queue_media_import', 'open_project', 'set_project_soundtrack', 'analyze_silence', 'analyze_noise', 'suppress_noise', 'apply_edit_batch', 'undo', 'redo']) {
    const mutation = replies[1].result.tools.find((entry) => entry.name === name);
    assert.ok(mutation.inputSchema.required.includes('requestId'), `${name} must require requestId`);
  }
  mcp.close();
});

test('an editor failure is a structured tool error and later calls still work', async () => {
  let calls = 0;
  const mcp = harness(async () => {
    calls++;
    if (calls === 1) throw Object.assign(new Error('probe failed'), {
      code: 'ffprobe_failed', details: { recoverable: true, retryAfterMs: 750 }
    });
    return { apiVersion: 2, projectRevision: 4, result: { state: 'ready' } };
  });
  mcp.request({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_project', arguments: {} } });
  mcp.request({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'health_check', arguments: {} } });
  const replies = await mcp.responses(2);
  assert.equal(replies[0].result.isError, true);
  assert.equal(replies[0].result.structuredContent.error.code, 'ffprobe_failed');
  assert.equal(replies[1].result.structuredContent.result.state, 'ready');
  mcp.close();
});

test('serializes tool calls and returns structured editor results', async () => {
  const seen = [];
  const mcp = harness(async (request) => {
    seen.push(request.name);
    return { apiVersion: 1, projectRevision: seen.length, result: { ok: true } };
  });
  mcp.request({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_project', arguments: {} } });
  mcp.request({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_timeline', arguments: {} } });
  const replies = await mcp.responses(2);
  assert.deepEqual(seen, ['get_project', 'get_timeline']);
  assert.equal(replies[1].result.structuredContent.projectRevision, 2);
  mcp.close();
});

test('priority health calls bypass a blocked edit batch', async () => {
  let releaseBatch;
  const blocked = new Promise((resolve) => { releaseBatch = resolve; });
  const mcp = harness(async (request) => {
    if (request.name === 'apply_edit_batch') await blocked;
    return { apiVersion: 2, projectRevision: 7, result: { name: request.name, state: 'ready' } };
  });
  mcp.request({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'apply_edit_batch', arguments: { operations: [{ type: 'set_project_settings', settings: {} }] }
  } });
  mcp.request({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'health_check', arguments: {} } });
  const first = await mcp.responses(1);
  assert.equal(first[0].id, 2);
  assert.equal(first[0].result.structuredContent.result.name, 'health_check');
  releaseBatch();
  const replies = await mcp.responses(2);
  assert.ok(replies.some((reply) => reply.id === 1));
  mcp.close();
});

test('project reads wait for an atomic edit while priority status remains responsive', async () => {
  let releaseBatch;
  const blocked = new Promise((resolve) => { releaseBatch = resolve; });
  const seen = [];
  const mcp = harness(async (request) => {
    seen.push(request.name);
    if (request.name === 'apply_edit_batch') await blocked;
    return { apiVersion: 2, projectRevision: 9, result: { name: request.name } };
  });
  mcp.request({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'apply_edit_batch', arguments: { operations: [{ type: 'set_project_settings', settings: {} }] }
  } });
  mcp.request({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_project', arguments: {} } });
  mcp.request({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'health_check', arguments: {} } });
  const first = await mcp.responses(1);
  assert.equal(first[0].id, 3);
  assert.ok(seen.includes('apply_edit_batch'));
  assert.ok(seen.includes('health_check'));
  assert.ok(!seen.includes('get_project'));
  releaseBatch();
  const replies = await mcp.responses(3);
  assert.ok(seen.indexOf('get_project') > seen.indexOf('apply_edit_batch'));
  assert.ok(replies.some((reply) => reply.id === 2));
  mcp.close();
});

/**
 * The schema and the editor have to name the same operations.
 *
 * `EDIT_OPERATIONS` here decides what an agent is allowed to send;
 * `agentApplyOperation` in the Angular component decides what actually happens,
 * and `get_editor_capabilities` publishes the list an agent reads. Nothing kept
 * the three in step: an operation declared here and never implemented reached
 * the agent as "unknown edit operation", and one implemented but never declared
 * was invisible.
 *
 * The web package cannot be imported from here — it is TypeScript, in another
 * build — so the declared list is read out of its source. That is deliberately
 * the *declared* list rather than the switch: the companion spec in the web
 * package proves the declared list is implemented, and the two together close
 * the loop without either side having to parse the other's code.
 */
test('every declared edit operation has a schema, and every schema is declared', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  // Looked for in both files the list has lived in, newest first, so moving it
  // between them is a refactor rather than a silently skipped test.
  const editor = path.join(__dirname, '..', '..', 'web', 'src', 'app', 'ferramentas', 'editor-de-video');
  const candidates = ['editor-agent-capabilities.ts', 'editor-de-video.component.ts']
    .map((name) => path.join(editor, name))
    .filter((file) => fs.existsSync(file));
  assert.ok(candidates.length, `No editor source found under ${editor}. This test compares the MCP schema against it.`);

  let block = null;
  for (const file of candidates) {
    block = fs.readFileSync(file, 'utf8').match(/operationTypes:\s*\[([\s\S]*?)\]/);
    if (block) break;
  }
  assert.ok(block, 'get_editor_capabilities no longer publishes an operationTypes array.');
  const declared = new Set([...block[1].matchAll(/'([a-z_]+)'/g)].map((match) => match[1]));
  const schema = new Set(EDIT_OPERATIONS.map((operation) => operation.properties.type.const));

  const missingSchema = [...declared].filter((type) => !schema.has(type)).sort();
  const missingDeclaration = [...schema].filter((type) => !declared.has(type)).sort();
  assert.deepEqual(missingSchema, [], 'declared by the editor but absent from the MCP schema');
  assert.deepEqual(missingDeclaration, [], 'present in the MCP schema but not declared by the editor');
});

test('every operation schema is closed and states the arguments it requires', () => {
  const seen = new Set();
  for (const operation of EDIT_OPERATIONS) {
    const type = operation.properties.type.const;
    assert.ok(type, 'an edit operation has no type constant');
    assert.ok(!seen.has(type), `edit operation "${type}" is declared twice`);
    seen.add(type);
    // Closed on purpose: a misspelled argument must be refused at the schema
    // rather than silently ignored by the editor.
    assert.equal(operation.additionalProperties, false, `edit operation "${type}" accepts unknown properties`);
    for (const required of operation.required) {
      if (required === 'type') continue;
      assert.ok(
        Object.prototype.hasOwnProperty.call(operation.properties, required),
        `edit operation "${type}" requires "${required}" but never describes it`
      );
    }
  }
});

/**
 * Every tool must be served by somebody.
 *
 * Two halves answer them: the editor's own `commands`, handled in the Angular
 * component, and the `hostCommands` Electron serves itself and merges into the
 * capabilities reply before it reaches the agent. A tool declared here and in
 * neither half reaches the renderer and comes back as `unknown_command` — which
 * is what this catches, and the reason the editor's shorter list is not a fault.
 */
test('every tool is served by the editor or by the Electron host', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..', '..');
  const editorSources = ['editor-agent-capabilities.ts', 'editor-de-video.component.ts']
    .map((name) => path.join(root, 'web', 'src', 'app', 'ferramentas', 'editor-de-video', name))
    .filter((file) => fs.existsSync(file));
  assert.ok(editorSources.length, 'No editor source found to read the command list from.');

  let commands = null;
  for (const file of editorSources) {
    commands = fs.readFileSync(file, 'utf8').match(/commands:\s*\[([\s\S]*?)\]/);
    if (commands) break;
  }
  assert.ok(commands, 'get_editor_capabilities no longer publishes a commands array.');

  const host = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8').match(/hostCommands\s*=\s*\[([\s\S]*?)\]/);
  assert.ok(host, 'main.js no longer publishes a hostCommands array.');

  const served = new Set([
    ...[...commands[1].matchAll(/'([a-z_]+)'/g)].map((match) => match[1]),
    ...[...host[1].matchAll(/'([a-z_]+)'/g)].map((match) => match[1])
  ]);
  const unserved = TOOLS.map((tool) => tool.name).filter((name) => !served.has(name)).sort();
  assert.deepEqual(unserved, [], 'declared as tools but served by neither the editor nor the host');
});

test('every tool is named once and describes what it does', () => {
  const seen = new Set();
  for (const tool of TOOLS) {
    assert.ok(!seen.has(tool.name), `tool "${tool.name}" is declared twice`);
    seen.add(tool.name);
    assert.ok(tool.description && tool.description.length > 20, `tool "${tool.name}" has no usable description`);
  }
});

/* ------------------------------------------------ the MCP roots capability */

function rootsHarness(options = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const sent = [];
  let buffered = '';
  output.on('data', (chunk) => {
    buffered += chunk.toString('utf8');
    while (buffered.includes('\n')) {
      const at = buffered.indexOf('\n');
      const line = buffered.slice(0, at);
      buffered = buffered.slice(at + 1);
      if (line.trim()) sent.push(JSON.parse(line));
    }
  });
  const reported = [];
  const close = startMcpServer(
    async (request) => ({ apiVersion: 2, projectRevision: 1, result: request }),
    { input, output, onClientRoots: (roots) => reported.push(roots), ...options }
  );
  const write = (message) => input.write(JSON.stringify(message) + '\n');
  const settle = async (predicate) => {
    for (let tries = 0; tries < 200 && !predicate(); tries++) await new Promise((resolve) => setTimeout(resolve, 2));
  };
  return { write, sent, reported, settle, close };
}

const ROOTS_CAPABILITY = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: { roots: {} } } };

test('a client that offers roots is asked for them once it has initialized', async () => {
  const mcp = rootsHarness();
  mcp.write(ROOTS_CAPABILITY);
  mcp.write({ jsonrpc: '2.0', method: 'notifications/initialized' });
  await mcp.settle(() => mcp.sent.some((message) => message.method === 'roots/list'));

  const asked = mcp.sent.find((message) => message.method === 'roots/list');
  assert.ok(asked, 'the server must ask the client for its roots');
  assert.match(String(asked.id), /^sve-/, 'an outbound id must not be able to collide with a client id');

  // Built from the running platform's own absolute path: a hard-coded
  // file:///home/... is not an absolute path on Windows and cannot be mapped.
  const videos = require('node:path').resolve('/home/joao/Videos');
  mcp.write({ jsonrpc: '2.0', id: asked.id, result: { roots: [
    { uri: require('node:url').pathToFileURL(videos).href, name: 'Videos' },
    { uri: 'https://example.com/not-a-folder' }
  ] } });
  await mcp.settle(() => mcp.reported.length > 0);
  assert.deepEqual(mcp.reported[0], [videos], 'only file:// roots are folders');
  mcp.close();
});

test('a client that does not offer roots is never asked', async () => {
  const mcp = rootsHarness();
  mcp.write({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } });
  mcp.write({ jsonrpc: '2.0', method: 'notifications/initialized' });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.ok(!mcp.sent.some((message) => message.method === 'roots/list'));
  assert.deepEqual(mcp.reported, []);
  mcp.close();
});

test('roots/list_changed asks again, so connecting a folder mid-session is noticed', async () => {
  const mcp = rootsHarness();
  mcp.write(ROOTS_CAPABILITY);
  mcp.write({ jsonrpc: '2.0', method: 'notifications/initialized' });
  await mcp.settle(() => mcp.sent.filter((message) => message.method === 'roots/list').length === 1);
  const first = mcp.sent.find((message) => message.method === 'roots/list');
  mcp.write({ jsonrpc: '2.0', id: first.id, result: { roots: [{ uri: 'file:///a' }] } });
  await mcp.settle(() => mcp.reported.length === 1);

  mcp.write({ jsonrpc: '2.0', method: 'notifications/roots/list_changed' });
  await mcp.settle(() => mcp.sent.filter((message) => message.method === 'roots/list').length === 2);
  const second = mcp.sent.filter((message) => message.method === 'roots/list')[1];
  mcp.write({ jsonrpc: '2.0', id: second.id, result: { roots: [{ uri: 'file:///a' }, { uri: 'file:///b' }] } });
  await mcp.settle(() => mcp.reported.length === 2);
  assert.deepEqual(mcp.reported[1], ['/a', '/b']);
  mcp.close();
});

test('a client that answers roots/list with an error changes nothing', async () => {
  const mcp = rootsHarness();
  mcp.write(ROOTS_CAPABILITY);
  mcp.write({ jsonrpc: '2.0', method: 'notifications/initialized' });
  await mcp.settle(() => mcp.sent.some((message) => message.method === 'roots/list'));
  const asked = mcp.sent.find((message) => message.method === 'roots/list');
  mcp.write({ jsonrpc: '2.0', id: asked.id, error: { code: -32601, message: 'Method not found' } });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.deepEqual(mcp.reported, [], 'a refusal is the ordinary case, not a reason to report nothing as something');
  mcp.close();
});

test('an unknown notification is still ignored rather than answered', async () => {
  const mcp = rootsHarness();
  mcp.write(ROOTS_CAPABILITY);
  mcp.write({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 7 } });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(!mcp.sent.some((message) => message.error), 'a notification must never be answered');
  mcp.close();
});
