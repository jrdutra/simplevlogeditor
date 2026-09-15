'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { MediaImportService, probeWithFfprobe } = require('./media-import-service');

const ROOT = path.resolve('C:\\Vídeos de João');
const probeDocument = {
  format: { duration: '10', format_name: 'mov,mp4', format_long_name: 'QuickTime / MOV' },
  streams: [
    { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, avg_frame_rate: '30/1' },
    { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2 }
  ]
};

function fakeFs(options = {}) {
  return {
    realpath: async (file) => {
      if (options.missing?.has(file)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return file;
    },
    stat: async () => ({ size: 512 * 1024 * 1024, mtimeMs: 1234, isFile: () => true }),
    open: async () => ({ close: async () => undefined })
  };
}

function harness(options = {}) {
  let revision = 0;
  const committed = [];
  let active = 0;
  let peak = 0;
  const service = new MediaImportService({
    // The same shape main.js passes: one admit() shared with the editor window.
    admit: (candidate) => {
      const resolved = path.resolve(candidate);
      const relative = path.relative(ROOT, resolved);
      const inside = relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
      if (!inside) throw Object.assign(new Error(`The editor has not been allowed to use this folder: ${resolved}.`), { code: 'path_not_allowed' });
      return resolved;
    },
    fs: options.fs || fakeFs(),
    probe: options.probe || (async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 3));
      active--;
      return probeDocument;
    }),
    registerMedia: (file, stat, type) => ({ filePath: file, name: path.basename(file), size: stat.size, lastModified: stat.mtimeMs, type, url: `http://media/${committed.length}` }),
    callEditor: async (request) => {
      if (request.name === 'get_project') return { apiVersion: 2, projectRevision: revision, result: {} };
      if (request.name === '__has_media_path') return { apiVersion: 2, projectRevision: revision, result: { present: false } };
      if (request.name === '__import_media_path') {
        committed.push(request.arguments.descriptor.filePath);
        revision++;
        return { apiVersion: 2, projectRevision: revision, result: { status: 'imported', clipId: `clip-${revision}`, assetId: `asset-${revision}` } };
      }
      throw new Error(request.name);
    },
    checkpoint: options.checkpoint
  });
  return { service, committed, peak: () => peak };
}

