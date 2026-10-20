'use strict';

const { checkVersion, UPDATE_PAGE } = require('./version-check');

/** Published editor releases use three numeric components. */
function isNewerVersion(installed, published) {
  const parse = value => typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value.trim())
    ? value.trim().split('.').map(Number) : null;
  const current = parse(installed), latest = parse(published);
  if (!current || !latest || ![...current, ...latest].every(Number.isSafeInteger)) return false;
  for (let index = 0; index < 3; index++) {
    if (latest[index] !== current[index]) return latest[index] > current[index];
  }
  return false;
}

/** One check and one dismissible notice per application launch, including reloads. */
function createUpdateNotice({ installed, openExternal, check = checkVersion }) {
  let pending;
  let dismissed = false;
  const get = async () => {
    pending ??= Promise.resolve().then(() => check({ installed: installed(), piece: 'desktop' })).then(report => {
      if (!report || !isNewerVersion(report.installed, report.published)) return null;
      let updateUrl = UPDATE_PAGE;
      try {
        const url = new URL(report.updateUrl);
        if (url.protocol === 'https:' || url.protocol === 'http:') updateUrl = url.href;
      } catch {}
      return { installed: report.installed, published: report.published, updateUrl };
    }).catch(() => null);
    const notice = await pending;
    return dismissed ? null : notice;
  };
  return {
    get,
    dismiss: () => { dismissed = true; },
    open: async () => {
      const notice = await get();
      if (!notice) return false;
      await openExternal(notice.updateUrl);
      dismissed = true;
      return true;
    }
  };
}

module.exports = { isNewerVersion, createUpdateNotice };
