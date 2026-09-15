'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { createLogger, safeError } = require('./structured-log');

const SUPPORTED = new Map(Object.entries({
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif'
}));
const TERMINAL = new Set(['imported', 'already_present', 'unsupported', 'missing', 'failed', 'cancelled']);

function normalized(file) {
  const value = path.normalize(path.resolve(file));
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function clampConcurrency(value) {
  const number = Number(value);
  return Number.isInteger(number) ? Math.max(1, Math.min(2, number)) : 1;
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function ratio(value) {
  if (typeof value !== 'string') return undefined;
  const [a, b] = value.split('/').map(Number);
  return Number.isFinite(a) && Number.isFinite(b) && b ? a / b : undefined;
}

function summaryFromProbe(file, stat, document) {
  const streams = Array.isArray(document.streams) ? document.streams : [];
  const video = streams.find((stream) => stream.codec_type === 'video');
  const audio = streams.find((stream) => stream.codec_type === 'audio');
  const extension = path.extname(file).toLowerCase();
  const image = SUPPORTED.get(extension)?.startsWith('image/');
  const duration = number(document.format?.duration, number(video?.duration, number(audio?.duration, image ? 5 : 0)));
  return {
    fileName: path.basename(file), fileSize: stat.size,
    containerName: document.format?.format_long_name || document.format?.format_name || extension.slice(1),
    kind: image ? 'image' : video ? 'video' : 'audio',
    durationSeconds: duration,
    hasVideoTrack: Boolean(video), hasAudioTrack: Boolean(audio),
    videoCodec: video?.codec_long_name || video?.codec_name || null,
    audioCodec: audio?.codec_long_name || audio?.codec_name || null,
    width: number(video?.width, image ? number(video?.width) : 0),
    height: number(video?.height, image ? number(video?.height) : 0),
    frameRate: ratio(video?.avg_frame_rate) ?? ratio(video?.r_frame_rate) ?? null,
    sampleRate: audio ? number(audio.sample_rate) : null,
    channelCount: audio ? number(audio.channels) : null,
    videoUsable: Boolean(video), audioUsable: Boolean(audio), warning: null,
    isTimelapse: false, timelapseReason: null
  };
}

function probeWithFfprobe(file, options = {}) {
  const executable = options.executable || process.env.SVE_FFPROBE || 'ffprobe';
  const signal = options.signal;
  const timeoutMs = options.timeoutMs || 30_000;
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [
      '-v', 'error', '-show_format', '-show_streams', '-of', 'json', file
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let finished = false;
    const finish = (error, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value);
    };
    const abort = () => {
      child.kill();
      finish(Object.assign(new Error('Media probe cancelled.'), {
        code: 'cancelled', stage: 'ffprobe', stdout, stderr
      }));
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(Object.assign(new Error(`FFprobe timed out after ${timeoutMs} ms.`), {
        code: 'ffprobe_timeout', stage: 'ffprobe', stdout, stderr
      }));
    }, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) return abort();
    child.stdout.on('data', (chunk) => {
      if (stdout.length < 2_000_000) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 64_000) stderr += chunk.toString('utf8');
    });
    child.once('error', (error) => finish(Object.assign(error, {
      code: 'ffprobe_unavailable', stage: 'ffprobe', stdout, stderr
    })));
    child.once('exit', (code) => {
      if (finished) return;
      if (code !== 0) return finish(Object.assign(new Error(stderr.trim() || `FFprobe exited with code ${code}.`), {
        code: 'ffprobe_failed', stage: 'ffprobe', exitCode: code, stdout, stderr
      }));
      try { finish(null, JSON.parse(stdout)); }
      catch { finish(Object.assign(new Error('FFprobe returned invalid JSON.'), {
        code: 'ffprobe_invalid_output', stage: 'ffprobe', stdout, stderr
      })); }
    });
  });
}

class MediaImportService {
  constructor(options) {
    this.callEditor = options.callEditor;
    this.registerMedia = options.registerMedia;
    /**
     * The one path check, shared with the editor window and with every other
     * MCP file operation. It was a second copy of the rule here, which is how a
     * folder could be reachable through one door and refused through another.
     */
    this.admit = options.admit || ((candidate) => {
      throw Object.assign(new Error(`No folder is allowed: ${candidate}`), { code: 'path_not_allowed' });
    });
    this.fs = options.fs || fs;
    this.probe = options.probe || probeWithFfprobe;
    this.logger = options.logger || createLogger('media-import');
    this.jobs = new Map();
    this.requests = new Map();
    this.activeJob = null;
    this.pumpPromise = null;
    this.stateFile = options.stateFile;
    this.checkpoint = options.checkpoint || null;
    this.lastError = null;
  }

