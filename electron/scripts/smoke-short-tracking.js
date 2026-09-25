'use strict';
// Actual desktop bridge + PathBackedFile + bundled detector, in an isolated hidden app.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');
const net = require('node:net');
// Electron uses its own runtime version when launched with a script entry point.
app.getVersion = () => require('../package.json').version;
if (process.argv.includes('--no-gpu-test')) app.disableHardwareAcceleration();
const scratch = fs.mkdtempSync(path.join(__dirname, '../../.sve-tracking-test-'));
process.env.SVE_USER_DATA_DIR = path.join(scratch, 'profile');
process.env.SVE_MCP_ROOTS = scratch;
process.env.SVE_EDITOR_ENDPOINT = `\\\\.\\pipe\\sve-tracking-${process.pid}`;
const source = path.join(scratch, 'source.mp4');
const largeMedia = process.argv.includes('--large-media');
execFileSync(process.env.SVE_FFMPEG || 'ffmpeg', largeMedia
  ? ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=30:d=12', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '8', '-c:a', 'aac', '-movflags', '+faststart', source]
  : ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=15:d=2', '-c:v', 'libx264', source], { windowsHide: true });
console.log('Tracking fixture bytes:', fs.statSync(source).size);
app.on('browser-window-created', (_, win) => {
  win.show = () => {};
  win.webContents.on('console-message', event => console.log('renderer:', event.message));
});
require('../src/main');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function mcpCall(name, args) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(process.env.SVE_EDITOR_ENDPOINT);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('MCP bridge timeout')); }, 10000);
    let buffer = '';
    socket.on('error', error => { clearTimeout(timer); reject(error); });
    socket.on('connect', () => socket.write(JSON.stringify({ type: 'hello', protocolVersion: 2, roots: [scratch] }) + '\n'));
    socket.on('data', chunk => {
      buffer += chunk;
      while (buffer.includes('\n')) {
        const end = buffer.indexOf('\n'), message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        if (message.type === 'hello') socket.write(JSON.stringify({ id: 'focus-test', request: { name, arguments: args } }) + '\n');
        if (message.id === 'focus-test') {
          clearTimeout(timer); socket.destroy();
          if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
        }
      }
    });
  });
}
const watchdog = setTimeout(() => { console.error('Tracking smoke timed out'); app.exit(1); }, 120000);
app.whenReady().then(async () => {
  while (!BrowserWindow.getAllWindows().length) await delay(50);
  const win = BrowserWindow.getAllWindows()[0];
  while (win.webContents.isLoading() || !win.webContents.getURL()) await delay(100);
  const js = code => win.webContents.executeJavaScript(code, true);
  await win.loadURL(new URL('/shorts-generator', win.webContents.getURL()).href);
  for (let i = 0; i < 100 && !await js(`!!document.querySelector('.short-editor')`); i++) await delay(100);
  await js(`window.testEditor = ng.getComponent(document.querySelector('.short-editor').parentElement); void 0`);
  await js(`testEditor.command('short_import_video', {path:${JSON.stringify(source)}}); void 0`);
  while (await js('testEditor.busy')) await delay(100);
  assert.equal(await js('testEditor.error'), '');
  if (largeMedia) {
    // Model the paused read-ahead readers held by simultaneous waveform,
    // filmstrip and preview decoders. These must not occupy every HTTP slot.
    await js(`window.pausedReads=0; window.pausedReaders=Array.from({length:8},(_,i)=>{const r=testEditor.mediaFile.slice(i*1024*1024).stream().getReader(); r.read().then(()=>window.pausedReads++); return r;}); void 0`);
    await delay(1000);
    console.log('Paused readers with first chunk:', await js('window.pausedReads'));
  }
  await js(`testEditor.command('short_set_selection', {ranges:[${largeMedia ? '{start:0.305385,end:7.329241}' : '{start:0,end:1}'}]}); void 0`);
  while (await js('testEditor.busy')) await delay(100);
  assert.equal(await js('testEditor.state.selection.length'), 1);
  await js(`testEditor.openCut(0); window.trackingDone=false; testEditor.toggleTracking(true).then(()=>window.trackingDone=true);`);
  for (let i = 0; i < 100 && !await js('window.trackingDone'); i++) {
    await delay(1000);
    if (i % 5 === 0) console.log(await js(`({progress:testEditor.cutModal?.analysing,error:testEditor.error})`));
  }
  const result = await js(`({done:window.trackingDone,error:testEditor.error,track:testEditor.cutModal?.track})`);
  console.log(result);
  if (largeMedia) await js(`Promise.all(window.pausedReaders.map(r=>r.cancel())); void 0`);
  assert.equal(result.done, true);
  assert.equal(result.error, '');
  assert.ok(result.track?.length, 'Tracking must produce a crop path even when no person is present');
  // A closed dialog must cancel the old worker; reopening starts an independent run.
  await js(`testEditor.closeCut(); testEditor.openCut(0); testEditor.toggleTracking(true); testEditor.closeCut(); void 0`);
  await delay(300);
  assert.equal(await js('testEditor.cutModal'), null);
  assert.equal(await js('testEditor.error'), '');
  const focus = { cutIndex: 0, start: .4, end: .8, x: .8, requestId: 'focus-smoke' };
  await mcpCall('short_set_focus', focus);
  const afterFocus = await mcpCall('short_get_state', {});
  await mcpCall('short_set_focus', focus);
  const afterRetry = await mcpCall('short_get_state', {});
  assert.deepEqual(afterRetry, afterFocus, 'MCP retry must not repeat the focus mutation');
  console.log('PASS desktop tracking with local range-backed media and bundled models');
  if (!process.argv.includes('--no-gpu-test') && !largeMedia) {
    const mediaUrl = await js('testEditor.sourceUrl');
    const web = new BrowserWindow({ show: false, width: 1000, height: 800, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    web.webContents.setUserAgent(web.webContents.getUserAgent().replace(/Electron\/\S+\s*/g, ''));
    await web.loadURL(new URL('/shorts-generator', win.webContents.getURL()).href);
    const browserJs = code => web.webContents.executeJavaScript(code, true);
    while (!await browserJs(`!!document.querySelector('.short-editor')`)) await delay(100);
    assert.equal(await browserJs('!!window.desktop'), false);
    await browserJs(`window.testEditor=ng.getComponent(document.querySelector('.short-editor').parentElement); window.importDone=false; fetch(${JSON.stringify(mediaUrl)}).then(r=>r.blob()).then(b=>testEditor.command('short_import_video',{file:new File([b],'source.mp4',{type:'video/mp4'})})).then(()=>window.importDone=true); void 0`);
    while (!await browserJs('window.importDone')) await delay(100);
    assert.equal(await browserJs('testEditor.error'), '');
    await browserJs(`testEditor.command('short_set_selection',{ranges:[{start:0,end:1}]}); void 0`);
    while (await browserJs('testEditor.busy')) await delay(100);
    await browserJs(`testEditor.openCut(0); window.trackingDone=false; testEditor.toggleTracking(true).then(()=>window.trackingDone=true); void 0`);
    while (!await browserJs('window.trackingDone')) await delay(200);
    assert.equal(await browserJs('testEditor.error'), '');
    assert.ok(await browserJs('testEditor.cutModal.track.length'));
    await browserJs(`testEditor.closeCut(); testEditor.command('short_create'); void 0`);
    while (await browserJs('testEditor.busy')) await delay(100);
    await browserJs(`testEditor.zone.run(()=>testEditor.openSettings(testEditor.state.shorts[0])); void 0`);
    for (const width of [1000, 760, 450]) {
      web.setSize(width, 700);
      await delay(200);
      const visible = await browserJs(`(() => { const field=document.querySelector('#short-config-transition'), modal=document.querySelector('.wide-modal'); modal.scrollTop=0; const r=field.getBoundingClientRect(), m=modal.getBoundingClientRect(); return {visible:field.checkVisibility() && r.top>=m.top && r.bottom<=m.bottom,options:field.options.length,status:testEditor.state.shorts[0].status}; })()`);
      assert.equal(visible.status, 'idle');
      assert.equal(visible.options, 4);
      assert.equal(visible.visible, true, 'Transitions must be visible before first export at width ' + width);
    }
    await browserJs(`testEditor.zone.run(()=>{const select=document.querySelector('#short-config-transition'); select.value='fade'; select.dispatchEvent(new Event('change',{bubbles:true}));}); void 0`);
    await browserJs(`testEditor.zone.run(()=>testEditor.saveSettings()); void 0`);
    while (await browserJs('testEditor.busy')) await delay(100);
    assert.equal(await browserJs('testEditor.state.shorts[0].settings.transition'), 'fade');
    assert.equal(await browserJs('testEditor.modal'), false);
    console.log('PASS transitions visible and saved before first export at 450/760/1000px');
    await browserJs(`testEditor.command('short_render',{id:testEditor.state.shorts[0].id}); void 0`);
    while (!await browserJs(`['done','error'].includes(testEditor.state.shorts[0]?.status)`)) await delay(200);
    assert.equal(await browserJs('testEditor.state.shorts[0].status'), 'done');
    for (const width of [1000, 450]) {
      web.setSize(width, 800);
      await delay(200);
      const bounds = await browserJs(`(() => { const download=document.querySelector('.download'); download.focus(); const a=download.getBoundingClientRect(), b=document.querySelector('.card-body .actions').getBoundingClientRect(); return {height:a.height,bottom:a.bottom,nextTop:b.top}; })()`);
      assert.equal(bounds.height, 34);
      assert.ok(bounds.nextTop >= bounds.bottom + 10, 'Download must not overlap neighbouring controls, including its focus outline');
    }
    console.log('PASS web tracking, browser export and compact download layout at 450/1000px');
    web.destroy();
  }
  clearTimeout(watchdog); app.exit(0);
}).catch(error => { console.error(error); clearTimeout(watchdog); app.exit(1); });
