(() => {
  'use strict';
  const bridge = window.SimpleVlogAndroid;
  if (!bridge || window.top !== window) return;

  const pending = new Map();
  const blobs = new Map();
  let sequence = 0;
  let saving = false;

  bridge.onmessage = event => {
    let reply;
    try { reply = JSON.parse(event.data); } catch { return; }
    if (!reply || typeof reply !== 'object') return;
    const call = pending.get(reply.id);
    if (!call) return;
    pending.delete(reply.id);
    clearTimeout(call.timer);
    if (reply.error) call.reject(new Error(reply.error));
    else call.resolve(reply);
  };

  function request(action, payload = {}, timeout = 30000) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = timeout ? setTimeout(() => {
        pending.delete(id);
        reject(new Error('O Android não respondeu ao salvamento.'));
      }, timeout) : undefined;
      pending.set(id, { resolve, reject, timer });
      try { bridge.postMessage(JSON.stringify({ id, action, ...payload })); }
      catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  // The web app revokes its URL immediately after anchor.click(). Keep the Blob
  // itself until that click has captured it; do not fetch an already revoked URL.
  const createObjectURL = URL.createObjectURL.bind(URL);
  const revokeObjectURL = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = blob => {
    const url = createObjectURL(blob);
    if (blob instanceof Blob) blobs.set(url, blob);
    return url;
  };
  URL.revokeObjectURL = url => {
    blobs.delete(url);
    revokeObjectURL(url);
  };

  async function save(url, name) {
    if (saving) {
      window.alert('Aguarde o salvamento atual terminar.');
      return;
    }
    saving = true;
    let opened = false;
    const retained = blobs.get(url);
    try {
      let blob = retained;
      if (!blob) {
        const response = await fetch(url);
        if (!response.ok) throw new Error('Não foi possível ler o arquivo exportado.');
        blob = await response.blob();
      }
      const ready = await request('begin', {
        name: name || 'export', mime: blob.type || 'application/octet-stream'
      }, 0); // The system file picker may remain open for as long as necessary.
      if (ready.canceled) return;
      opened = true;

      // Acknowledge every chunk: memory stays bounded even for large videos.
      const chunkSize = 192 * 1024;
      for (let offset = 0; offset < blob.size; offset += chunkSize) {
        const bytes = new Uint8Array(await blob.slice(offset, offset + chunkSize).arrayBuffer());
        let binary = '';
        for (let i = 0; i < bytes.length; i += 8192) {
          binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        }
        await request('chunk', { data: btoa(binary) });
      }
      await request('finish');
    } catch (error) {
      if (opened) await request('abort').catch(() => {});
      window.alert(error.message || 'Não foi possível salvar o arquivo.');
    } finally {
      saving = false;
    }
  }

  function canSave(anchor) {
    return anchor.hasAttribute('download') || anchor.href.startsWith('blob:') ||
      anchor.href.startsWith('data:');
  }

  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (canSave(this)) void save(this.href, this.download);
    else click.call(this);
  };
  document.addEventListener('click', event => {
    const anchor = event.target instanceof Element ? event.target.closest('a') : null;
    if (!anchor || !canSave(anchor)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void save(anchor.href, anchor.download);
  }, true);
  window.simpleVlogSaveDownload = save;
})();
