import { DesktopService } from '../../shared/desktop/desktop.service';
import { PackagingFrame, VideoPackagingService } from './video-packaging.service';

/**
 * Provenance: a cover may only be drawn on a background the editor saved from
 * the edit as it is now. These run without a browser — the check happens
 * before any image is read, and the stub desktop proves that by being the
 * first thing reached once the check passes.
 */
describe('VideoPackagingService provenance', () => {
  const REACHED = 'reached-read';

  function service(): VideoPackagingService {
    const desktop = {
      readAgentFiles: async () => { throw Object.assign(new Error(REACHED), { code: 'sentinel' }); }
    } as unknown as DesktopService;
    return new VideoPackagingService(desktop);
  }

  function frame(path: string, outputTime: number, editFingerprint: string): PackagingFrame {
    return { path, clipId: 'a', timestamp: 3, outputTime, width: 1920, height: 1080, composited: true, editFingerprint };
  }

  async function failure(run: Promise<unknown>): Promise<string> {
    try {
      await run;
      return 'resolved';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  it('refuses a cover that names no saved background', async () => {
    const packaging = service();
    packaging.registerEditFingerprint(() => 'edit-a');
    const message = await failure(packaging.setThumbnails([
      { path: 'C:\\covers\\1.png', sourceTimestamp: 2, sourceFramePath: 'C:\\frames\\x.jpg' }
    ]));
    expect(message).toContain('save_frames wrote for this edit');
  });

  it('refuses a background saved from an earlier version of the edit', async () => {
    const packaging = service();
    let edit = 'edit-a';
    packaging.registerEditFingerprint(() => edit);
    packaging.recordFrames([frame('C:\\frames\\x.jpg', 12.5, 'edit-a')]);
    edit = 'edit-b';
    const message = await failure(packaging.setThumbnails([
      { path: 'C:\\covers\\1.png', sourceTimestamp: 12.5, sourceFramePath: 'C:\\frames\\x.jpg' }
    ]));
    expect(message).toContain('earlier version of the edit');
    expect(packaging.currentFrames().length).toBe(0);
  });

  it('insists on the frame\'s place in the finished video', async () => {
    const packaging = service();
    packaging.registerEditFingerprint(() => 'edit-a');
    packaging.recordFrames([frame('C:\\frames\\x.jpg', 12.5, 'edit-a')]);
    const message = await failure(packaging.setThumbnails([
      { path: 'C:\\covers\\1.png', sourceTimestamp: 3, sourceFramePath: 'C:\\frames\\x.jpg' }
    ]));
    expect(message).toContain('outputTime (12.5s');
  });

  it('accepts another spelling of the same Windows path, then reads the cover', async () => {
    const packaging = service();
    packaging.registerEditFingerprint(() => 'edit-a');
    packaging.recordFrames([frame('C:\\Frames\\X.jpg', 12.5, 'edit-a')]);
    const message = await failure(packaging.setThumbnails([
      { path: 'C:\\covers\\1.png', sourceTimestamp: 12.52, sourceFramePath: 'c:/frames/x.jpg' }
    ]));
    expect(message).toBe(REACHED);
  });

  it('vouches for nothing once the editor that saved the frames is gone', () => {
    const packaging = service();
    const stop = packaging.registerEditFingerprint(() => 'edit-a');
    packaging.recordFrames([frame('C:\\frames\\x.jpg', 12.5, 'edit-a')]);
    expect(packaging.currentFrames().length).toBe(1);
    stop();
    expect(packaging.currentFrames().length).toBe(0);
  });

  it('marks the stored understanding stale when the edit moves on', () => {
    const packaging = service();
    let edit = 'edit-a';
    packaging.registerEditFingerprint(() => edit);
    packaging.setUnderstanding({ summary: 'Moving day', chapters: [{ start: 0, title: 'Intro' }] });
    expect(packaging.understandingState()?.stale).toBeFalse();
    edit = 'edit-b';
    expect(packaging.understandingState()?.stale).toBeTrue();
    expect(packaging.understandingState()?.summary).toBe('Moving day');
  });

  it('never changes anything when one field of a delivery is invalid', async () => {
    const packaging = service();
    await packaging.apply({ titles: ['First title'] });
    const message = await failure(packaging.apply({ titles: ['Second title'], tags: ['ok', '   '] }));
    expect(message).toContain('tags[1]');
    expect(packaging.options()[0].title).toBe('First title');
  });
});
