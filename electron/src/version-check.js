'use strict';

/**
 * Whether what is installed is what was released.
 *
 * The desktop application and the two AI plugins are released together and
 * speak one protocol to each other. Nothing prevented a reader from leaving a
 * plugin at an old version while the editor moved on, and the failure that
 * produces does not look like a version problem: it looks like a tool that
 * answers something the skill did not expect, in the middle of an edit, with no
 * mention of versions anywhere.
 *
 * So each side asks. The site publishes what the current versions are; this
 * reads that and compares. Being unable to reach the site is not being out of
 * date — an editor that cannot reach the network must go on working in silence,
 * so every failure here answers `null` and nothing is said.
 */

/** The published manifest, and the page a reader is sent to. */
const MANIFEST_URL = 'https://simplevlogeditor.com/currentversion';
const UPDATE_PAGE = 'https://simplevlogeditor.com/';
/** Long enough for a slow connection, short enough not to delay a start. */
const TIMEOUT_MS = 6000;

function manifestUrl(environment = process.env) {
  return environment.SVE_VERSION_MANIFEST || MANIFEST_URL;
}

/** Trailing whitespace and a missing value are not a difference in version. */
function sameVersion(left, right) {
  const a = typeof left === 'string' ? left.trim() : '';
  const b = typeof right === 'string' ? right.trim() : '';
  return Boolean(a) && Boolean(b) && a === b;
}

async function readManifest(url = manifestUrl(), timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { accept: 'application/json' }
    });
    if (!response.ok) return null;
    const body = await response.json();
    return body && typeof body === 'object' ? body : null;
  } catch {
    // Offline, blocked, timed out, or serving something that is not JSON. None
    // of those are evidence about the version that is installed.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Compares one installed version against the published one.
 *
 * Returns `null` when there is nothing to say — no manifest, or no number
 * published for this piece — and a report otherwise, `current` telling the
 * caller whether anything needs saying at all.
 */
async function checkVersion(options = {}) {
  const {
    installed,
    /** `desktop`, or the name of a plugin under `plugins`. */
    piece = 'desktop',
    url = manifestUrl(),
    read = readManifest
  } = options;

  const manifest = await read(url);
  if (!manifest) return null;

  const published = piece === 'desktop' ? manifest.desktop : manifest.plugins?.[piece];
  if (typeof published !== 'string' || !published.trim()) return null;

  return {
    piece,
    installed: typeof installed === 'string' ? installed : '',
    published: published.trim(),
    current: sameVersion(installed, published),
    updateUrl: typeof manifest.updateUrl === 'string' && manifest.updateUrl ? manifest.updateUrl : UPDATE_PAGE,
    manifest
  };
}

/** The one sentence every client says, so all of them say the same one. */
function updateSentence(report, what = 'This application') {
  return (
    `${what} is version ${report.installed || 'unknown'}, and the current release is ${report.published}. ` +
    'The desktop application and the AI plugins are released together, and running them at different ' +
    `versions is what makes an edit fail halfway through. Update both at ${report.updateUrl}`
  );
}

module.exports = { MANIFEST_URL, UPDATE_PAGE, TIMEOUT_MS, manifestUrl, sameVersion, readManifest, checkVersion, updateSentence };
