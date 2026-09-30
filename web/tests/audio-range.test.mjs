import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../src/app/ferramentas/editor-de-video/audio-range-meter.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
const { SourceAudioMeter } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));

function add(meter, timestamp, values, channels = 1, rate = 1000) {
  meter.add({ timestamp, sampleRate: rate, numberOfChannels: channels, numberOfFrames: values.length / channels }, Float32Array.from(values));
}

test('200ms bins measure every source sample with correct RMS and transient peak', () => {
  const meter = new SourceAudioMeter(3, 3.8, .2);
  const values = Array(1000).fill(.5);
  values[300] = 1; // Short impact inside a bin must survive the RMS measurement.
  add(meter, 2.9, values);
  const result = meter.result();
  assert.equal(result.buckets.length, 4);
  assert.equal(result.summary.sampleCount, 800);
  assert.equal(result.buckets[1].peak, 1);
  assert.ok(Math.abs(result.buckets[0].rms - .5) < 1e-8);
  assert.ok(Math.abs(result.buckets[0].rmsDbfs + 6.020599913) < 1e-6);
  assert.ok(result.buckets.every(bin => Math.abs(bin.coverage - 1) < 1e-10));
});

test('opposite-phase stereo retains both channel energy and the original preview channels', () => {
  const meter = new SourceAudioMeter(0, .4, .2, true);
  add(meter, 0, Array.from({ length: 400 }, () => [.5, -.5]).flat(), 2);
  const result = meter.result();
  assert.equal(result.summary.rms, .5);
  assert.deepEqual(result.buckets[0].channels.map(channel => channel.rms), [.5, .5]);
  const wav = meter.wav();
  const view = new DataView(wav.buffer);
  assert.equal(Buffer.from(wav.subarray(0, 4)).toString(), 'RIFF');
  assert.equal(view.getUint16(22, true), 2);
  assert.equal(view.getUint32(24, true), 1000);
  assert.equal(view.getUint32(40, true), 1600);
  assert.equal(view.getInt16(44, true), 16384);
  assert.equal(view.getInt16(46, true), -16384);
});

test('exact source boundaries clip preceding packets and do not duplicate overlap', () => {
  const meter = new SourceAudioMeter(10, 10.45, .2, true);
  add(meter, 9.9, Array(350).fill(.25));
  add(meter, 10.2, Array(350).fill(.25));
  const { buckets, summary } = meter.result();
  assert.equal(summary.sampleCount, 450);
  assert.deepEqual(buckets.map(bucket => bucket.sampleCount), [200, 200, 50]);
  assert.equal(meter.wav().length, 44 + 450 * 2);
  assert.equal(buckets.at(-1).end, 10.45);
});

test('missing PCM differs from measured digital silence and remains unknown', () => {
  const meter = new SourceAudioMeter(0, .8, .2);
  add(meter, 0, Array(200).fill(0));
  add(meter, .6, Array(200).fill(.5));
  const { buckets } = meter.result();
  assert.equal(buckets[0].rms, 0);
  assert.equal(buckets[0].rmsDbfs, null);
  assert.equal(buckets[0].coverage, 1);
  assert.equal(buckets[1].rms, null);
  assert.equal(buckets[1].coverage, 0);
  assert.equal(buckets[2].sampleCount, 0);
  assert.equal(buckets[3].rms, .5);
  assert.equal(meter.wav(), null);
});

test('invalid/oversized windows and inconsistent or non-finite PCM fail explicitly', () => {
  for (const args of [[-1, 1, .2], [2, 1, .2], [0, 121, .2], [0, 1, .01], [0, 1, NaN], [0, 13, .2, true]]) {
    assert.throws(() => new SourceAudioMeter(...args));
  }
  const meter = new SourceAudioMeter(0, 1, .2);
  add(meter, 0, [0]);
  assert.throws(() => add(meter, .2, [NaN]));
  assert.throws(() => add(meter, .2, [0, 0], 2));
});
