/**
 * Putting the downloads where the site can hand them out.
 *
 * The buttons on the home page are plain links to files in the site's own
 * assets, which means the builds have to be *inside* the site before the site
 * is deployed. This copies what electron-builder just wrote into two places:
 *
 *   web/src/assets/download/   so the next site build carries them
 *   web/dist/browser/assets/   so the build that already happened carries them too
 *
 * The second is what makes a single pass enough. The site is built first (the
 * downloads pack that build), so by the time there is something to publish the
 * site's output already exists — writing into both means the folder about to be
 * uploaded is correct without building the site a second time.
 *
 * Two things are published, under fixed names so the links never change:
 *
 *   SimpleVlogEditor-Setup.exe      the installer
 *   SimpleVlogEditor-Portable.zip   the same application, unpacked, run in place
 *
 * A manifest goes with them. The buttons are prerendered and do not wait for
 * anything, but the version and the sizes beside them are only knowable here.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const RELEASE = path.join(ROOT, 'release');
const WEB = path.resolve(ROOT, '..', 'web');

const TARGETS = [
  path.join(WEB, 'src', 'assets', 'download'),
  path.join(WEB, 'dist', 'browser', 'assets', 'download')
];

/**
 * What to look for and what to call it once published.
 *
 * `required` separates a build that failed from a target that was simply not
 * asked for: no installer means something went wrong, no zip only means the
 * `zip` target is not in `package.json`.
 */
const ARTIFACTS = [
  { key: 'installer', extension: '.exe', publishAs: 'SimpleVlogEditor-Setup.exe', required: true },
  { key: 'portable', extension: '.zip', publishAs: 'SimpleVlogEditor-Portable.zip', required: false }
];

/**
 * The newest file with this extension in release/.
 *
 * The directory is read flat on purpose: `win-unpacked/SimpleVlogEditor.exe` is
 * the application itself, not something to hand a visitor, and it lives one
 * level down where this will not see it.
 */
function newest(extension) {
  if (!fs.existsSync(RELEASE)) return null;

  const found = fs
    .readdirSync(RELEASE)
    .filter((name) => name.toLowerCase().endsWith(extension))
    .map((name) => path.join(RELEASE, name))
    .filter((file) => fs.statSync(file).isFile())
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

  return found[0] ?? null;
}

function humanSize(bytes) {
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

function main() {
  const { version } = require(path.join(ROOT, 'package.json'));
  const manifest = { version, builtAt: new Date().toISOString() };
  const publishing = [];

  for (const artifact of ARTIFACTS) {
    const source = newest(artifact.extension);

    if (!source) {
      if (artifact.required) {
        console.error(`publish-installer: no ${artifact.extension} in release/. Run electron-builder first.`);
        process.exitCode = 1;
        return;
      }
      continue;
    }

    const bytes = fs.statSync(source).size;
    manifest[artifact.key] = { file: artifact.publishAs, bytes, size: humanSize(bytes) };
    publishing.push({ source, name: artifact.publishAs, size: humanSize(bytes) });
  }

  for (const directory of TARGETS) {
    // dist/ may not exist yet when the downloads are packed on their own. That
    // is not an error: the site build has simply not happened, and when it does
    // it will pick these up from src/assets.
    const parent = path.dirname(path.dirname(directory));
    if (!fs.existsSync(parent)) continue;

    fs.mkdirSync(directory, { recursive: true });
    for (const { source, name } of publishing) {
      fs.copyFileSync(source, path.join(directory, name));
    }
    fs.writeFileSync(path.join(directory, 'installer.json'), JSON.stringify(manifest, null, 2) + '\n');
    // The Codex plugin with the editor embedded is no longer published. A copy
    // left by an older build would stay downloadable from the site, so it goes.
    for (const stale of ['simple-vlog-editor-codex-with-editor-win-x64.zip', 'simple-vlog-editor-claude-with-editor-win-x64.zip']) {
      try { fs.rmSync(path.join(directory, stale), { force: true }); } catch {}
    }

    const where = path.relative(path.resolve(ROOT, '..'), directory);
    console.log(`publish-installer: ${publishing.map((a) => `${a.name} (${a.size})`).join(', ')}  ->  ${where}`);
  }
}

main();
