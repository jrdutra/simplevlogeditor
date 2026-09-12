'use strict';

const readline = require('node:readline');

const editOperation = (type, properties = {}, required = []) => ({
  type: 'object',
  properties: { type: { const: type }, ...properties },
  required: ['type', ...required],
  additionalProperties: false
});

const EDIT_OPERATIONS = [
  editOperation('remove_clip', { clipId: { type: 'string' } }, ['clipId']),
  editOperation('move_clip', { clipId: { type: 'string' }, toIndex: { type: 'number' } }, ['clipId', 'toIndex']),
  editOperation('duplicate_clip', { clipId: { type: 'string' } }, ['clipId']),
  editOperation('add_text_clip', {
    atIndex: { type: 'number' }, text: { type: 'string' }, durationSeconds: { type: 'number' },
    draft: { type: 'object', description: 'Text style: fontId, fontScale, fontWeight, colors, alignment, animation and timing.', additionalProperties: true }
  }, ['text']),
  editOperation('update_text_clip', {
    clipId: { type: 'string' }, text: { type: 'string' }, durationSeconds: { type: 'number' },
    draft: { type: 'object', additionalProperties: true }
  }, ['clipId']),
  editOperation('set_text_background', { clipId: { type: 'string' }, path: { type: ['string', 'null'] } }, ['clipId', 'path']),
  editOperation('add_transition', {
    atIndex: { type: 'number' }, settings: { type: 'object', description: 'kind, seconds and colour.', additionalProperties: true }
  }, ['atIndex']),
  editOperation('update_transition', {
    clipId: { type: 'string' }, settings: { type: 'object', additionalProperties: true }
  }, ['clipId', 'settings']),
  editOperation('split_clip', { clipId: { type: 'string' }, sourceTime: { type: 'number' } }, ['clipId', 'sourceTime']),
  editOperation('trim_clip', { clipId: { type: 'string' }, inPoint: { type: 'number' }, outPoint: { type: 'number' } }, ['clipId']),
  editOperation('clear_trim', { clipId: { type: 'string' } }, ['clipId']),
  editOperation('set_image_duration', {
    clipId: { type: 'string' }, durationSeconds: { type: 'number', minimum: 0.1, maximum: 3600 }
  }, ['clipId', 'durationSeconds']),
  editOperation('delete_source_range', {
    clipId: { type: 'string' }, start: { type: 'number' }, end: { type: 'number' }, reason: { type: 'string' }
  }, ['clipId', 'start', 'end']),
  editOperation('restore_source_ranges', { clipId: { type: 'string' } }, ['clipId']),
  editOperation('set_detected_range', {
    clipId: { type: 'string' }, rangeIndex: { type: 'number', minimum: 0 }, enabled: { type: 'boolean' }
  }, ['clipId', 'rangeIndex', 'enabled']),
  editOperation('set_speed', { clipId: { type: 'string' }, speed: { type: 'number' } }, ['clipId', 'speed']),
  editOperation('set_volume', { clipId: { type: 'string' }, volumePercent: { type: 'number' } }, ['clipId', 'volumePercent']),
  editOperation('set_audio_mode', {
    clipId: { type: 'string' }, mode: { enum: ['original', 'replace', 'continue', 'mute'] }
  }, ['clipId', 'mode']),
  editOperation('set_clip_edits', {
    clipId: { type: 'string' },
    edits: { type: 'object', description: 'cutSilence, fades, speed, volumePercent, audioMode and nested silence/autoZoom settings.', additionalProperties: true }
  }, ['clipId', 'edits']),
  editOperation('clear_clip_overrides', { clipId: { type: 'string' } }, ['clipId']),
  editOperation('attach_audio', {
    clipId: { type: 'string', description: 'Omit for the project default soundtrack. Set only when the user explicitly requests music/audio for a specific clip or section.' },
    path: { type: 'string', description: 'Absolute local path. A generic music request always becomes the project default soundtrack.' },
    skipLeadingSilence: { type: 'boolean' }
  }, ['path']),
  editOperation('detach_audio', { clipId: { type: 'string', description: 'Omit for the project default soundtrack.' } }),
  editOperation('add_caption', {
    clipId: { type: 'string' }, start: { type: 'number' }, text: { type: 'string' }, duration: { type: 'number' }
  }, ['clipId', 'start', 'text']),
  editOperation('update_caption', {
    clipId: { type: 'string' }, captionId: { type: 'string' }, caption: { type: 'object', additionalProperties: true }
  }, ['clipId', 'captionId', 'caption']),
  editOperation('remove_caption', { clipId: { type: 'string' }, captionId: { type: 'string' } }, ['clipId', 'captionId']),
  editOperation('set_tag', {
    clipId: { type: 'string' },
    tag: {
      type: 'object',
      description: 'Partial tag. Use shape social-subscribe for a subscribe badge; QR shapes require qrText with the URL.',
      additionalProperties: true
    }
  }, ['clipId', 'tag']),
  editOperation('remove_tag', { clipId: { type: 'string' } }, ['clipId']),
  editOperation('add_zoom', {
    clipId: { type: 'string' }, start: { type: 'number' }, end: { type: 'number' },
    scalePercent: { type: 'number' }, rampSeconds: { type: 'number' }, easeOut: { type: 'boolean' }
  }, ['clipId', 'start', 'end']),
  editOperation('add_push_in', {
    clipId: { type: 'string' },
    start: { type: 'number', description: 'Push-in start in original source seconds.' },
    end: { type: 'number', description: 'Push-in end in original source seconds.' },
    scalePercent: { type: 'number', minimum: 2, maximum: 80, description: 'How much closer the picture becomes; 15 means 1.15x.' },
    rampSeconds: { type: 'number', minimum: 0, maximum: 5, description: 'Smooth ramp duration at the beginning and, when enabled, the end.' },
    easeOut: { type: 'boolean', description: 'True eases back to 1x before end; false holds the close framing through the interval.' }
  }, ['clipId', 'start', 'end']),
  editOperation('update_zoom', {
    clipId: { type: 'string' }, zoomId: { type: 'string' }, zoom: { type: 'object', additionalProperties: true }
  }, ['clipId', 'zoomId', 'zoom']),
  editOperation('update_push_in', {
    clipId: { type: 'string' }, pushInId: { type: 'string' },
    pushIn: { type: 'object', description: 'Any of start, end, scalePercent, rampSeconds or easeOut.', additionalProperties: true }
  }, ['clipId', 'pushInId', 'pushIn']),
  editOperation('remove_zoom', { clipId: { type: 'string' }, zoomId: { type: 'string' } }, ['clipId', 'zoomId']),
  editOperation('remove_push_in', { clipId: { type: 'string' }, pushInId: { type: 'string' } }, ['clipId', 'pushInId']),
  editOperation('set_project_settings', {
    settings: {
      type: 'object',
      description: 'Aspect, reframe, resolution, formats, loudness, soundtrack fades, default transition/tag and default clip edits.',
      additionalProperties: true
    }
  }, ['settings'])
];

