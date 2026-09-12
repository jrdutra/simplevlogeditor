import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  ClientUsageError,
  MCP_HOST,
  PROJECT_ROOT,
  codexArgs,
  combinedPrompt,
  mcpConfigArgs,
  parseArgs,
  resolveSession,
  tomlString
} from './client.mjs';

const pluginRoot = path.join(PROJECT_ROOT, 'ai-client', 'codex', 'plugins', 'simple-vlog-editor');

test('parses repeatable roots and a non-interactive editing brief', () => {
  const options = parseArgs(['--root', PROJECT_ROOT, '-r', path.dirname(PROJECT_ROOT), '--exec', '--', 'Remove', 'repetitions']);
  assert.deepEqual(options.roots, [PROJECT_ROOT, path.dirname(PROJECT_ROOT)]);
  assert.equal(options.exec, true);
  assert.equal(options.prompt, 'Remove repetitions');
});

test('requires a brief in non-interactive mode', () => {
  assert.throws(() => parseArgs(['--exec']), ClientUsageError);
});

test('builds an ephemeral stdio MCP configuration with admitted roots', () => {
  const options = parseArgs(['--root', PROJECT_ROOT, '--', 'Make a rough cut']);
  const session = resolveSession(options);
  const args = mcpConfigArgs(session, options).join('\n');
  assert.match(args, /mcp_servers\.simple-vlog-editor\.command=/);
  assert.match(args, /SVE_MCP_ROOTS=/);
  assert.match(args, /tool_timeout_sec=1800/);
  assert.ok(args.includes(tomlString(MCP_HOST)));
});

test('runs Codex read-only while keeping MCP editing available', () => {
  const options = parseArgs(['--root', PROJECT_ROOT, '--', 'Add a push-in']);
  const session = resolveSession(options);
  const args = codexArgs(options, session);
  assert.deepEqual(args.slice(args.indexOf('--sandbox'), args.indexOf('--sandbox') + 2), ['--sandbox', 'read-only']);
  assert.ok(args.at(-1).includes('Add a push-in'));
  assert.ok(args.at(-1).includes('add_push_in'));
});

test('the agent protocol requires every audiovisual asset to be understood', () => {
  const prompt = combinedPrompt('Edit this vlog', 'Use add_push_in. Inspect every distinct asset.');
  assert.match(prompt, /Inspect every distinct asset/);
  assert.match(prompt, /Edit this vlog/);
});

test('the Codex plugin exposes the local editor MCP server', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), 'utf8'));
  const mcp = JSON.parse(fs.readFileSync(path.join(pluginRoot, '.mcp.json'), 'utf8'));
  assert.equal(manifest.name, 'simple-vlog-editor');
  assert.equal(manifest.mcpServers, './.mcp.json');
  assert.ok(Array.isArray(manifest.interface.defaultPrompt));
  assert.equal(mcp.mcpServers['simple-vlog-editor'].enabled, true);
  assert.ok(mcp.mcpServers['simple-vlog-editor'].args.includes(MCP_HOST));
});

test('the plugin skill mandates transcripts, frames, revisions and push-ins', () => {
  const skill = fs.readFileSync(path.join(pluginRoot, 'skills', 'edit-video', 'SKILL.md'), 'utf8');
  for (const requirement of ['transcribe every asset', 'contact sheet for every asset', 'expectedRevision', 'dryRun: true', 'add_push_in']) {
    assert.ok(skill.includes(requirement), `missing skill requirement: ${requirement}`);
  }
});
