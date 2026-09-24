'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const editorRoot = path.resolve(__dirname, '../../web/src/app/ferramentas/editor-de-video');
const css = fs.readFileSync(path.join(editorRoot, 'editor-de-video.component.css'), 'utf8');
const html = fs.readFileSync(path.join(editorRoot, 'editor-de-video.component.html'), 'utf8');
const component = fs.readFileSync(path.join(editorRoot, 'editor-de-video.component.ts'), 'utf8');
const main = fs.readFileSync(path.resolve(__dirname, 'main.js'), 'utf8');
const preload = fs.readFileSync(path.resolve(__dirname, 'preload.js'), 'utf8');
const desktop = fs.readFileSync(path.resolve(editorRoot, '../../shared/desktop/desktop.service.ts'), 'utf8');

test('agent modal is viewport-bounded with internal scrolling and narrow/low breakpoints', () => {
  assert.match(css, /\.agente-modal-fundo[\s\S]*?overflow:\s*hidden/);
  assert.match(css, /\.agente-modal[\s\S]*?max-width:\s*calc\(100vw - 2rem\)/);
  assert.match(css, /\.agente-modal-console[\s\S]*?flex:\s*1 1 auto/);
  assert.match(css, /\.agente-modal-console[\s\S]*?overflow:\s*auto/);
  assert.match(css, /overflow-wrap:\s*anywhere/);
  assert.match(css, /@media \(max-width:\s*960px\)/);
  assert.match(css, /@media \(max-height:\s*620px\)/);
});

// The log is global now: one panel in the application shell, on every tab.
// The editor's own copy stays in its template but is switched off, so the
// assertions below read the panel the reader actually sees.
const activityRoot = path.resolve(editorRoot, '../../shared/ui');
const activityHtml = fs.readFileSync(path.join(activityRoot, 'agent-activity.component.html'), 'utf8');
const activityService = fs.readFileSync(path.join(activityRoot, 'agent-activity.service.ts'), 'utf8');
const shellHtml = fs.readFileSync(path.resolve(editorRoot, '../../app.component.html'), 'utf8');

test('agent log exposes timestamp, level, module, connection loss and diagnostic actions', () => {
  assert.match(shellHtml, /<app-agent-activity \/>/, 'the shell must render the global log');
  assert.match(activityHtml, /line\.timestamp/);
  assert.match(activityHtml, /line\.level/);
  assert.match(activityHtml, /line\.module/);
  assert.match(activityHtml, /Disconnected/);
  assert.match(activityHtml, /Copy diagnostic/);
  assert.match(activityHtml, /Save diagnostic/);
  assert.match(activityHtml, /activity\.retry\(\)/);
});

test('the editor\'s old log panel stays switched off, so there is only one', () => {
  const panels = html.match(/@if \((false && )?\(desktop\.agentControl\(\)\.visible \|\| desktop\.agentControl\(\)\.active\) && !agentPanelDismissed/g) ?? [];
  assert.ok(panels.length > 0, 'the old panel markers moved; update this test');
  for (const panel of panels) assert.match(panel, /false && /, 'an editor-local log panel is live again');
});

test('the global log keeps a minimised panel minimised between commands', () => {
  const begin = /begin\(\): void \{([\s\S]*?)\n  \}/.exec(activityService)?.[1] ?? '';
  assert.doesNotMatch(begin, /openValue\.set\(true\)/, 'starting a command must not reopen the panel');
});

test('render and AI completion are depth-styled modals that hand off cleanly to preview', () => {
  assert.match(css, /\.render-fundo[\s\S]*?position:\s*fixed/);
  assert.match(css, /\.render-modal[\s\S]*?box-shadow:/);
  assert.match(css, /\.agente-conclusao-fundo[\s\S]*?z-index:\s*4300/);
  assert.match(css, /\.preview-fundo[\s\S]*?z-index:\s*4200/);
  assert.match(component, /agentFinishEditing[\s\S]*?this\.agentLogOpen = false[\s\S]*?this\.agentCompletionOpen = true/);
});

test('edit batches advertise an unambiguous terminal state and restore their snapshot on failure', () => {
  assert.match(component, /const before = this\.snapshot\(\)/);
  assert.match(component, /terminalState: 'applied'/);
  assert.match(component, /catch \(error\)[\s\S]*?this\.applySnapshot\(before\)[\s\S]*?'batch_rolled_back'/);
  assert.match(component, /terminalState: 'failed', rolledBack: true/);
  assert.match(component, /terminalState: 'cancelled', rolledBack: true/);
});

test('agent export and visual inspection use the cancellable operation signal', () => {
  assert.match(component, /case 'get_frames': result = await this\.agentFrames\([^;]*operationController\.signal/);
  assert.match(component, /case 'get_contact_sheet': result = await this\.agentContactSheet\([^;]*operationController\.signal/);
  assert.match(component, /case 'export': result = await this\.agentExport\([^;]*operationController\.signal/);
  assert.match(component, /Export was cancelled and its partial output was removed/);
});

test('failed audio replacement cannot be reported as a successful reuse of an older soundtrack', () => {
  assert.match(component, /clip\.replacementAudio\?\.file !== file/);
  assert.match(component, /this\.project\.defaultAudio\?\.file !== file/);
});

test('agent output is staged so cancellation cannot delete an older destination', () => {
  assert.match(main, /\.sve-writing/);
  assert.match(main, /fs\.rename\(output\.temporary, output\.file\)/);
  assert.match(main, /agent:output-abort[\s\S]*?fs\.unlink\(output\.temporary\)/);
  assert.doesNotMatch(main, /agent:output-abort[\s\S]{0,500}?fs\.unlink\(output\.file\)/);
});

test('manual editor saves update the Electron recovery checkpoint', () => {
  assert.match(preload, /checkpointProject:[\s\S]*?project:checkpoint/);
  assert.match(preload, /clearProjectCheckpoint:[\s\S]*?project:checkpoint-clear/);
  assert.match(desktop, /async checkpointProject\(/);
  assert.match(component, /saveNow\(\)[\s\S]*?desktop\.checkpointProject\(recoveryDocument, this\.revision\)/);
  assert.match(component, /clearStoredProject\(\)[\s\S]*?desktop\.clearProjectCheckpoint\(this\.revision\)/);
  assert.match(main, /ipcMain\.handle\('project:checkpoint'/);
  assert.match(preload, /close: async \(\)[\s\S]*?await beforeCloseHandler/);
  assert.match(component, /registerBeforeCloseHandler\(\(\) => this\.saveNow\(\)\)/);
  assert.match(main, /if \(!MCP_OPEN \|\| agentControllers\.size > 0\)[\s\S]*?restoreCheckpointIfEmpty/);
});
