import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const base = new URL('../src/app/ferramentas/', import.meta.url);
const compile = source => 'data:text/javascript;base64,' + Buffer.from(ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 }
}).outputText).toString('base64');
const analysis = await import(compile(fs.readFileSync(new URL('editor-de-video/editorial-analysis.ts', base), 'utf8')));
const colour = await import(compile(fs.readFileSync(new URL('video-packaging/packaging-colour.ts', base), 'utf8')));

test('a single long take is fully covered by sentence-aware blocks no longer than five minutes', () => {
  const words = Array.from({ length: 690 }, (_, i) => ({ start: i, end: i + .8, text: i === 269 ? 'Assunto encerrado.' : `palavra${i}` }));
  const blocks = analysis.analysisBlocks(words, { start: 0, end: 690 });
  assert.equal(blocks[0].boundary, 'sentence');
  assert.equal(blocks[0].end, 269.9);
  assert.equal(blocks[0].start, 0);
  assert.equal(blocks.at(-1).end, 690);
  for (let i = 0; i < blocks.length; i++) {
    assert.ok(blocks[i].end - blocks[i].start <= 300);
    if (i) assert.equal(blocks[i].start, blocks[i - 1].end);
    assert.ok(!words.some(word => word.start < blocks[i].end && word.end > blocks[i].end));
  }
  assert.equal(blocks.map(block => block.text).join(' '), words.map(word => word.text).join(' '));
});

test('no speech, trimmed takes and exactly five minutes still receive complete coverage', () => {
  assert.deepEqual(analysis.analysisBlocks([], { start: 150, end: 851 }).map(({ start, end }) => [start, end]),
    [[150, 450], [450, 750], [750, 851]]);
  assert.equal(analysis.analysisBlocks([], { start: 20, end: 320 }).length, 1);
  const justLonger = analysis.analysisBlocks([], { start: 0, end: 300.1 });
  assert.ok(justLonger.every(block => block.end - block.start >= .2 && block.end - block.start <= 300));
  assert.deepEqual(analysis.analysisBlocks([], { start: 20, end: 10 }), []);
});

test('a word crossing five minutes moves the boundary before the word', () => {
  const blocks = analysis.analysisBlocks([{ start: 298, end: 302, text: 'continuando' }], { start: 0, end: 620 });
  assert.equal(blocks[0].end, 298);
  assert.equal(blocks[1].text, 'continuando');
});

test('silence decisions stay inside a split and preserve detector indices', () => {
  const ranges = [{ start: 1, end: 4, enabled: true }, { start: 8, end: 12, enabled: true }, { start: 15, end: 19, enabled: false }];
  const scoped = analysis.silenceInBounds(ranges, { start: 10, end: 17 });
  assert.deepEqual(scoped.map(({ start, end, rangeIndex }) => [start, end, rangeIndex]), [[10, 12, 1], [15, 17, 2]]);
  assert.equal(analysis.silenceSummary(scoped.filter(range => range.enabled)).totalSeconds, 2);
  assert.equal(analysis.appliedSilenceSeconds(scoped, [{ start: 11, end: 12 }, { start: 17, end: 20 }]), 1);
  assert.equal(analysis.appliedSilenceSeconds(scoped, [{ start: 10, end: 20 }]), 0);
  assert.deepEqual(analysis.silenceSummary([]), { count: 0, totalSeconds: 0, minSeconds: 0, maxSeconds: 0, meanSeconds: 0 });
});

test('colour correction lifts a dark background without moving pixels or changing alpha', () => {
  const pixels = new Uint8ClampedArray([40, 40, 40, 255, 0, 0, 0, 255, 255, 255, 255, 120, 60, 40, 20, 0]);
  const before = new Uint8ClampedArray(pixels);
  const corrected = colour.correctPackagingPixels(pixels);
  assert.deepEqual(pixels, before);
  assert.ok(corrected.pixels[0] > 40);
  assert.equal(corrected.pixels[0], corrected.pixels[1]);
  assert.deepEqual([...corrected.pixels.slice(4, 7)], [0, 0, 0]);
  assert.deepEqual([...corrected.pixels.slice(8, 11)], [255, 255, 255]);
  for (let i = 3; i < pixels.length; i += 4) assert.equal(corrected.pixels[i], pixels[i]);
  assert.deepEqual(corrected.pixels.slice(12), pixels.slice(12));
  assert.deepEqual(corrected.pixels, colour.correctPackagingPixels(pixels).pixels);
});

test('uniform images stay uniform, neutral settings preserve pixels and invalid correction is refused', () => {
  const pixels = new Uint8ClampedArray(Array.from({ length: 20 }, () => [80, 90, 100, 255]).flat());
  const corrected = colour.correctPackagingPixels(pixels).pixels;
  for (let i = 4; i < corrected.length; i += 4) assert.deepEqual(corrected.slice(i, i + 4), corrected.slice(0, 4));
  assert.deepEqual(colour.correctPackagingPixels(pixels, { exposureStops: 0, contrast: 1, saturation: 1 }).pixels, pixels);
  assert.throws(() => colour.correctPackagingPixels(pixels, { exposureStops: NaN }));
  assert.throws(() => colour.correctPackagingPixels(pixels, { contrast: 3 }));
});

