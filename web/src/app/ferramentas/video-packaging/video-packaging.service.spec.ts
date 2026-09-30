import { DesktopService } from '../../shared/desktop/desktop.service';
import { PackagingFrame, VideoPackagingService } from './video-packaging.service';

describe('VideoPackagingService text delivery', () => {
  const titles = ['Primeiro título', 'Segundo título', 'Terceiro título'];

  it('saves one complete text after incremental delivery and rewrites it on updates', async () => {
    const packaging = new VideoPackagingService({ isDesktop: true } as DesktopService);
    const write = jasmine.createSpy('write').and.resolveTo();
    packaging.registerTextWriter(write);
    await packaging.apply({ titles });
    await packaging.apply({ description: 'Descrição da viagem.\n\nOutro parágrafo.' });
    expect(write).not.toHaveBeenCalled();
    await packaging.apply({ tags: 'viagem, família' });
    expect(write).toHaveBeenCalledOnceWith(
      'Primeiro título\r\nSegundo título\r\nTerceiro título\r\n\r\nDescrição da viagem.\r\n\r\nOutro parágrafo.\r\n\r\nviagem, família\r\n'
    );
    await packaging.apply({ description: 'Descrição revisada.' });
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.calls.mostRecent().args[0]).toContain('\r\n\r\nDescrição revisada.\r\n\r\nviagem, família');
  });

  it('reports write failures and allows retrying the same delivery', async () => {
    const packaging = new VideoPackagingService({ isDesktop: true } as DesktopService);
    const write = jasmine.createSpy('write').and.rejectWith(new Error('Disk full'));
    packaging.registerTextWriter(write);
    const delivery = { titles, description: 'Descrição.', tags: ['vlog'] };
    await expectAsync(packaging.apply(delivery)).toBeRejectedWithError('Disk full');
    write.and.resolveTo();
    await expectAsync(packaging.apply(delivery)).toBeResolved();
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('releases the editor writer and keeps browser deliveries working without a local folder', async () => {
    const packaging = new VideoPackagingService({ isDesktop: true } as DesktopService);
    const write = jasmine.createSpy('write').and.resolveTo();
    const stop = packaging.registerTextWriter(write);
    stop();
    const delivery = { titles, description: 'Descrição.', tags: ['vlog'] };
    await expectAsync(packaging.apply(delivery)).toBeRejectedWithError(/Open the video editor/);
    const browser = new VideoPackagingService({ isDesktop: false } as DesktopService);
    await expectAsync(browser.apply(delivery)).toBeResolved();
    expect(write).not.toHaveBeenCalled();
  });
});

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

  type CoverInput = Parameters<VideoPackagingService['setThumbnails']>[0][number];

  function cover(overrides: Partial<CoverInput> = {}): CoverInput {
    return {
      path: 'C:\\covers\\1.png',
      sourceTimestamp: 12.5,
      sourceFramePath: 'C:\\frames\\x.jpg',
      tagStyleId: 'classic',
      tagStyleReferencePath: 'C:\\styles\\classic.png',
      letteringMethod: 'generated' as const,
      styleVerification: { checked: true, notes: 'Compared type, colours, outline, spacing and protected faces.' },
      ...overrides
    };
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
    packaging.rememberTagStylePath('C:\\styles\\classic.png');
    const message = await failure(packaging.setThumbnails([
      cover({ sourceTimestamp: 2 })
    ]));
    expect(message).toContain('save_frames wrote for this edit');
  });

  it('refuses a background saved from an earlier version of the edit', async () => {
    const packaging = service();
    let edit = 'edit-a';
    packaging.registerEditFingerprint(() => edit);
    packaging.recordFrames([frame('C:\\frames\\x.jpg', 12.5, 'edit-a')]);
    packaging.rememberTagStylePath('C:\\styles\\classic.png');
    edit = 'edit-b';
    const message = await failure(packaging.setThumbnails([
      cover()
    ]));
    expect(message).toContain('earlier version of the edit');
    expect(packaging.currentFrames().length).toBe(0);
  });

  it('insists on the frame\'s place in the finished video', async () => {
    const packaging = service();
    packaging.registerEditFingerprint(() => 'edit-a');
    packaging.recordFrames([frame('C:\\frames\\x.jpg', 12.5, 'edit-a')]);
    packaging.rememberTagStylePath('C:\\styles\\classic.png');
    const message = await failure(packaging.setThumbnails([
      cover({ sourceTimestamp: 3 })
    ]));
    expect(message).toContain('outputTime (12.5s');
  });

  it('accepts another spelling of the same Windows path, then reads the cover', async () => {
    const packaging = service();
    packaging.registerEditFingerprint(() => 'edit-a');
    packaging.rememberTagStylePath('C:\\styles\\classic.png');
    packaging.recordFrames([frame('C:\\Frames\\X.jpg', 12.5, 'edit-a')]);
    const message = await failure(packaging.setThumbnails([
      cover({ sourceTimestamp: 12.52, sourceFramePath: 'c:/frames/x.jpg' })
    ]));
    expect(message).toBe(REACHED);
  });

  it('rejects a cover generated from a style that is no longer active', async () => {
    const packaging = service();
    packaging.registerEditFingerprint(() => 'edit-a');
    packaging.recordFrames([frame('C:\\frames\\x.jpg', 12.5, 'edit-a')]);
    packaging.rememberTagStylePath('C:\\styles\\classic.png');
    const message = await failure(packaging.setThumbnails([
      cover({ tagStyleId: 'travel', tagStyleReferencePath: 'C:\\styles\\travel.png' })
    ]));
    expect(message).toContain('active lettering style');
  });

  it('requires a recorded visual comparison before delivery', async () => {
    const packaging = service();
    packaging.registerEditFingerprint(() => 'edit-a');
    packaging.recordFrames([frame('C:\\frames\\x.jpg', 12.5, 'edit-a')]);
    packaging.rememberTagStylePath('C:\\styles\\classic.png');
    const message = await failure(packaging.setThumbnails([
      cover({ styleVerification: { checked: false, notes: 'Not checked.' } })
    ]));
    expect(message).toContain('visual style check');
  });

  it('vouches for nothing once the editor that saved the frames is gone', () => {
    const packaging = service();
    const stop = packaging.registerEditFingerprint(() => 'edit-a');
    packaging.recordFrames([frame('C:\\frames\\x.jpg', 12.5, 'edit-a')]);
    expect(packaging.currentFrames().length).toBe(1);
    stop();
    expect(packaging.currentFrames().length).toBe(0);
  });

  it('ties a corrected background to its original frame and refuses an unrelated file', async () => {
    const packaging = service();
    packaging.registerEditFingerprint(() => 'edit-a');
    packaging.recordFrames([frame('C:\\frames\\x.jpg', 12.5, 'edit-a')]);
    packaging.rememberTagStylePath('C:\\styles\\classic.png');
    packaging.recordPreparedBackground('c:/frames/x.jpg', 'C:\\backgrounds\\x.png', { exposureStops: .2, contrast: 1.06, saturation: 1.04 });
    expect(await failure(packaging.setThumbnails([cover({ preparedBackgroundPath: 'C:\\backgrounds\\other.png' })])))
      .toContain('corrected background');
    expect(await failure(packaging.setThumbnails([cover({ preparedBackgroundPath: 'c:/backgrounds/x.png' })])))
      .toBe(REACHED);
  });

  it('refuses a cover if the edit changes while its file is being read', async () => {
    let edit = 'edit-a';
    const desktop = { readAgentFiles: async () => { edit = 'edit-b'; return []; } } as unknown as DesktopService;
    const packaging = new VideoPackagingService(desktop);
    packaging.registerEditFingerprint(() => edit);
    packaging.recordFrames([frame('C:\\frames\\x.jpg', 12.5, 'edit-a')]);
    packaging.rememberTagStylePath('C:\\styles\\classic.png');
    expect(await failure(packaging.setThumbnails([cover()]))).toContain('changed while loading');
    expect(packaging.options()[0].image).toBeNull();
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
