import { Human } from '../../vendor/human/human.esm.js';

// A detector owns its TensorFlow runtime. Terminating this worker really stops a
// stalled backend; retrying cannot race an old inference or another cut's models.
let human: Human;
addEventListener('message', async ({ data }) => {
  try {
    if (data.type === 'init') {
      human = new Human({
        backend: data.backend, modelBasePath: data.modelBasePath, wasmPath: data.wasmPath,
        debug: false, warmup: 'none', cacheSensitivity: 0,
        filter: { enabled: false }, gesture: { enabled: false }, body: { enabled: false },
        hand: { enabled: false }, segmentation: { enabled: false },
        face: {
          enabled: true,
          detector: { modelPath: 'blazeface.json', rotation: false, maxDetected: 6, minConfidence: .35, skipFrames: 0, skipTime: 0, return: false },
          mesh: { enabled: true, modelPath: 'facemesh.json' },
          attention: { enabled: false }, iris: { enabled: false }, emotion: { enabled: false },
          description: { enabled: false }, antispoof: { enabled: false }, liveness: { enabled: false }
        },
        object: { enabled: true, modelPath: 'centernet.json', minConfidence: .3, maxDetected: 10, skipFrames: 0, skipTime: 0 }
      });
      // Single-threaded SIMD works without cross-origin isolation or nested
      // WASM worker scripts, including the packaged Electron HTTP server.
      if (data.backend === 'wasm') human.tf.env().set('WASM_HAS_MULTITHREAD_SUPPORT', false);
      await human.load();
      postMessage({ ok: true });
    } else {
      const result = await human.detect(data.image, { face: { enabled: !data.bodies }, object: { enabled: data.bodies } });
      if (result.error) throw new Error(result.error);
      postMessage({ ok: true, result: { face: result.face, object: result.object } });
    }
  } catch (error) {
    postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
