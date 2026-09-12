'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const editorRoot = path.resolve(__dirname, '../../web/src/app/ferramentas/editor-de-video');
const css = fs.readFileSync(path.join(editorRoot, 'editor-de-video.component.css'), 'utf8');
const html = fs.readFileSync(path.join(editorRoot, 'editor-de-video.component.html'), 'utf8');
const component = fs.readFileSync(path.join(editorRoot, 'editor-de-video.component.ts'), 'utf8');

test('agent modal is viewport-bounded with internal scrolling and narrow/low breakpoints', () => {
  assert.match(css, /\.agente-modal-fundo[\s\S]*?overflow:\s*hidden/);
  assert.match(css, /\.agente-modal[\s\S]*?max-width:\s*calc\(100vw - 2rem\)/);
  assert.match(css, /\.agente-modal-console[\s\S]*?flex:\s*1 1 auto/);
  assert.match(css, /\.agente-modal-console[\s\S]*?overflow:\s*auto/);
  assert.match(css, /overflow-wrap:\s*anywhere/);
  assert.match(css, /@media \(max-width:\s*960px\)/);
  assert.match(css, /@media \(max-height:\s*620px\)/);
});

test('agent log exposes timestamp, level, module, connection loss and diagnostic actions', () => {
  assert.match(html, /line\.timestamp/);
  assert.match(html, /line\.level/);
  assert.match(html, /line\.module/);
  assert.match(html, /Disconnected/);
  assert.match(html, /Copiar diagnóstico/);
  assert.match(html, /Salvar diagnóstico/);
  assert.match(html, /Tentar novamente/);
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