// Execute actual editor methods with a fake decoder/recognizer; no live project is touched.
const source = fs.readFileSync(new URL('editor-de-video/editor-de-video.component.ts', base), 'utf8');
const ast = ts.createSourceFile('editor.ts', source, ts.ScriptTarget.Latest, true);
const editor = ast.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === 'EditorDeVideoComponent');
const methods = ['wordsFor', 'cachedSourceTranscript', 'agentTextDraft', 'agentAnalysisBlocks'].map(name => {
  const method = editor.members.find(member => member.name?.getText(ast) === name);
  assert.ok(method, name);
  return method.getText(ast);
}).join('\n');
const module = await import(compile(`export function build(deps) {
  const { readSpeechAudio, transcribe, spokenSpan, TranscriptionCanceled, SPEECH_RATE, readingSeconds,
    finiteNumber, EditorAgentError, FONTS, ANIMATIONS, LEGIBILITY_OPTIONS, TEXT_LIMITS, WEIGHTS,
    clipBounds, analysisBlocks, silenceInBounds } = deps;
  return class { ${methods} };
}`));

function fixture() {
  const calls = [];
  const Fixture = module.build({ ...analysis,
    readSpeechAudio: async file => new Float32Array(file.duration * 10), SPEECH_RATE: 10,
    transcribe: async audio => { calls.push(audio.length); return [{ start: 0, end: .5, text: 'ouvido' }]; },
    spokenSpan: (entry, rate, length) => ({ from: entry.keepRanges[0].start * rate, to: Math.min(length, entry.keepRanges.at(-1).end * rate) }),
    readingSeconds: () => 6, finiteNumber: value => value, EditorAgentError: Error,
    FONTS: [], ANIMATIONS: [], LEGIBILITY_OPTIONS: [], TEXT_LIMITS: {}, WEIGHTS: [],
    clipBounds: clip => ({ start: clip.inPoint ?? 0, end: clip.outPoint ?? clip.summary.durationSeconds })
  });
  const subject = new Fixture();
  Object.assign(subject, { transcriptModelId: 'small', transcriptLanguage: 'pt', transcriptDenoise: false,
    transcriptStrength: { attenuationDb: 20 },
    heardByClip: new Map(), agentAssetId: clip => clip.file.name, zone: { run: fn => fn() }, reportTranscript: () => {} });
  return { subject, calls };
}

test('transcribing a trimmed span cannot poison the later full-source transcript', async () => {
  const { subject, calls } = fixture();
  const clip = { id: 'a', file: { name: 'one', duration: 900 }, summary: { durationSeconds: 900 } };
  const signal = new AbortController().signal;
  await subject.wordsFor(clip, { keepRanges: [{ start: 200, end: 220 }] }, signal);
  const full = await subject.wordsFor(clip, { keepRanges: [{ start: 0, end: 900 }] }, signal);
  assert.deepEqual(calls, [200, 9000]);
  assert.equal(full[0].start, 0);
  await subject.wordsFor(clip, { keepRanges: [{ start: 0, end: 900 }] }, signal);
  assert.equal(calls.length, 2, 'same scope reuses the completed transcript');
  await subject.wordsFor({ ...clip, file: { name: 'another', duration: 900 } }, { keepRanges: [{ start: 0, end: 900 }] }, signal);
  assert.equal(calls.length, 3, 'a reused clip id cannot reuse another asset\'s speech');
});

test('a brief explicit card total reserves readable hold instead of spending it all on reveal', () => {
  const { subject } = fixture();
  const current = { text: 'Mudança de assunto', revealSeconds: 7.5, holdSeconds: 6, holdAuto: true };
  const short = subject.agentTextDraft(current, undefined, undefined, 4);
  assert.equal(short.revealSeconds, 0);
  assert.equal(short.holdSeconds, 4);
  assert.equal(short.holdAuto, false);
  const normal = subject.agentTextDraft(current, undefined, undefined, 8);
  assert.equal(normal.revealSeconds, 2);
  assert.equal(normal.holdSeconds, 6);
  assert.equal(normal.revealSeconds + normal.holdSeconds, 8);
});

test('block reads reject a partial transcript that does not cover the current clip', () => {
  const { subject } = fixture();
  const clip = { id: 'a', file: { name: 'one' }, summary: { durationSeconds: 900, audioUsable: true }, detected: [] };
  subject.agentMediaClip = () => clip;
  subject.heardByClip.set('a|one||small|pt|raw|200|220', [{ start: 201, end: 202, text: 'parcial' }]);
  assert.throws(() => subject.agentAnalysisBlocks({ clipId: 'a' }), /Transcribe/);
  subject.heardByClip.set('a|one||small|pt|raw|0|900', [{ start: 10, end: 11, text: 'completo' }]);
  assert.equal(subject.agentAnalysisBlocks({ clipId: 'a', blockIndex: 0 }).block.text, 'completo');
  assert.throws(() => subject.agentAnalysisBlocks({ clipId: 'a', blockIndex: 99 }), /not found/);
});
