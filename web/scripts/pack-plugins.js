/**
 * The plugin half of every site build.
 *
 * The download menu offers the two AI plugins as archives, and those archives
 * used to be made by hand: the source of the plugin lives in `ai-client/`, the
 * thing the site serves lived in `assets/download/`, and nothing connected
 * them. A plugin edited and deployed was a plugin the site went on serving at
 * its previous version, silently and for as long as nobody thought to rezip it.
 *
 * So the zip is built from the source tree on the way into every build, before
 * `ng build` copies `src/assets` into `dist`.
 *
 * It rewrites an archive only when its *contents* differ from the source — not
 * when the bytes differ. These two files are versioned, and a packer that
 * rebuilt them every time would put a new 24 KB binary into every commit for no
 * change anybody made. Same files in, same archive left alone.
 *
 * Like `build-desktop.js`, a missing piece is reported and skipped rather than
 * failing the build: the site can be built by someone who does not have the
 * plugins, and what it will then serve is whatever is already there.
 */

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const DOWNLOADS = path.resolve(__dirname, '..', 'src', 'assets', 'download');

/** Source tree → the name the site links to. Both are relative to the repo. */
const PLUGINS = [
  { from: path.join('ai-client', 'claude', 'plugins', 'simple-vlog-editor'), to: 'simple-vlog-editor-claude.zip' },
  { from: path.join('ai-client', 'codex', 'plugins', 'simple-vlog-editor'), to: 'simple-vlog-editor-codex.zip' }
];

/** Never worth carrying to somebody else's machine. */
const IGNORED = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini', 'node_modules', '.git']);

// --------------------------------------------------------------- the source

/** Every file under `root`, as archive path → bytes, in a stable order. */
function readTree(root) {
  const files = new Map();
  const walk = (directory, prefix) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (IGNORED.has(entry.name)) continue;
      const full = path.join(directory, entry.name);
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, name);
      else if (entry.isFile()) files.set(name, fs.readFileSync(full));
    }
  };
  walk(root, '');
  return files;
}

// ---------------------------------------------------------------- reading it

/** What an existing archive holds, so an unchanged plugin can be left alone. */
function readZip(file) {
  const buffer = fs.readFileSync(file);
  // The end record is last, and only variable because of its comment, so it is
  // found by scanning backwards rather than by trusting a fixed offset.
  let end = -1;
  for (let at = buffer.length - 22; at >= 0 && at > buffer.length - 66_000; at--) {
    if (buffer.readUInt32LE(at) === 0x06054b50) { end = at; break; }
  }
  if (end < 0) throw new Error('not a zip file');

  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  const entries = new Map();

  for (let index = 0; index < count; index++) {
    if (buffer.readUInt32LE(at) !== 0x02014b50) throw new Error('damaged central directory');
    const method = buffer.readUInt16LE(at + 10);
    const compressed = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const offset = buffer.readUInt32LE(at + 42);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);

    if (!name.endsWith('/')) {
      // The local header repeats the name and carries its own extra field, so
      // where the data starts can only be read from there.
      const localName = buffer.readUInt16LE(offset + 26);
      const localExtra = buffer.readUInt16LE(offset + 28);
      const start = offset + 30 + localName + localExtra;
      const raw = buffer.subarray(start, start + compressed);
      entries.set(name, method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw));
    }
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

const digest = (data) => crypto.createHash('sha256').update(data).digest('hex');

/** True when the archive already holds exactly these files. */
function matches(file, files) {
  if (!fs.existsSync(file)) return false;
  let held;
  try { held = readZip(file); } catch { return false; }
  if (held.size !== files.size) return false;
  for (const [name, data] of files) {
    const there = held.get(name);
    if (!there || digest(there) !== digest(data)) return false;
  }
  return true;
}

// ---------------------------------------------------------------- writing it

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    table[index] = value;
  }
  return table;
})();

function crc32(data) {
  let value = ~0;
  for (let index = 0; index < data.length; index++) value = (value >>> 8) ^ CRC_TABLE[(value ^ data[index]) & 0xff];
  return (~value) >>> 0;
}

/*
 * One fixed moment for every entry.
 *
 * A zip carries the clock, and a zip built from unchanged files at two
 * different times is two different files. Since the point of this script is to
 * leave an unchanged plugin alone, the timestamp has to be a constant rather
 * than "now": 1 January 2020, in the DOS encoding zip has used since 1989.
 */
const DOS_TIME = 0;
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1;

function zipOf(files) {
  const locals = [];
  const central = [];
  let offset = 0;

  // Directories first, then their files, so the archive lists the way a reader
  // expects to see it.
  const directories = new Set();
  for (const name of files.keys()) {
    const parts = name.split('/');
    for (let depth = 1; depth < parts.length; depth++) directories.add(`${parts.slice(0, depth).join('/')}/`);
  }

  const entries = [
    ...[...directories].sort().map((name) => ({ name, data: Buffer.alloc(0), directory: true })),
    ...[...files.keys()].sort().map((name) => ({ name, data: files.get(name), directory: false }))
  ];

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const store = entry.directory || entry.data.length === 0;
    const body = store ? Buffer.alloc(0) : zlib.deflateRawSync(entry.data, { level: 9 });
    const crc = store ? 0 : crc32(entry.data);
    // Bit 11 says the name is UTF-8. Set only when it has to be, so an archive
    // of plain ASCII names stays byte-identical to what any other packer makes.
    const flags = name.equals(Buffer.from(entry.name, 'latin1')) ? 0 : 0x800;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const middle = Buffer.alloc(46);
    middle.writeUInt32LE(0x02014b50, 0);
    middle.writeUInt16LE(20, 4);
    middle.writeUInt16LE(20, 6);
    middle.writeUInt16LE(flags, 8);
    middle.writeUInt16LE(store ? 0 : 8, 10);
    middle.writeUInt16LE(DOS_TIME, 12);
    middle.writeUInt16LE(DOS_DATE, 14);
    middle.writeUInt32LE(crc, 16);
    middle.writeUInt32LE(body.length, 20);
    middle.writeUInt32LE(entry.data.length, 24);
    middle.writeUInt16LE(name.length, 28);
    // Unix permissions in the high half, the DOS directory bit in the low one:
    // a plugin unzipped on macOS or Linux should come out readable and, for
    // the scripts, no stranger than the files beside it.
    middle.writeUInt32LE(entry.directory ? 0x41ed0010 : 0x81a40000, 38);
    middle.writeUInt32LE(offset, 42);
    central.push(middle, name);

    offset += local.length + name.length + body.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, end]);
}

// -------------------------------------------------------------------- doing it

let packed = 0;
let fresh = 0;

for (const plugin of PLUGINS) {
  const source = path.join(ROOT, plugin.from);
  const target = path.join(DOWNLOADS, plugin.to);

  if (!fs.existsSync(source)) {
    console.warn(`pack-plugins: skipped ${plugin.to} — ${plugin.from} is not in this checkout`);
    continue;
  }

  const files = readTree(source);
  if (!files.size) {
    console.warn(`pack-plugins: skipped ${plugin.to} — ${plugin.from} holds no files`);
    continue;
  }

  if (matches(target, files)) {
    fresh++;
    console.log(`pack-plugins: ${plugin.to} is already the ${files.size} files in ${plugin.from}`);
    continue;
  }

  fs.mkdirSync(DOWNLOADS, { recursive: true });
  fs.writeFileSync(target, zipOf(files));
  packed++;
  console.log(`pack-plugins: ${plugin.to} repacked — ${files.size} files from ${plugin.from}`);
}

console.log(`pack-plugins: ${packed} repacked, ${fresh} already current\n`);
