/**
 * Whether this plugin is the one the current editor was released with.
 *
 * The desktop application and the two AI plugins ship together and speak one
 * protocol. A plugin left behind does not fail as a version error: it fails as
 * a tool answering something the skill did not expect, in the middle of an
 * edit, with nothing anywhere mentioning versions. So the site publishes what
 * the current versions are and this asks, once, at startup.
 *
 * Not being able to reach the site is not being out of date. Every failure here
 * answers `null` and the session goes on in silence — the editor runs entirely
 * on the reader's own machine and must not need the network to start.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MANIFEST_URL = 'https://thebiglearn.org/currentversion';
const UPDATE_PAGE = 'https://thebiglearn.org/';
/** Short: this runs before the first tool call, and nothing waits on it twice. */
const TIMEOUT_MS = 5000;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
/** This plugin's own manifest, beside the scripts that ship with it. */
const OWN_MANIFEST = path.resolve(scriptDir, '..', '.claude-plugin/plugin.json');
/** The name this plugin is published under in the site's manifest. */
const PIECE = 'claude';

export function installedVersion(file = OWN_MANIFEST) {
  try {
    const version = JSON.parse(fs.readFileSync(file, 'utf8')).version;
    return typeof version === 'string' ? version.trim() : '';
  } catch {
    return '';
  }
}

export async function readManifest(url = process.env.SVE_VERSION_MANIFEST || MANIFEST_URL, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow', headers: { accept: 'application/json' } });
    if (!response.ok) return null;
    const body = await response.json();
    return body && typeof body === 'object' ? body : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The sentence to show the reader, or `null` when there is nothing to say.
 *
 * One sentence, and it names both halves: a plugin that is behind is very
 * often installed next to an application that is behind too, and sending the
 * reader to update only the half that noticed is how the pair stays mismatched.
 */
export async function updateNotice(options = {}) {
  const { installed = installedVersion(), read = readManifest } = options;
  const manifest = await read();
  if (!manifest) return null;

  const published = manifest.plugins?.[PIECE];
  if (typeof published !== 'string' || !published.trim() || !installed) return null;
  if (published.trim() === installed) return null;

  const where = typeof manifest.updateUrl === 'string' && manifest.updateUrl ? manifest.updateUrl : UPDATE_PAGE;
  const application = typeof manifest.desktop === 'string' && manifest.desktop ? ` The current desktop application is ${manifest.desktop}.` : '';

  return (
    `SimpleVlogEditor plugin update: this plugin is version ${installed} and the current release is ${published.trim()}.` +
    application +
    ' The desktop application and the plugins are released together, and running them at different versions is what' +
    ` makes an edit fail halfway through. Update both at ${where}`
  );
}