  queue(args = {}, context = {}) {
    if (!Array.isArray(args.paths) || !args.paths.length || !args.paths.every((item) => typeof item === 'string' && path.isAbsolute(item))) {
      throw Object.assign(new Error('paths must contain one or more absolute local paths.'), { code: 'invalid_arguments' });
    }
    if (args.paths.length > 100) throw Object.assign(new Error('A media import accepts at most 100 paths.'), { code: 'invalid_arguments' });
    const scope = {
      sessionId: context.sessionId ?? null,
      projectId: context.projectId ?? null,
      projectRevision: Number.isFinite(context.projectRevision) ? context.projectRevision : null
    };
    const requestId = typeof args.requestId === 'string' && args.requestId.trim() ? args.requestId.trim() : randomUUID();
    const existingId = this.requests.get(requestId);
    if (existingId) {
      const existing = this.jobs.get(existingId);
      const sameSession = existing?.sessionId === scope.sessionId;
      const sameProject = existing?.projectId === scope.projectId;
      const sameRevision = existing?.initialProjectRevision === scope.projectRevision;
      if (existing && sameSession && sameProject && sameRevision) {
        return {
          jobId: existingId, requestId, idempotentReplay: true, state: existing.state,
          idempotencyScope: { sessionId: existing.sessionId, projectId: existing.projectId, initialProjectRevision: existing.initialProjectRevision }
        };
      }
      this.logger.warn('idempotency_scope_mismatch', {
        requestId, existingJobId: existingId,
        existingScope: existing ? { sessionId: existing.sessionId, projectId: existing.projectId, initialProjectRevision: existing.initialProjectRevision } : null,
        requestedScope: scope
      });
    }

    const now = new Date().toISOString();
    const job = {
      jobId: randomUUID(), requestId, state: 'queued', createdAt: now, updatedAt: now,
      sessionId: scope.sessionId,
      projectId: scope.projectId,
      initialProjectRevision: scope.projectRevision,
      atIndex: args.atIndex === undefined ? undefined : Math.max(0, Math.trunc(number(args.atIndex))),
      skipDuplicates: args.skipDuplicates !== false,
      maxConcurrency: clampConcurrency(args.maxConcurrency),
      expectedRevision: args.expectedRevision === undefined ? undefined : number(args.expectedRevision),
      projectRevision: args.expectedRevision === undefined ? null : number(args.expectedRevision),
      currentFile: null, importedAssetIds: [], errors: [], cancelRequested: false,
      files: args.paths.map((file, index) => ({ index, path: path.resolve(file), status: 'queued', assetId: null, clipId: null, error: null }))
    };
    this.jobs.set(job.jobId, job);
    this.requests.set(requestId, job.jobId);
    this.logger.info('job_queued', { requestId, jobId: job.jobId, total: job.files.length });
    this.#persist();
    this.#pump();
    return {
      jobId: job.jobId, requestId, idempotentReplay: false, state: job.state,
      idempotencyScope: { sessionId: job.sessionId, projectId: job.projectId, initialProjectRevision: job.initialProjectRevision }
    };
  }

