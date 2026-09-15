'use strict';

/**
 * A batch has to name what it made.
 *
 * The failure this pins: a client added a caption and, in the same batch, tried
 * to style "caption-16" — an id it had guessed, because nothing told it. The
 * add had in fact created nothing (the container's captions already reached its
 * end) and reported success anyway, so the update failed on a caption that
 * never existed and the whole batch rolled back. Twice.
 *
 * The renderer needs a browser, so what is pinned here is the contract the
 * editor and the plugins agree on, read from the sources that state it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const editor = fs.readFileSync(
  path.join(__dirname, '..', '..', 'web', 'src', 'app', 'ferramentas', 'editor-de-video', 'editor-de-video.component.ts'),
  'utf8'
);
const server = fs.readFileSync(path.join(__dirname, 'mcp-server.js'), 'utf8');
const skill = fs.readFileSync(
  path.join(__dirname, '..', '..', 'ai-client', 'claude', 'plugins', 'simple-vlog-editor', 'skills', 'edit-video', 'SKILL.md'),
  'utf8'
);

test('a caption that cannot be placed is refused, not silently skipped', () => {
  assert.match(editor, /if \(previousEnd >= bounds\.end - 0\.1\) \{\s*[\s\S]{0,400}?'no_room'/,
    'addCaption must throw no_room rather than return');
  assert.ok(!/if \(previousEnd >= bounds\.end - 0\.1\) return;/.test(editor),
    'the quiet return is what made the editor report a caption it had not created');
});

test('every creating operation names what it created', () => {
  for (const [what, pattern] of [
    ['caption', /return \{ captionId: caption\.id \?\? null, clipId: clip\.id \}/],
    ['text clip', /return \{ clipId: clip\.id \};/],
    ['video effect', /return \{ videoEffectId: section\.id \?\? null, clipId: clip\.id \}/],
    ['zoom and push-in', /return \{ zoomId: zoom\.id, pushInId: zoom\.id, clipId: clip\.id \}/],
    ['placed image', /return placed \? \{ imageId: placed\.id \?\? null, clipId: clip\.id \} : undefined/]
  ]) {
    assert.match(editor, pattern, `add_${what} must return its id`);
  }
});

test('the batch collects them, for the dry run as well as the commit', () => {
  assert.match(editor, /madeByOperation\.push\(\{ index: operationIndex, type: operation\.type, \.\.\.\(created \?\? \{\}\) \}\)/,
    'the loop must record each operation result');
  const dryRun = /dryRun: true,[\s\S]{0,600}?\};/.exec(editor);
  assert.ok(dryRun && /created: madeByOperation/.test(dryRun[0]), 'a dry run must report the ids it would assign');
  const commit = /committed: true,[\s\S]{0,600}?\};/.exec(editor);
  assert.ok(commit && /created: madeByOperation/.test(commit[0]), 'a commit must report the ids it assigned');
});

test('the id counter is part of the snapshot, so a dry run does not lie about ids', () => {
  assert.match(editor, /interface EditorSnapshot \{[\s\S]*?nextId: number;/, 'the snapshot must carry nextId');
  assert.match(editor, /board: this\.snapshotBoard\(\),\s*\n\s*nextId: this\.nextId,/, 'snapshot() must capture it');
  assert.match(editor, /if \(Number\.isFinite\(snapshot\.nextId\)\) this\.nextId = snapshot\.nextId;/,
    'applySnapshot must restore it, so a rolled-back batch does not burn ids');
});

test('the tool and the skills tell the caller to read the ids rather than guess', () => {
  assert.match(server, /`created` array/, 'apply_edit_batch must document what it returns');
  assert.match(server, /no_room/, 'add_caption must document the refusal');
  assert.match(skill, /Never add something and then update it to style it/);
  assert.match(skill, /`created` array/);
  assert.match(skill, /Captions sit end to end on a container/);
});
