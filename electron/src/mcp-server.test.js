'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { startMcpServer } = require('./mcp-server');

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
  const batch = replies[1].result.tools.find((entry) => entry.name === 'apply_edit_batch');
  const operations = batch.inputSchema.properties.operations.items.oneOf;
  assert.ok(operations.some((entry) => entry.properties.type.const === 'add_text_clip'));
  assert.ok(operations.some((entry) => entry.properties.type.const === 'set_tag'));
  const addPushIn = operations.find((entry) => entry.properties.type.const === 'add_push_in');
  assert.ok(addPushIn);
  assert.deepEqual(addPushIn.required, ['type', 'clipId', 'start', 'end']);
  assert.equal(addPushIn.properties.scalePercent.minimum, 2);
  assert.equal(addPushIn.properties.scalePercent.maximum, 80);
  assert.equal(addPushIn.properties.rampSeconds.minimum, 0);
  assert.equal(addPushIn.properties.rampSeconds.maximum, 5);
  assert.ok(operations.some((entry) => entry.properties.type.const === 'update_push_in'));
  assert.ok(operations.some((entry) => entry.properties.type.const === 'remove_push_in'));
  const attachAudio = operations.find((entry) => entry.properties.type.const === 'attach_audio');
  assert.match(attachAudio.properties.clipId.description, /Omit for the project default soundtrack/);
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
