import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from '../../web/node_modules/js-yaml/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const plugins = ['simplevlogeditor-claude-plugin', 'simplevlogeditor-codex-plugin'];

function skill(plugin, relative) {
  return fs.readFileSync(path.join(root, plugin, 'plugins', 'simple-vlog-editor', 'skills', relative), 'utf8');
}

test('client skills have valid discoverable metadata and existing linked references', () => {
  for (const plugin of plugins) {
    for (const name of ['edit-video', 'edit-vlog', 'create-video-packaging']) {
      const source = skill(plugin, `${name}/SKILL.md`);
      const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
      assert.ok(match, `${plugin}/${name}: YAML frontmatter`);
      const metadata = yaml.load(match[1]);
      assert.equal(metadata.name, name);
      assert.match(metadata.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      assert.ok(typeof metadata.description === 'string' && metadata.description.length > 0 && metadata.description.length <= 1024);
      assert.doesNotMatch(metadata.description, /[<>]|\[TODO:/);
      assert.ok(Object.keys(metadata).every(key => ['name', 'description', 'license', 'allowed-tools', 'metadata'].includes(key)));
      for (const link of source.matchAll(/\]\((references\/[^)]+)\)/g)) {
        assert.ok(fs.existsSync(path.join(root, plugin, 'plugins', 'simple-vlog-editor', 'skills', name, link[1])), link[1]);
      }
    }
  }
});

test('both AI clients ship the same workflow instructions', () => {
  for (const relative of [
    'edit-video/SKILL.md',
    'edit-vlog/SKILL.md',
    'edit-vlog/references/editorial-blocks.md',
    'edit-video/references/mcp-operations.md',
    'edit-video/references/cut-inspection.md',
    'create-video-packaging/SKILL.md',
    'create-video-packaging/references/cover-prompt.md',
    'review-youtube-policy/SKILL.md',
    'review-youtube-policy/references/youtube-community-guidelines.md'
  ]) {
    assert.equal(skill(plugins[0], relative), skill(plugins[1], relative), relative);
  }
});

test('the detailed YouTube catalog is deferred until the final gate', () => {
  for (const plugin of plugins) {
    const edit = skill(plugin, 'edit-video/SKILL.md');
    const vlog = skill(plugin, 'edit-vlog/SKILL.md');
    const policy = skill(plugin, 'review-youtube-policy/SKILL.md');

    assert.match(edit, /Do not load `review-youtube-policy`.*while building the\nstory/);
    assert.ok(vlog.indexOf('Phase 38a — Final-only YouTube policy gate') > vlog.indexOf('Phase 38 — Final technical check'));
    assert.doesNotMatch(vlog.slice(0, vlog.indexOf('Phase 38a')), /youtube-community-guidelines\.md/);
    assert.match(policy, /read the complete \[policy catalog\].* once/);
    assert.match(policy, /Reuse that record.*instead of loading or pasting the catalog again/s);
  }
});

test('cover delivery proves active-style provenance and visual review', () => {
  for (const plugin of plugins) {
    const packaging = skill(plugin, 'create-video-packaging/SKILL.md');
    const prompt = skill(plugin, 'create-video-packaging/references/cover-prompt.md');
    for (const field of ['tagStyleId', 'tagStyleReferencePath', 'letteringMethod', 'styleVerification']) {
      assert.match(packaging, new RegExp(`\\b${field}\\b`));
    }
    assert.match(prompt, /Do not add slashes, side streaks, brush marks/);
    assert.match(prompt, /compose\nthe type deterministically/);
    assert.match(prompt, /saved final-edit frame is the protected image master/);
    assert.match(prompt, /\[OPTIONAL IDENTITY GUARD\]/);
    assert.match(prompt, /Never infer a person's name.*never hard-code names/s);
    assert.match(prompt, /exact background\nframe captured from the finished edited video/);
  }
});

test('chapter cards require rendered-frame fitting checks', () => {
  for (const plugin of plugins) {
    assert.match(skill(plugin, 'edit-video/SKILL.md'), /Chapter\/text-card type must fit the rendered frame/);
    assert.match(skill(plugin, 'edit-vlog/SKILL.md'), /Every accented glyph, outline and shadow must remain inside/);
  }
});
