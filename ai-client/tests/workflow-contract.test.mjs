import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from '../../web/node_modules/js-yaml/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const plugins = ['simplevlogeditor-claude-plugin', 'simplevlogeditor-codex-plugin'];

test('every identified topic heading requires a standalone card before its video span', () => {
  for (const plugin of plugins) {
    const defaults = skill(plugin, 'edit-video/references/editorial-defaults.md');
    assert.match(defaults, /Every identified section\/topic subtitle must become a standalone text container/);
    assert.match(defaults, /before the first retained video span discussing that subject/);
    assert.match(defaults, /split at the verified source-time/);
    assert.match(defaults, /Reuse or update\s+an existing matching card instead of duplicating it/);
    assert.match(defaults, /automaticTextCardBoundaries/);
    assert.match(defaults, /Previous playable video:.*fadeOutAudio: true/);
    assert.match(defaults, /Text card:.*fadeInAudio: true.*fadeOutAudio: true/);
    assert.match(defaults, /Next playable video:.*fadeInAudio: true/);
    for (const relative of ['edit-video/SKILL.md', 'edit-vlog/SKILL.md', 'edit-vlog/references/default-brief.md', 'edit-vlog/references/editorial-blocks.md']) {
      assert.match(skill(plugin, relative), /Every identified section\/topic subtitle must/);
    }
    assert.doesNotMatch(skill(plugin, 'edit-vlog/references/default-brief.md'), /Prefer a short Background Caption or title over the footage/);
  }
});

test('both clients require generative visual evidence before enabling a video container', () => {
  for (const plugin of plugins) {
    const defaults = skill(plugin, 'edit-video/references/editorial-defaults.md');
    assert.match(defaults, /off by default/);
    assert.match(defaults, /generative AI must inspect raw source frames/);
    assert.match(defaults, /car with its license plate exposed/);
    assert.match(defaults, /"type": "set_license_plate_blur", "clipId": "<observed-video-id>", "enabled": true/);
    assert.doesNotMatch(defaults, /project\.licensePlateBlur|"type": "set_project_settings"/);
    assert.match(defaults, /leave blur off/);
    assert.match(defaults, /Never enable it across all videos/);
    assert.match(defaults, /After splits or trims, reassess/);
    assert.match(defaults, /composited: true/);
    assert.match(defaults, /licensePlateBlurApplied: true/);
    assert.match(defaults, /plate_detection_failed/);
    assert.match(defaults, /never disable an enabled container/);
    for (const relative of ['edit-video/SKILL.md', 'edit-vlog/SKILL.md', 'edit-vlog/references/default-brief.md']) {
      assert.match(skill(plugin, relative), /generative visual inspection/);
    }
  }
});

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
    'edit-video/references/editorial-defaults.md',
    'edit-vlog/references/default-brief.md',
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

test('both clients apply the requested editorial defaults with verifiable editor operations', () => {
  for (const plugin of plugins) {
    const defaults = skill(plugin, 'edit-video/references/editorial-defaults.md');
    const edit = skill(plugin, 'edit-video/SKILL.md');
    const vlog = skill(plugin, 'edit-vlog/SKILL.md');
    const brief = skill(plugin, 'edit-vlog/references/default-brief.md');
    for (const source of [edit, vlog, brief]) assert.match(source, /editorial-defaults\.md/);
    assert.match(defaults, /first video[\s\S]*timelapse[\s\S]*fadeOut: true[\s\S]*fadeIn: true/);
    assert.match(defaults, /positionX: 0\.3[\s\S]*positionY: 0\.24/);
    assert.match(defaults, /originally centered/);
    assert.match(defaults, /Do not reset an existing placement the user customized/);
    assert.match(defaults, /no speech[\s\S]*project's default music/);
    assert.match(defaults, /set_audio_mode[\s\S]*mode: "replace"/);
    assert.match(defaults, /failed transcript[\s\S]*not proof of no speech/);
    assert.match(defaults, /Previous playable video:.*fadeOut: true/);
    assert.match(defaults, /Text card:.*fadeIn: true.*fadeOut: true/);
    assert.match(defaults, /Next playable video:.*fadeIn: true/);
    assert.match(defaults, /fadeAudioWithVideo: true/);
    assert.match(defaults, /plannedFades\.audio/);
    assert.match(defaults, /resolvedSound\.projectDefault: true/);
    assert.match(defaults, /editor lacks it[\s\S]*required editor update/);
    const example = skill(plugin, 'edit-video/references/mcp-operations.md');
    assert.doesNotMatch(example, /still upper-center background preset/);
    assert.match(example, /"positionX": 0\.3,[\s\S]*"positionY": 0\.24/);
  }
});

test('continuous project music gets picture-only fades without losing text-card sound fades', () => {
  for (const plugin of plugins) {
    const defaults = skill(plugin, 'edit-video/references/editorial-defaults.md');
    assert.match(defaults, /Outgoing video: `fadeOut: true`, `fadeOutAudio: false`/);
    assert.match(defaults, /Incoming video: `fadeIn: true`, `fadeInAudio: false`/);
    assert.match(defaults, /resolvedSound\.projectDefault: true/);
    assert.match(defaults, /Do not infer continuity from file\s+names alone/);
    assert.match(defaults, /plus its output duration/);
    assert.match(defaults, /fadeInAudio: true[\s\S]*fadeOutAudio: false/);
    assert.match(defaults, /neither[\s\S]*plannedFades\.audio[\s\S]*plannedFades\.soundtrack/);
    assert.match(defaults, /Text card:.*fadeInAudio: true.*fadeOutAudio: true/);
    assert.match(defaults, /precedence over the opening timelapse/);
    for (const relative of ['edit-video/SKILL.md', 'edit-vlog/SKILL.md', 'edit-vlog/references/default-brief.md']) {
      assert.match(skill(plugin, relative), /fadeOutAudio: false/);
    }
  }
});