  status(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) throw Object.assign(new Error(`Import job "${jobId}" was not found.`), { code: 'job_not_found' });
    const completed = job.files.filter((file) => TERMINAL.has(file.status)).length;
    return {
      ...job,
      completed, total: job.files.length,
      percent: job.files.length ? Math.round(completed * 10000 / job.files.length) / 100 : 100,
      errors: job.files.filter((file) => file.error).map((file) => ({ path: file.path, status: file.status, error: file.error }))
    };
  }

  cancel(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) throw Object.assign(new Error(`Import job "${jobId}" was not found.`), { code: 'job_not_found' });
    job.cancelRequested = true;
    job.controller?.abort();
    for (const file of job.files) if (file.status === 'queued' || file.status === 'probing') file.status = 'cancelled';
    if (job.state === 'queued') job.state = 'cancelled';
    job.updatedAt = new Date().toISOString();
    this.#persist();
    return this.status(jobId);
  }

  resume(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) throw Object.assign(new Error(`Import job "${jobId}" was not found.`), { code: 'job_not_found' });
    if (!['cancelled', 'interrupted', 'failed', 'partial'].includes(job.state)) return this.status(jobId);
    for (const file of job.files) if (file.status === 'cancelled' || file.status === 'failed') { file.status = 'queued'; file.error = null; }
    job.cancelRequested = false;
    job.state = 'queued';
    job.updatedAt = new Date().toISOString();
    this.#persist();
    this.#pump();
    return this.status(jobId);
  }

  diagnostics() {
    return {
      jobs: this.jobs.size,
      activeJob: this.activeJob,
      queuedJobs: [...this.jobs.values()].filter((job) => job.state === 'queued').length,
      lastError: this.lastError
    };
  }

  async restore() {
    if (!this.stateFile) return;
    try {
      const saved = JSON.parse(await this.fs.readFile(this.stateFile, 'utf8'));
      for (const job of saved.jobs || []) {
        if (job.state === 'running' || job.state === 'queued') job.state = 'interrupted';
        delete job.controller;
        this.jobs.set(job.jobId, job);
        // Persisted jobs remain inspectable/recoverable, but their request ids
        // deliberately do not enter this process' idempotency scope. Replaying
        // an old success into a fresh empty project was the source of a stale
        // revision 13 result being returned for revision 0.
      }
    } catch (error) {
      if (error.code !== 'ENOENT') this.logger.warn('state_restore_failed', { error });
    }
  }

  #pump() {
    if (this.pumpPromise) {
      this.pumpPromise.finally(() => {
        if ([...this.jobs.values()].some((job) => job.state === 'queued')) this.#pump();
      });
      return;
    }
    this.pumpPromise = (async () => {
      while (true) {
        const job = [...this.jobs.values()].find((candidate) => candidate.state === 'queued');
        if (!job) break;
        this.activeJob = job.jobId;
        try { await this.#run(job); }
        catch (error) {
          this.lastError = safeError(error);
          job.state = job.cancelRequested ? 'cancelled' : 'failed';
          this.logger.error('job_failed', { requestId: job.requestId, jobId: job.jobId, error });
        } finally {
          delete job.controller;
          job.currentFile = null;
          job.updatedAt = new Date().toISOString();
          this.activeJob = null;
          await this.#persist();
        }
      }
    })().finally(() => { this.pumpPromise = null; });
  }

  async #run(job) {
    job.state = 'running';
    job.controller = new AbortController();
    job.updatedAt = new Date().toISOString();
    let revision = job.projectRevision;
    if (revision === null) {
      const project = await this.callEditor({ name: 'get_project', arguments: {} });
      revision = project.projectRevision;
      job.projectRevision = revision;
    }
    const seen = new Set(job.files.filter((file) => file.status === 'imported').map((file) => normalized(file.path)));
    const requested = new Set(seen);
    const pending = [];
    for (const file of job.files.filter((candidate) => candidate.status === 'queued')) {
      const key = normalized(file.path);
      if (job.skipDuplicates && requested.has(key)) file.status = 'already_present';
      else { requested.add(key); pending.push(file); }
    }
    let inserted = job.files.filter((file) => file.status === 'imported').length;

    for (let offset = 0; offset < pending.length && !job.cancelRequested; offset += job.maxConcurrency) {
      const batch = pending.slice(offset, offset + job.maxConcurrency);
      for (const file of batch) file.status = 'probing';
      job.currentFile = batch.map((file) => file.path);
      job.updatedAt = new Date().toISOString();
      await this.#persist();
      const prepared = await Promise.all(batch.map((file) => this.#prepare(job, file, seen)));
      for (const item of prepared) {
        const file = item.file;
        if (!item.ready || job.cancelRequested) {
          if (job.cancelRequested && !TERMINAL.has(file.status)) file.status = 'cancelled';
          continue;
        }
        try {
          const descriptor = this.registerMedia(item.path, item.stat, item.mime);
          const response = await this.callEditor({
            name: '__import_media_path',
            arguments: {
              descriptor, summary: item.summary,
              atIndex: job.atIndex === undefined ? undefined : job.atIndex + inserted,
              expectedRevision: revision, skipDuplicates: job.skipDuplicates
            }
          });
          const result = response.result || {};
          file.status = result.status || 'imported';
          file.assetId = result.assetId || null;
          file.clipId = result.clipId || null;
          revision = response.projectRevision;
          job.projectRevision = revision;
          if (file.status === 'imported') {
            inserted += 1;
            if (file.assetId) job.importedAssetIds.push(file.assetId);
            seen.add(normalized(item.path));
          }
          this.logger.info('file_committed', { requestId: job.requestId, jobId: job.jobId, path: item.path, status: file.status, projectRevision: revision });
          if (file.status === 'imported' && this.checkpoint) {
            try { await this.checkpoint(`Imported ${path.basename(item.path)}`, revision); }
            catch (error) { this.logger.warn('checkpoint_failed', { path: item.path, projectRevision: revision, error }); }
          }
        } catch (error) {
          file.status = error.code === 'cancelled' ? 'cancelled' : 'failed';
          file.error = safeError(error);
          this.logger.warn('file_commit_failed', { requestId: job.requestId, jobId: job.jobId, path: item.path, error });
        }
        job.updatedAt = new Date().toISOString();
        await this.#persist();
      }
    }
    for (const file of job.files) if (!TERMINAL.has(file.status)) file.status = 'cancelled';
    const failures = job.files.filter((file) => ['failed', 'missing', 'unsupported'].includes(file.status)).length;
    const cancelled = job.files.some((file) => file.status === 'cancelled');
    job.state = cancelled ? 'cancelled' : failures ? (job.files.some((file) => file.status === 'imported') ? 'partial' : 'failed') : 'completed';
  }

  async #prepare(job, file, seen) {
    const started = Date.now();
    try {
      const requested = this.admit(file.path);
      const extension = path.extname(requested).toLowerCase();
      const mime = SUPPORTED.get(extension);
      if (!mime) { file.status = 'unsupported'; return { file, ready: false }; }
      let real;
      try { real = await this.fs.realpath(requested); }
      catch (error) {
        if (error.code === 'ENOENT') { file.status = 'missing'; file.error = safeError(error); return { file, ready: false }; }
        throw error;
      }
      // Checked again after realpath: a symlink must not lead out of the roots.
      this.admit(real);
      const stat = await this.fs.stat(real);
      if (!stat.isFile()) throw Object.assign(new Error(`Not a file: ${real}`), { code: 'not_a_file' });
      const handle = await this.fs.open(real, 'r');
      await handle.close();
      const key = normalized(real);
      if (job.skipDuplicates && seen.has(key)) { file.status = 'already_present'; return { file, ready: false }; }
      if (job.skipDuplicates) {
        const existing = await this.callEditor({ name: '__has_media_path', arguments: { path: real, size: stat.size, lastModified: stat.mtimeMs } });
        if (existing.result?.present) { file.status = 'already_present'; return { file, ready: false }; }
      }
      const document = await this.probe(real, { signal: job.controller.signal });
      file.path = real;
      return { file, ready: true, path: real, stat, mime, summary: summaryFromProbe(real, stat, document) };
    } catch (error) {
      file.status = error.code === 'cancelled' || job.cancelRequested ? 'cancelled' : error.code === 'ENOENT' ? 'missing' : 'failed';
      file.error = safeError(error);
      this.logger.warn('file_probe_failed', { requestId: job.requestId, jobId: job.jobId, path: file.path, durationMs: Date.now() - started, error });
      return { file, ready: false };
    }
  }

  async #persist() {
    if (!this.stateFile) return;
    try {
      await this.fs.mkdir(path.dirname(this.stateFile), { recursive: true });
      const jobs = [...this.jobs.values()].map(({ controller, ...job }) => job);
      const temp = `${this.stateFile}.${process.pid}.tmp`;
      await this.fs.writeFile(temp, JSON.stringify({ version: 1, jobs }), 'utf8');
      await this.fs.rename(temp, this.stateFile);
    } catch (error) {
      this.logger.warn('state_persist_failed', { error });
    }
  }
}

module.exports = { MediaImportService, probeWithFfprobe, summaryFromProbe, normalized, SUPPORTED };
