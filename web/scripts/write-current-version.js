/**
 * The version manifest the site serves at `/currentversion`.
 *
 * Three things ship from this repository and have to agree: the desktop
 * application and the two AI plugins. Nothing stopped a reader from running
 * last month's plugin against this month's editor, and the failure that
 * produces is not a version error — it is a tool that answers something the
 * skill did not expect, halfway through an edit.
 *
 * So the versions are published. Each client reads its own version from its own
 * manifest, fetches this file at startup, and says so when they differ. The
 * numbers are taken from the same files the build uses, which is the only way
 * the published manifest cannot drift from what was actually released.
 *
 * Written before `ng build`, so `src/currentversion` is copied into the site
 * like any other asset. Rewritten only when a number changes: it is versioned,
 * and a build that touches it for nothing puts noise in every commit.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.resolve(__dirname, '..', 'src');

/** Where the site tells a reader to go when something is out of date. */
const UPDATE_URL = 'https://thebiglearn.org/';

const SOURCES = {
  desktop: path.join(ROOT, 'electron', 'package.json'),
  claude: path.join(ROOT, 'ai-client', 'claude', 'plugins', 'simple-vlog-editor', '.claude-plugin', 'plugin.json'),
  codex: path.join(ROOT, 'ai-client', 'codex', 'plugins', 'simple-vlog-editor', '.codex-plugin', 'plugin.json')
};

function versionOf(file) {
  try {
    const version = JSON.parse(fs.readFileSync(file, 'utf8')).version;
    return typeof version === 'string' && version.trim() ? version.trim() : null;
  } catch {
    return null;
  }
}

const desktop = versionOf(SOURCES.desktop);
const claude = versionOf(SOURCES.claude);
const codex = versionOf(SOURCES.codex);

const missing = Object.entries({ desktop, claude, codex }).filter(([, value]) => !value).map(([key]) => key);
if (missing.length) {
  // Not fatal, for the same reason `build-desktop.js` is not: a partial
  // checkout should still build a site. A manifest missing a number simply
  // stops that client from being told anything.
  console.warn(`write-current-version: no version found for ${missing.join(', ')} — left out of the manifest`);
}

const manifest = {
  /** Where a reader goes to update whatever is behind. */
  updateUrl: UPDATE_URL,
  /** The desktop application, from electron/package.json. */
  desktop,
  /** Each AI plugin, from its own plugin manifest. */
  plugins: { claude, codex }
};

const body = `${JSON.stringify(manifest, null, 2)}\n`;

// Two names for one file. `/currentversion` is the address the clients ask for;
// `/currentversion.json` is there because a static host that will not serve an
// extensionless file is a real thing, and a client that cannot read the first
// can read the second without anybody redeploying.
let written = 0;
for (const name of ['currentversion', 'currentversion.json']) {
  const target = path.join(OUT, name);
  const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
  if (current === body) continue;
  fs.writeFileSync(target, body);
  written++;
}

console.log(
  `write-current-version: desktop ${desktop ?? '—'}, claude ${claude ?? '—'}, codex ${codex ?? '—'}` +
  ` (${written ? `${written} file(s) rewritten` : 'already current'})\n`
);
