'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isNewerVersion, createUpdateNotice } = require('./update-notice');

test('only a higher published editor version triggers the notice', () => {
  for (const [installed, published, expected] of [
    ['2.1.1', '2.1.2', true], ['2.9.9', '2.10.0', true], ['2.10.0', '3.0.0', true],
    ['2.1.2', '2.1.2', false], ['2.1.2', '2.1.1', false], ['3.0.0', '2.99.99', false],
    ['2.10.0', '2.9.0', false], [' 2.1.1 ', ' 2.1.2 ', true],
    ['', '2.1.2', false], ['2.1.1', 'invalid', false], ['2.1.1', null, false]
  ]) assert.equal(isNewerVersion(installed, published), expected, `${installed} -> ${published}`);
});

function noticeWith(options = {}) {
  return createUpdateNotice({ installed: () => '2.1.1', openExternal: async () => {},
    check: async () => ({ installed: '2.1.1', published: '2.1.2', updateUrl: 'https://simplevlogeditor.com/' }),
    ...options });
}

test('startup and renderer share one check; Later survives a renderer reload', async () => {
  let calls = 0;
  const notice = noticeWith({ check: async ({ installed, piece }) => {
    calls++;
    assert.equal(piece, 'desktop');
    return { installed, published: '2.1.2', updateUrl: 'https://simplevlogeditor.com/' };
  } });
  const [first, second] = await Promise.all([notice.get(), notice.get()]);
  assert.deepEqual(first, second);
  assert.equal(first.published, '2.1.2');
  assert.equal(calls, 1);
  notice.dismiss();
  assert.equal(await notice.get(), null);
  assert.equal(await notice.open(), false);
});

test('offline, equal and older published versions stay silent', async () => {
  for (const check of [async () => null, async () => { throw Error('offline'); },
    async () => ({ installed: '2.1.2', published: '2.1.2' }),
    async () => ({ installed: '2.1.2', published: '2.1.1' })]) {
    assert.equal(await noticeWith({ check }).get(), null);
  }
});

test('the download action opens the published web page and dismisses only after success', async () => {
  const opened = [];
  const notice = noticeWith({ openExternal: async url => { opened.push(url); if (opened.length === 1) throw Error('browser unavailable'); } });
  await assert.rejects(notice.open(), /browser unavailable/);
  assert.ok(await notice.get());
  assert.equal(await notice.open(), true);
  assert.deepEqual(opened, ['https://simplevlogeditor.com/', 'https://simplevlogeditor.com/']);
  assert.equal(await notice.get(), null);
});

test('a manifest cannot turn the download action into a non-web URL', async () => {
  const notice = noticeWith({ check: async () => ({ installed: '2.1.1', published: '2.1.2', updateUrl: 'file:///C:/private' }) });
  assert.equal((await notice.get()).updateUrl, 'https://simplevlogeditor.com/');
});
