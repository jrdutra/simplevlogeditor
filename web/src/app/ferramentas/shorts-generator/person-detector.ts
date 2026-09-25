import type { HumanResult } from '../../vendor/human/human.esm.js';

export type TrackingStage = 'loading' | 'analysing' | 'fallback';

/** A cancellable runtime per analysis; never share mutable detector state between cuts. */
export class PersonDetector {
  private worker?: Worker;
  private backend = /Electron\//i.test(navigator.userAgent) ? 'wasm' : 'webgl';
  constructor(private cancelled: () => boolean, private stage: (stage: TrackingStage) => void) {}
  dispose() { this.worker?.terminate(); this.worker = undefined; }
  private request(data: unknown, timeout: number): Promise<any> {
    const worker = this.worker!;
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (error?: Error, value?: unknown) => {
        if (finished) return;
        finished = true; clearTimeout(timer); clearInterval(poll);
        worker.onmessage = null; worker.onerror = null;
        if (error) { this.dispose(); reject(error); } else resolve(value);
      };
      const timer = setTimeout(() => finish(new Error('Person detector timed out. Please try again.')), timeout);
      const poll = setInterval(() => { if (this.cancelled()) finish(new Error('Tracking cancelled.')); }, 100);
      worker.onmessage = ({ data }) => data.ok ? finish(undefined, data.result) : finish(new Error(data.error));
      worker.onerror = event => { event.preventDefault(); finish(new Error(event.message || 'Person detector failed.')); };
      try { worker.postMessage(data); } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
  }
  private async start() {
    if (this.cancelled()) throw new Error('Tracking cancelled.');
    this.worker = new Worker(new URL('./person-detector.worker', import.meta.url), { type: 'module' });
    await this.request({ type: 'init', backend: this.backend,
      modelBasePath: new URL('assets/models/human/', document.baseURI).href,
      wasmPath: new URL('assets/models/human/wasm/', document.baseURI).href
    }, 60000);
  }
  async detect(image: ImageData, bodies = false): Promise<HumanResult> {
    try {
      if (!this.worker) { this.stage('loading'); await this.start(); }
      this.stage('analysing');
      return await this.request({ type: 'detect', image, bodies }, 30000);
    } catch (error) {
      this.dispose();
      if (this.cancelled() || this.backend === 'wasm') throw error;
      this.backend = 'wasm'; this.stage('fallback');
      await this.start();
      this.stage('analysing');
      return await this.request({ type: 'detect', image, bodies }, 30000);
    }
  }
}
