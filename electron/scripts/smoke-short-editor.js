// Run with Electron after building the site. Uses a hidden window and an isolated profile.
'use strict';
const { app, BrowserWindow, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const net = require('node:net');
// Root policy deliberately denies OS temp folders; keep synthetic media in the workspace.
const scratch = fs.mkdtempSync(path.join(__dirname, '../../.sve-short-ui-'));
console.log('Short Editor UI fixture: ' + scratch);
process.env.SVE_USER_DATA_DIR = path.join(scratch, 'profile');
process.env.SVE_MCP_ROOTS = scratch;
process.env.SVE_EDITOR_ENDPOINT = process.platform === 'win32' ? `\\\\.\\pipe\\sve-short-ui-${process.pid}` : path.join(scratch, 'editor.sock');
const source = path.join(scratch, 'source.mp4');
execFileSync(process.env.SVE_FFMPEG || 'ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=4', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', source], { windowsHide: true });
dialog.showSaveDialog = async () => ({ canceled: false, filePath: path.join(scratch, 'rendered.mp4') });
app.on('browser-window-created', (_event, window) => { window.show = () => {}; });
require('../src/main');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function mcpCall(name, args) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(process.env.SVE_EDITOR_ENDPOINT);
    let buffer = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('MCP bridge timeout')); }, 10000);
    socket.on('error', error => { clearTimeout(timer); reject(error); });
    socket.on('connect', () => socket.write(JSON.stringify({ type: 'hello', protocolVersion: 2, roots: [scratch] }) + '\n'));
    socket.on('data', chunk => {
      buffer += chunk;
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n'), message = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
        if (message.type === 'hello') socket.write(JSON.stringify({ id: 'short-smoke', request: { name, arguments: args } }) + '\n');
        if (message.id === 'short-smoke') {
          clearTimeout(timer); socket.destroy();
          if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
        }
      }
    });
  });
}
let window;
const js = code => window.webContents.executeJavaScript(code, true);
async function until(code) {
  const limit = Date.now() + 30000;
  while (Date.now() < limit) { if (await js(code)) return; await delay(100); }
  console.error(await js(`({text: document.body.innerText.slice(-6000), video: [...document.querySelectorAll('video')].map(v => ({src:v.src, ready:v.readyState, error:v.error?.message}))})`));
  throw new Error('UI condition timed out: ' + code);
}
async function click(text) {
  assert.equal(await js(`(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)}); if (!b || b.disabled) return false; b.click(); return true; })()`), true, 'Button unavailable: ' + text);
}
const watchdog = setTimeout(() => { console.error('Short Editor UI smoke timed out'); app.exit(1); }, 90000);
app.whenReady().then(async () => {
  while (!BrowserWindow.getAllWindows().length) await delay(50);
  window = BrowserWindow.getAllWindows()[0];
  while (window.webContents.isLoading() || !window.webContents.getURL()) await delay(100);
  const origin = new URL(window.webContents.getURL()).origin;
  await window.loadURL(origin + '/shorts-generator');
  await until(`!!document.querySelector('.short-editor') && !!window.desktop?.shortCommand`);
  fs.writeFileSync(path.join(scratch, 'short-editor-empty.png'), (await window.webContents.capturePage()).toPNG());
  await js(`window.desktop.shortCommand('short_import_video', {path: ${JSON.stringify(source)}})`);
  await until(`!!document.querySelector('.tracks') && !!document.querySelector('.player video')?.videoWidth`);
  const bounds = await js(`(() => { const tracks = document.querySelector('.tracks'); tracks.scrollIntoView({block:'center'}); const r = tracks.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width}; })()`);
  const pointer = { x: Math.round(bounds.x + bounds.width * .1), y: Math.round(bounds.y + 70) };
  window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...pointer });
  window.webContents.sendInputEvent({ type: 'mouseMove', button: 'left', ...pointer, x: Math.round(bounds.x + bounds.width * .35) });
  window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...pointer, x: Math.round(bounds.x + bounds.width * .35) });
  await until(`document.querySelectorAll('.cut-row').length === 1`);
  await js(`(() => { const input = document.querySelectorAll('.cut-row input')[1]; input.value = '1'; input.dispatchEvent(new Event('change', {bubbles:true})); })()`);
  await until(`!document.querySelector('.notice')`);
  await click('Criar short');
  await until(`document.querySelectorAll('.short-card').length === 1`);
  await click('+ Trecho no cursor');
  await until(`document.querySelectorAll('.cut-row').length === 1`);
  await click('Criar short');
  await until(`document.querySelectorAll('.short-card').length === 2`);
  await js(`document.querySelector('[aria-label="Aumentar zoom"]').click()`);
  await until(`document.querySelector('.tracks').offsetWidth > document.querySelector('.timeline-scroll').clientWidth`);
  await click('Cortes');
  await until(`document.querySelectorAll('.range').length === 1`);
  await click('Configurações');
  await until(`!!document.querySelector('.settings-modal')`);
  await js(`(() => { const select = document.querySelector('.settings-modal select'); select.value = 'fade'; select.dispatchEvent(new Event('change', {bubbles:true})); })()`);
  await click('Salvar configurações');
  await until(`!document.querySelector('.settings-modal') && document.querySelector('.settings-strip').textContent.includes('Dissolver')`);
  await click('Renderizar short');
  await until(`!!document.querySelector('.success') && !!document.querySelector('.short-card > video')`);
  // Polling must not replace a card's player while it is being watched.
  await js(`window.shortTestPlayer = document.querySelector('.short-card > video')`);
  await delay(1500);
  assert.equal(await js(`window.shortTestPlayer === document.querySelector('.short-card > video')`), true);
  fs.writeFileSync(path.join(scratch, 'short-editor.png'), (await window.webContents.capturePage()).toPNG());
  await window.loadURL(origin + '/video-editor');
  await until(`!!window.desktop?.shortCommand && document.body.textContent.includes('Video Editor')`);
  const state = await js(`window.desktop.shortCommand('short_get_state')`);
  assert.equal(state.shorts.length, 2);
  await mcpCall('short_create', { ranges: [{ start: 0, end: 1 }], name: 'MCP retry', requestId: 'short-smoke-create' });
  await mcpCall('short_create', { ranges: [{ start: 0, end: 1 }], name: 'MCP retry', requestId: 'short-smoke-create' });
  const afterMcp = await js(`window.desktop.shortCommand('short_get_state')`);
  assert.equal(afterMcp.shorts.length, 3, 'Retry must not create a duplicate short');
  console.log('PASS: Short Editor UI, real Electron IPC/MCP, idempotent creation, cards, drag cuts, zoom overflow, modal settings, rendering and route isolation.');
  clearTimeout(watchdog); app.exit(0);
}).catch(error => { console.error(error); clearTimeout(watchdog); app.exit(1); });