async function finished(service, jobId) {
  for (let i = 0; i < 500; i++) {
    const status = service.status(jobId);
    if (!['queued', 'running'].includes(status.state)) return status;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error('job did not finish');
}

test('reports a missing FFprobe executable with a reproducible error code', async () => {
  await assert.rejects(
    probeWithFfprobe(path.join(ROOT, 'video.mp4'), { executable: `missing-ffprobe-${process.pid}.exe` }),
    (error) => error?.code === 'ffprobe_unavailable' && /ENOENT|spawn/i.test(error.message)
  );
});

test('imports twelve 512 MB files by descriptor, in order, with bounded concurrency and idempotency', async () => {
  const { service, committed, peak } = harness();
  const paths = Array.from({ length: 12 }, (_, i) => path.join(ROOT, `Câmera ${String(i + 1).padStart(2, '0')}.mp4`));
  const first = service.queue({ paths, requestId: 'large-project', maxConcurrency: 2 });
  const replay = service.queue({ paths, requestId: 'large-project', maxConcurrency: 2 });
  assert.equal(replay.jobId, first.jobId);
  assert.equal(replay.idempotentReplay, true);
  const status = await finished(service, first.jobId);
  assert.equal(status.state, 'completed');
  assert.equal(status.total, 12);
  assert.equal(status.percent, 100);
  assert.deepEqual(committed, paths);
  assert.ok(peak() <= 2);
  assert.ok(status.files.every((file) => file.status === 'imported'));
  assert.ok(!JSON.stringify(status).includes('ArrayBuffer'));
});

test('isolates missing, unsupported and corrupt files while preserving successful commits', async () => {
  const missing = path.join(ROOT, 'não existe.mp4');
  const corrupt = path.join(ROOT, 'corrompido.mp4');
  const fsMock = fakeFs({ missing: new Set([missing]) });
  const { service, committed } = harness({
    fs: fsMock,
    probe: async (file) => {
      if (file === corrupt) throw Object.assign(new Error('invalid data'), { code: 'ffprobe_failed' });
      return probeDocument;
    }
  });
  const good = path.join(ROOT, 'válido.mp4');
  const queued = service.queue({ paths: [good, missing, path.join(ROOT, 'nota.txt'), corrupt], requestId: 'partial' });
  const status = await finished(service, queued.jobId);
  assert.equal(status.state, 'partial');
  assert.deepEqual(status.files.map((file) => file.status), ['imported', 'missing', 'unsupported', 'failed']);
  assert.deepEqual(committed, [good]);
  assert.equal(status.projectRevision, 1);
});

test('deduplicates repeated paths inside a concurrent request', async () => {
  const { service, committed } = harness();
  const duplicate = path.join(ROOT, 'mesmo vídeo.mp4');
  const queued = service.queue({ paths: [duplicate, duplicate], requestId: 'duplicates', maxConcurrency: 2 });
  const status = await finished(service, queued.jobId);
  assert.deepEqual(status.files.map((file) => file.status), ['imported', 'already_present']);
  assert.deepEqual(committed, [duplicate]);
});

test('scopes request idempotency to session, project and initial revision', async () => {
  const { service } = harness();
  const paths = [path.join(ROOT, 'escopo.mp4')];
  const first = service.queue({ paths, requestId: 'same-request' }, {
    sessionId: 'session-a', projectId: 'project-a', projectRevision: 0
  });
  const replay = service.queue({ paths, requestId: 'same-request' }, {
    sessionId: 'session-a', projectId: 'project-a', projectRevision: 0
  });
  const anotherSession = service.queue({ paths, requestId: 'same-request' }, {
    sessionId: 'session-b', projectId: 'project-a', projectRevision: 0
  });
  const anotherRevision = service.queue({ paths, requestId: 'same-request' }, {
    sessionId: 'session-a', projectId: 'project-a', projectRevision: 9
  });
  assert.equal(replay.jobId, first.jobId);
  assert.equal(replay.idempotentReplay, true);
  assert.notEqual(anotherSession.jobId, first.jobId);
  assert.notEqual(anotherRevision.jobId, first.jobId);
  assert.equal(anotherSession.idempotentReplay, false);
  assert.equal(anotherRevision.idempotentReplay, false);
});

test('checkpoints the complete project after every successful media commit', async () => {
  const checkpoints = [];
  const { service } = harness({ checkpoint: async (reason, revision) => checkpoints.push({ reason, revision }) });
  const queued = service.queue({
    paths: [path.join(ROOT, 'primeiro.mp4'), path.join(ROOT, 'segundo.mp4')],
    requestId: 'checkpoints'
  });
  const status = await finished(service, queued.jobId);
  assert.equal(status.state, 'completed');
  assert.deepEqual(checkpoints.map((item) => item.revision), [1, 2]);
  assert.match(checkpoints[0].reason, /primeiro\.mp4/);
});

test('cancels outstanding work and resumes only unfinished files', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { service } = harness({ probe: async () => { await gate; return probeDocument; } });
  const queued = service.queue({ paths: [path.join(ROOT, 'um.mp4'), path.join(ROOT, 'dois.mp4')], requestId: 'cancel' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  service.cancel(queued.jobId);
  release();
  let status = await finished(service, queued.jobId);
  assert.equal(status.state, 'cancelled');
  status = service.resume(queued.jobId);
  assert.ok(['queued', 'running'].includes(status.state));
  status = await finished(service, queued.jobId);
  assert.equal(status.state, 'completed');
});

/* --------------------------------------- a revision that moved is not a clash */

test('a drifted revision is re-read and the file goes in, rather than failing the queue', async () => {
  // The failure this pins: a queue of twelve carried the revision it read
  // before the first file. Something else moved that number three files in,
  // and the remaining nine all failed with "the project changed before this
  // media file could be committed" — none of them a real conflict.
  let revision = 21;
  const attempts = [];
  const reads = [];

  const service = new MediaImportService({
    admit: (candidate) => path.resolve(candidate),
    fs: fakeFs(),
    probe: async () => probeDocument,
    registerMedia: (file) => ({ filePath: file, name: path.basename(file), url: 'http://media/x' }),
    callEditor: async (request) => {
      if (request.name === 'get_project') {
        reads.push(revision);
        return { apiVersion: 2, projectRevision: revision, result: { clipCount: 0 } };
      }
      if (request.name === '__import_media_path') {
        attempts.push(request.arguments.expectedRevision);
        if (request.arguments.expectedRevision !== revision) {
          throw Object.assign(
            new Error('The project changed before this media file could be committed.'),
            { code: 'revision_conflict', details: { expectedRevision: request.arguments.expectedRevision, actualRevision: revision } }
          );
        }
        // Something other than this queue also moves the project along.
        revision += 2;
        return { apiVersion: 2, projectRevision: revision - 1, result: { status: 'imported', clipId: 'clip-1', assetId: 'a1' } };
      }
      return { apiVersion: 2, projectRevision: revision, result: {} };
    }
  });

  const job = await service.queue({
    requestId: 'r1', paths: [path.join(ROOT, 'a.mp4'), path.join(ROOT, 'b.mp4'), path.join(ROOT, 'c.mp4')]
  });
  for (let tries = 0; tries < 200 && service.jobs.get(job.jobId)?.state === 'running'; tries++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  const done = service.jobs.get(job.jobId);
  assert.equal(done.state, 'completed', 'every file must land');
  assert.deepEqual(done.files.map((file) => file.status), ['imported', 'imported', 'imported']);
  assert.ok(attempts.length > 3, 'a drifted file must be retried rather than abandoned');
  assert.ok(reads.length >= 1, 'the queue must re-read the revision it lost track of');
});

test('a project that really was replaced still fails, rather than retrying forever', async () => {
  let attempts = 0;
  const service = new MediaImportService({
    admit: (candidate) => path.resolve(candidate),
    fs: fakeFs(),
    probe: async () => probeDocument,
    registerMedia: (file) => ({ filePath: file, name: path.basename(file), url: 'http://media/x' }),
    callEditor: async (request) => {
      if (request.name === 'get_project') return { apiVersion: 2, projectRevision: 99, result: { clipCount: 0 } };
      if (request.name === '__import_media_path') {
        attempts++;
        throw Object.assign(new Error('The project changed before this media file could be committed.'), { code: 'revision_conflict' });
      }
      return { apiVersion: 2, projectRevision: 99, result: {} };
    }
  });

  const job = await service.queue({ requestId: 'r2', paths: [path.join(ROOT, 'a.mp4')] });
  for (let tries = 0; tries < 200 && service.jobs.get(job.jobId)?.state === 'running'; tries++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(attempts, 2, 'one refresh, one retry, then the truth');
  assert.equal(service.jobs.get(job.jobId).files[0].status, 'failed');
});
