'use strict';

/**
 * Video Packaging, read from source.
 *
 * The behaviour below lives in the Angular renderer, which these Node tests
 * cannot start. What they can do is hold the wiring in place: the editor kept
 * alive between tabs, its dialogs hidden with it, backgrounds saved from the
 * finished picture, covers tied to the edit they were drawn from, and the log
 * control reachable while a run waits on the reader. The logic itself is
 * covered by the web specs (composed-fidelity, video-packaging.service,
 * packaging-paths).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const web = path.resolve(__dirname, '../../web/src/app');
const read = (relative) => fs.readFileSync(path.join(web, relative), 'utf8');

const editor = read('ferramentas/editor-de-video/editor-de-video.component.ts');
const shell = read('app.component.ts');
const shellHtml = read('app.component.html');
const config = read('app.config.ts');
const reuse = read('shared/ui/tool-route-reuse.ts');
const portal = read('shared/ui/body-portal.directive.ts');
const service = read('ferramentas/video-packaging/video-packaging.service.ts');
const server = fs.readFileSync(path.join(__dirname, 'mcp-server.js'), 'utf8');
const main = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

/** The body of one method, from its signature to the next member at the same indent. */
function method(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `${signature} not found`);
  const next = source.slice(start + signature.length).search(/\n  (private |async |get |readonly |[a-zA-Z]+\()/);
  return source.slice(start, next < 0 ? undefined : start + signature.length + next);
}

test('switching tabs keeps the Video Editor alive instead of rebuilding it', () => {
  assert.match(config, /provide: RouteReuseStrategy, useClass: ToolRouteReuseStrategy/);
  assert.match(reuse, /shouldDetach[\s\S]*?=== 'video-editor'/);
  assert.match(shellHtml, /<router-outlet \(detach\)="setToolVisible\(\$event, false\)" \(attach\)="setToolVisible\(\$event, true\)">/);
  assert.match(editor, /onToolVisibilityChanged\(active: boolean\): void/);
});

test('dialogs moved to <body> are hidden with the tab that owns them', () => {
  assert.match(editor, /providers: \[ToolVisibilityService\]/);
  assert.match(portal, /this\.visibility\?\.register\(this\.host\.nativeElement\)/);
  assert.match(method(editor, 'onToolVisibilityChanged(active: boolean): void'), /this\.toolVisibility\.setActive\(active\)/);
});

test('a folder-permission question brings the hidden editor forward, then hands the tab back', () => {
  const ask = method(editor, 'private askForFolder(');
  assert.match(ask, /this\.toolActive \? null : this\.router\.url/);
  assert.match(ask, /navigateByUrl\('\/video-editor'\)/);
  assert.match(ask, /navigateByUrl\(returnTo\)/);
});

test('save_frames writes the finished picture, never the raw source', () => {
  const save = method(editor, 'private async agentSaveFrames(');
  assert.match(save, /captureComposedFrames\([\s\S]*?\{ strict: true \}\s*\)/);
  assert.doesNotMatch(save, /captureAgentFrames\(/);
  assert.match(save, /outputTime: frame\.outputTime/);
  assert.match(save, /composited: true/);
  assert.match(save, /editFingerprint: fingerprint/);
  // Refusals happen before the folder exists, so nothing half-written is left.
  assert.ok(save.indexOf('captureComposedFrames(') < save.indexOf('ensureAgentFolder('));
});

test('composed capture refuses cut-away and mid-transition instants, and asks for the matte like the encoder', () => {
  const capture = method(editor, 'private async captureComposedFrames(');
  assert.match(capture, /composedFidelity\(plan, clipIndex, clamped\)/);
  assert.match(capture, /'unfaithful_frame'/);
  assert.match(capture, /imageBehindSubject\(item\.image\)/);
  assert.match(capture, /effectNeedsSubject\(videoEffectSectionAt\(plan\.videoEffects, time, clip\.id\)/);
  assert.match(capture, /zoomScaleAt\(plan\.zooms, time\)/);
  assert.match(capture, /frameEffectWarning\(context\)/);
  assert.match(capture, /subjectLayerRendered: needed\.every/);
});

test('a cover is accepted only on a background saved from the edit as it is now', () => {
  assert.match(editor, /registerEditFingerprint\(\(\) => this\.currentEditFingerprint\(\)\)/);
  assert.match(method(service, 'async setThumbnails('), /this\.currentFrames\(\)/);
  assert.match(service, /earlier version of the edit/);
});

test('get_contact_sheet passes composited through to the capture', () => {
  assert.match(method(editor, 'private async agentContactSheet('), /composited: args\['composited'\] === true/);
  assert.match(server, /tool\('get_contact_sheet'[\s\S]*?composited: \{ type: 'boolean'/);
});

test('the log can be moved while a run waits on the style picker', () => {
  assert.match(server, /const priorityTools = new Set\(\[[\s\S]*?'set_ai_control_log'[\s\S]*?\]\)/);
  assert.match(main, /priorityCommands: \[[^\]]*'set_ai_control_log'/);
  assert.match(main, /const STARTUP_EXEMPT = new Set\(\[[\s\S]*?'set_ai_control_log'[\s\S]*?\]\)/);
});

test('a failed relink of media can never leave the editor marked busy', () => {
  const handle = method(editor, 'async handleAgentRequest(');
  const tryAt = handle.indexOf('    try {');
  const relinkAt = handle.indexOf('await this.agentRelinkFromDisk()');
  assert.ok(tryAt > 0 && relinkAt > tryAt, 'the relink must run inside the try that releases the operation');
  assert.match(handle, /finally \{[\s\S]*?this\.globalAgentActivity\.end\(\)/);
});

test('the shell answers the packaging commands and reports stale understanding', () => {
  for (const name of ['set_video_packaging', 'get_video_packaging', 'clear_video_packaging',
    'set_video_understanding', 'get_video_understanding', 'set_packaging_tag_style', 'show_tool', 'set_ai_control_log']) {
    assert.match(shell, new RegExp(`'${name}'`), `${name} is not handled by the shell`);
  }
  assert.match(shell, /understandingState\(\)/);
});

test('automatic Video Packaging is a project setting the assistant reads when it finishes', () => {
  const html = read('ferramentas/editor-de-video/editor-de-video.component.html');
  const defaults = read('ferramentas/editor-de-video/video-editor-defaults.ts');
  const store = read('ferramentas/editor-de-video/video-editor-project.store.ts');
  assert.match(html, /\[checked\]="project\.autoVideoPackaging"[\s\S]*?onAutoVideoPackaging\(\$any\(\$event\.target\)\.checked\)/);
  assert.match(defaults, /autoVideoPackaging: true/, 'on by default keeps what the assistant already did');
  assert.match(store, /autoVideoPackaging: settings\.autoVideoPackaging !== false/, 'older projects open with it on');
  const finish = method(editor, 'private agentFinishEditing(');
  assert.match(finish, /videoPackaging: \{\s*automatic,/);
  assert.match(editor, /typeof patch\.autoVideoPackaging !== 'boolean'/);

  for (const plugin of ['simplevlogeditor-claude-plugin', 'simplevlogeditor-codex-plugin']) {
    const skills = path.resolve(__dirname, '../../ai-client', plugin, 'plugins/simple-vlog-editor/skills');
    for (const skill of ['create-video-packaging/SKILL.md', 'edit-vlog/SKILL.md', 'edit-video/SKILL.md']) {
      const text = fs.readFileSync(path.join(skills, skill), 'utf8');
      assert.match(text, /videoPackaging\.automatic/, `${plugin}/${skill} must read the setting`);
    }
  }
});