const TOOLS = [
  tool('get_editor_capabilities', 'Discover every MCP editing operation and the current catalogues of tags, transitions, text styles and output formats.', {}),
  tool('get_project', 'Read the complete versioned editor project.', {}),
  tool('list_assets', 'List every unique media asset and the clips that use it.', {}),
  tool('get_timeline', 'Read clips, source/output timing, cuts, captions and audio state.', {}),
  tool('add_media', 'Compatibility entry point for path-only asynchronous media import. Returns a jobId immediately; poll get_import_status.', {
    paths: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 100 },
    atIndex: { type: 'number' }, skipDuplicates: { type: 'boolean' }, maxConcurrency: { type: 'integer', minimum: 1, maximum: 2 },
    requestId: { type: 'string' }, expectedRevision: { type: 'number' }
  }, ['paths']),
  tool('queue_media_import', 'Queue local media paths for bounded, incremental import and return a jobId immediately.', {
    paths: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 100 },
    atIndex: { type: 'number' }, skipDuplicates: { type: 'boolean' }, maxConcurrency: { type: 'integer', minimum: 1, maximum: 2 },
    requestId: { type: 'string' }, expectedRevision: { type: 'number' }
  }, ['paths']),
  tool('get_import_status', 'Read structured progress and per-file results for a queued media import.', {
    jobId: { type: 'string' }
  }, ['jobId']),
  tool('cancel_import', 'Cancel queued/probing files without removing assets already committed.', {
    jobId: { type: 'string' }
  }, ['jobId']),
  tool('resume_import', 'Resume the cancelled or interrupted portion of an import job.', {
    jobId: { type: 'string' }
  }, ['jobId']),
  tool('health_check', 'Check the editor connection without mutating the project.', {}),
  tool('get_operation_status', 'Read structured progress and the terminal result of a long-running editor operation on the priority control channel.', {
    operationId: { type: 'string' }
  }, ['operationId']),
  tool('cancel_operation', 'Cooperatively cancel a long-running editor operation and verify that cancellation was requested.', {
    operationId: { type: 'string' }
  }, ['operationId']),
  tool('get_diagnostics', 'Return protocol, process, connection, import queue and memory diagnostics.', {}),
  tool('get_recovery_state', 'Inspect the automatic project checkpoint used to resume editing after a restart.', {}),
  tool('checkpoint_project', 'Immediately save the complete project to its automatic recovery JSON file.', {}),
  tool('set_project_soundtrack', 'Explicitly set the project-wide soundtrack used by silent/timelapse clips. Prefer this over clip audio unless the user names a specific section.', {
    path: { type: 'string' }, skipLeadingSilence: { type: 'boolean' }, expectedRevision: { type: 'number' }, requestId: { type: 'string' }
  }, ['path']),
  tool('close_editor', 'Save a recovery checkpoint and close the visible Electron editor process.', {}),
  tool('restart_editor', 'Save, restart, reopen and focus the visible Electron editor, restoring its recovery checkpoint when needed.', {}),
  tool('finish_editing', 'Mark the AI edit complete and show the user a modal offering preview or immediate video rendering.', {
    summary: { type: 'string' }, requestId: { type: 'string' }
  }),
  tool('open_project', 'Open a saved editor project or settings document from an allowed path.', {
    path: { type: 'string' }, expectedRevision: { type: 'number' }
  }, ['path']),
  tool('save_project', 'Save the current edit or only its settings to an allowed JSON path.', {
    path: { type: 'string' }, kind: { enum: ['project', 'settings'] }, name: { type: 'string' }
  }, ['path']),
  tool('preview', 'Open, play, pause, seek or close the on-screen timeline preview.', {
    action: { enum: ['open', 'play', 'pause', 'seek', 'close'] }, time: { type: 'number', minimum: 0 }
  }, ['action']),
  tool('analyze_silence', 'Detect speech pauses and return waveform data for one clip or the whole timeline.', {
    clipId: { type: 'string' }, includeWaveform: { type: 'boolean' },
    waveformOffset: { type: 'integer', minimum: 0 }, waveformLimit: { type: 'integer', minimum: 1, maximum: 1000 },
    requestId: { type: 'string' }, timeoutMs: { type: 'integer', minimum: 1000, maximum: 3600000 }
  }),
  tool('get_waveform_page', 'Read one bounded page of waveform buckets after silence analysis.', {
    clipId: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 1000 }
  }, ['clipId']),
  tool('transcribe', 'Transcribe the complete source of a clip with word and phrase timestamps.', {
    clipId: { type: 'string' },
    model: { type: 'string', description: 'Canonical model id or alias: tiny, base, small/quality (default), turbo/large.' },
    language: { type: 'string', description: 'Whisper language name, ISO alias such as pt/pt-BR/en, or auto. Omit/auto for spoken-language detection.' },
    denoise: { type: 'boolean' }, noiseEngine: { enum: ['gtcrn', 'rnnoise'], description: 'Defaults to gtcrn (Voice model).' },
    noiseStrength: { enum: ['gentle', 'balanced', 'maximum'] }, requestId: { type: 'string' },
    timeoutMs: { type: 'integer', minimum: 1000, maximum: 3600000, description: 'Whole-operation timeout.' },
    stageTimeoutMs: { type: 'integer', minimum: 1000, maximum: 3600000, description: 'Watchdog reset whenever decode, denoise, model-load or recognition advances to a new stage.' }
  }, ['clipId']),
  tool('get_frames', 'Extract source frames at exact timestamps for visual understanding.', {
    clipId: { type: 'string' }, timestamps: { type: 'array', items: { type: 'number' }, minItems: 1, maxItems: 64 },
    width: { type: 'number', minimum: 96, maximum: 1280 }, quality: { type: 'number', minimum: 0.25, maximum: 0.95 }
  }, ['clipId', 'timestamps']),
  tool('get_contact_sheet', 'Sample a source interval uniformly for broad visual coverage.', {
    clipId: { type: 'string' }, start: { type: 'number' }, end: { type: 'number' }, interval: { type: 'number', minimum: 0.25 }, width: { type: 'number' }
  }, ['clipId']),
  tool('apply_edit_batch', 'Atomically simulate or apply up to 500 edits, including timed dynamic push-ins for emphasis.', {
    expectedRevision: { type: 'number' }, label: { type: 'string' }, dryRun: { type: 'boolean' }, requestId: { type: 'string' },
    operations: { type: 'array', minItems: 1, maxItems: 500, items: { oneOf: EDIT_OPERATIONS } }
  }, ['operations']),
  tool('undo', 'Undo the last user or agent edit group.', {}),
  tool('redo', 'Redo the last undone edit group.', {}),
  tool('export', 'Render the current timeline directly to an allowed local path.', {
    kind: { type: 'string', enum: ['video', 'audio'] }, path: { type: 'string' }
  }, ['path'])
];

