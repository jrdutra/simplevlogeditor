'use strict';

const { createHash } = require('node:crypto');

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function fingerprint(value) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

class IdempotencyLedger {
  constructor(options = {}) {
    this.limit = options.limit || 500;
    this.entries = new Map();
  }

  async run(scope, requestId, payload, operation) {
    const id = String(requestId || '').trim();
    if (!id) {
      throw Object.assign(new Error('A unique requestId is required for every mutating MCP command.'), {
        code: 'request_id_required',
        details: { retryable: true }
      });
    }
    if (id.length > 200) {
      throw Object.assign(new Error('requestId must not exceed 200 characters.'), { code: 'invalid_arguments' });
    }

    const key = `${scope}\0${id}`;
    const hash = fingerprint(payload);
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.fingerprint !== hash) {
        throw Object.assign(new Error(`requestId "${id}" was already used for a different mutation.`), {
          code: 'idempotency_conflict',
          details: { requestId: id }
        });
      }
      return existing.promise;
    }

    const promise = Promise.resolve().then(operation);
    this.entries.set(key, { fingerprint: hash, promise });
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value);

    try {
      return await promise;
    } catch (error) {
      // A failed attempt did not establish an outcome and may be retried safely.
      if (this.entries.get(key)?.promise === promise) this.entries.delete(key);
      throw error;
    }
  }

  get size() {
    return this.entries.size;
  }
}

module.exports = { IdempotencyLedger, canonical, fingerprint };
