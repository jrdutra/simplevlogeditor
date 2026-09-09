import { TestBed } from '@angular/core/testing';
import { DEFAULT_PROJECT, DEFAULT_TEXT_DRAFT } from './video-editor-defaults';
import { TextClip } from './video-editor.models';
import { restoreProject, serializeProject } from './video-editor-project.store';
import { TagDialogComponent } from './tag-dialog.component';
import { DEFAULT_TAG, TAG_POSITIONS, clampTag, specialShape, tagLifetime } from './tag-overlay';
import { drawQrTagCode, qrTagError, qrTagMatrix } from './tag-qrcode';
import { drawTag, measureTag } from './tag-renderer';

describe('QR Code tags', () => {
  it('preserves the separate payload in both the clip and the project template', () => {
    const tag = clampTag({ ...DEFAULT_TAG, shape: 'qr-photo', text: 'Visit our site', qrText: 'https://example.com/?q=ação&n=1' });
    const clip: TextClip = {
      kind: 'text', id: 'qr', draft: { ...DEFAULT_TEXT_DRAFT }, overrides: null,
      backgroundFile: null, backgroundUrl: null, replacementAudio: null, tag
    };
    const stored = serializeProject([clip], { ...DEFAULT_PROJECT, defaultTag: { ...tag, qrText: 'Template payload' } }, 1);
    const restored = restoreProject(JSON.parse(JSON.stringify(stored)));
    expect((restored.clips[0] as TextClip).tag).toEqual(tag);
    expect(restored.project.defaultTag.qrText).toBe('Template payload');
    expect(restored.project.defaultTag.text).toBe('Visit our site');
  });

  it('opens an existing tag without adding a QR field or changing its settings', () => {
    expect(clampTag(DEFAULT_TAG)).toEqual(DEFAULT_TAG);
    const social = { ...DEFAULT_TAG, shape: 'social-photo' as const, text: '@utily' };
    expect(clampTag(social)).toEqual(social);
  });

  it('accepts Unicode and URLs, but rejects empty and oversized QR payloads', () => {
    expect(qrTagError('https://example.com/ação?name=João')).toBeNull();
    expect(qrTagError('Olá 👋 日本語')).toBeNull();
    expect(qrTagError('  ')).not.toBeNull();
    expect(qrTagError('x'.repeat(10000))).not.toBeNull();
  });

  it('reuses encoding during playback and changes it when the payload changes', () => {
    const first = qrTagMatrix('First destination');
    expect(first).not.toBeNull();
    expect(qrTagMatrix('First destination')).toBe(first);
    expect(qrTagMatrix('Second destination')).not.toBe(first);
  });

  it('draws an opaque four-module quiet zone and a black finder pattern', () => {
    const canvas = document.createElement('canvas');
    const modules = qrTagMatrix('https://example.com')!;
    const size = (modules.size + 8) * 4;
    canvas.width = canvas.height = size;
    const c = canvas.getContext('2d')!;
    drawQrTagCode(c, 'https://example.com', 0, 0, size);
    const pixel = (x: number, y: number) => Array.from(c.getImageData(x, y, 1, 1).data);
    expect(pixel(0, 0)).toEqual([255, 255, 255, 255]);
    expect(pixel(15, 16)).toEqual([255, 255, 255, 255]);
    expect(pixel(16, 16)).toEqual([0, 0, 0, 255]);
    expect(pixel(size - 1, size - 1)).toEqual([255, 255, 255, 255]);
  });

  for (const [qrId, socialId] of [
    ['qr-photo', 'social-photo'], ['qr-subscribe', 'social-subscribe'],
    ['qr-market-yellow', 'social-photo'], ['qr-shop-orange', 'social-photo']
  ] as const) {
    it(`keeps ${qrId}'s ribbon size and animation timing while fitting the larger badge`, () => {
      const qr = specialShape(qrId)!;
      const social = specialShape(socialId)!;
      expect(qr.natural).toEqual(social.natural);
      expect(qr.fit).toBe(social.fit);
      const tag = clampTag({ ...DEFAULT_TAG, shape: qrId, text: 'Scan me', qrText: 'https://example.com', holdAuto: false, holdSeconds: 5 });
      expect(tagLifetime(tag)).toBeCloseTo(6.75);
      const c = document.createElement('canvas').getContext('2d')!;
      for (const [width, height] of [[1920, 1080], [1080, 1920], [1080, 1080]]) {
        for (const position of TAG_POSITIONS) {
          const box = measureTag(c, { ...tag, position }, width, height);
          const overflow = qr.verticalOverflow! * box.width / qr.natural.width;
          expect(box.y - overflow).toBeGreaterThanOrEqual(0);
          expect(box.y + box.height + overflow).toBeLessThanOrEqual(height);
        }
      }
      c.canvas.width = 1280;
      c.canvas.height = 720;
      expect(() => drawTag(c, tag, 1280, 720, 2)).not.toThrow();
      expect(c.getImageData(0, 0, 1280, 720).data.some((value, index) => index % 4 === 3 && value > 0)).toBeTrue();
    });
  }
});

describe('QR Code tag dialog', () => {
  it('shows the QR input only for QR designs and saves the caption and payload independently', async () => {
    await TestBed.configureTestingModule({ imports: [TagDialogComponent] }).compileComponents();
    const fixture = TestBed.createComponent(TagDialogComponent);
    const dialog = fixture.componentInstance;
    const original = { ...DEFAULT_TAG, shape: 'social-photo' as const, text: 'Visit us' };
    dialog.tag = original;
    fixture.detectChanges();
    try {
      expect(document.querySelector('#tag-qr-text')).toBeNull();
      dialog.onShape('qr-photo');
      fixture.detectChanges();
      const input = document.querySelector<HTMLInputElement>('#tag-qr-text')!;
      expect(input).not.toBeNull();
      expect(dialog.qrError).not.toBeNull();
      const saved = spyOn(dialog.saved, 'emit');
      dialog.apply();
      expect(saved).not.toHaveBeenCalled();
      input.value = 'https://example.com/qr';
      input.dispatchEvent(new Event('input'));
      fixture.detectChanges();
      dialog.apply();
      expect(saved).toHaveBeenCalledWith(jasmine.objectContaining({ text: 'Visit us', qrText: input.value, shape: 'qr-photo' }));
      expect(original).toEqual({ ...DEFAULT_TAG, shape: 'social-photo', text: 'Visit us' });
      dialog.onShape('social-photo');
      fixture.detectChanges();
      expect(document.querySelector('#tag-qr-text')).toBeNull();
      dialog.onShape('qr-subscribe');
      expect(dialog.draft.qrText).toBe(input.value);
      for (const shape of ['qr-market-yellow', 'qr-shop-orange']) {
        dialog.onShape(shape);
        fixture.detectChanges();
        expect(document.querySelector('#tag-qr-text')).not.toBeNull();
        expect(dialog.qrError).toBeNull();
        expect(dialog.draft.qrText).toBe(input.value);
        expect(dialog.draft.text).toBe('Visit us');
        dialog.apply();
        expect(saved).toHaveBeenCalledWith(jasmine.objectContaining({ shape, qrText: input.value }));
      }
    } finally {
      fixture.destroy();
    }
  });
});