function tool(name, description, properties, required = []) {
  return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } };
}

function resultContent(response) {
  const value = response && response.result;
  const frames = value && typeof value === 'object' && Array.isArray(value.frames) ? value.frames : null;
  if (!frames) return [{ type: 'text', text: JSON.stringify(response, null, 2) }];

  const metadata = {
    ...response,
    result: { ...value, frames: frames.map(({ dataUrl, ...frame }) => frame) }
  };
  const content = [{ type: 'text', text: JSON.stringify(metadata, null, 2) }];
  for (const frame of frames) {
    if (typeof frame.dataUrl !== 'string') continue;
    const match = /^data:([^;,]+);base64,(.*)$/s.exec(frame.dataUrl);
    if (match) content.push({ type: 'image', mimeType: match[1], data: match[2] });
  }
  return content;
}

function startMcpServer(callEditor, streams = {}) {
  const input = readline.createInterface({ input: streams.input || process.stdin, crlfDelay: Infinity, terminal: false });
  const output = streams.output || process.stdout;
  const send = (message) => output.write(JSON.stringify(message) + '\n');

  // Only mutations are serialized. Health, status, cancellation and restart
  // must remain responsive while a transcription or edit batch is busy.
  const serializedTools = new Set([
    'add_media', 'queue_media_import', 'resume_import', 'open_project', 'save_project',
    'checkpoint_project', 'set_project_soundtrack', 'apply_edit_batch', 'undo', 'redo', 'export', 'finish_editing'
  ]);
  let mutationQueue = Promise.resolve();

  const processMessage = async (message) => {
    try {
      let result;
      switch (message.method) {
        case 'initialize': {
          const supported = ['2025-06-18', '2025-03-26', '2024-11-05'];
          result = {
            protocolVersion: supported.includes(message.params?.protocolVersion)
              ? message.params.protocolVersion
              : supported[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'simple-vlog-editor', version: '2.1.0' },
            instructions: 'The visible editor is controlled through this server and checkpoints after mutations. Control tools remain responsive during long edits. Poll operation/import status, inspect transcripts and frames before editing, preserve projectRevision, and attach unspecified music as the project default soundtrack.'
          };
          break;
        }
        case 'ping': result = {}; break;
        case 'tools/list': result = { tools: TOOLS }; break;
        case 'tools/call': {
          const name = message.params?.name;
          if (!TOOLS.some((entry) => entry.name === name)) throw new Error(`Unknown tool "${name}".`);
          try {
            const response = await callEditor({ name, arguments: message.params?.arguments ?? {} });
            result = { content: resultContent(response), structuredContent: response };
          } catch (error) {
            result = {
              isError: true,
              content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
              structuredContent: {
                error: {
                  code: error && typeof error === 'object' && error.code ? error.code : 'editor_error',
                  message: error instanceof Error ? error.message : String(error),
                  details: error && typeof error === 'object' ? error.details : undefined
                }
              }
            };
          }
          break;
        }
        default: throw Object.assign(new Error(`Method not found: ${message.method}`), { rpcCode: -32601 });
      }
      send({ jsonrpc: '2.0', id: message.id, result });
    } catch (error) {
      send({ jsonrpc: '2.0', id: message.id, error: { code: error.rpcCode ?? -32603, message: error.message ?? String(error) } });
    }
  };

  input.on('line', (line) => {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); }
    catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(message, 'id')) return;

    const toolName = message.method === 'tools/call' ? message.params?.name : null;
    if (toolName && serializedTools.has(toolName)) {
      mutationQueue = mutationQueue.then(() => processMessage(message)).catch(() => undefined);
    } else {
      void processMessage(message);
    }
  });
  input.on('close', () => streams.onClose?.());

  return () => input.close();
}

module.exports = { startMcpServer, TOOLS };
