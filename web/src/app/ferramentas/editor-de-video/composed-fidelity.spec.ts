import { composedFidelity, describeFidelity, editFingerprint, fingerprintOf } from './composed-fidelity';
import { ProjectPlan } from './video-editor.models';

/**
 * Two clips. The first keeps 0–4 s and 6–10 s of its source (4–6 s was cut),
 * the second plays at double speed, and a one-second join sits at 7–8 s of the
 * finished video.
 */
function plan(overrides: Partial<Record<string, unknown>> = {}): ProjectPlan {
  return {
    width: 1920,
    height: 1080,
    frameRate: 30,
    fillFrame: false,
    clips: [
      {
        clip: { kind: 'media', id: 'a' },
        edits: { speed: 1 },
        keepRanges: [{ start: 0, end: 4 }, { start: 6, end: 10 }],
        outputStart: 0,
        outputDuration: 8
      },
      {
        clip: { kind: 'media', id: 'b' },
        edits: { speed: 2 },
        keepRanges: [{ start: 0, end: 10 }],
        outputStart: 7,
        outputDuration: 5
      }
    ],
    transitions: [{ clipId: null, fromIndex: 0, toIndex: 1, settings: { kind: 'dissolve' }, start: 7, end: 8 }],
    fades: [],
    zooms: [],
    captions: [],
    images: [],
    videoEffects: [],
    tags: [],
    ...overrides
  } as unknown as ProjectPlan;
}

describe('composed frame fidelity', () => {
  it('maps a kept instant to its place in the finished video', () => {
    const result = composedFidelity(plan(), 0, 2);
    expect(result.faithful).toBeTrue();
    expect(result.outputTime).toBe(2);
  });

  it('accounts for the stretch cut out before the instant', () => {
    // 4 s kept before the cut, then 1 s into the second kept stretch.
    expect(composedFidelity(plan(), 0, 7).outputTime).toBe(5);
  });

  it('refuses an instant that was cut out, and points at the nearest kept one', () => {
    const result = composedFidelity(plan(), 0, 5);
    expect(result.faithful).toBeFalse();
    expect(result.reason).toBe('removed');
    expect(result.suggestedSourceTime).toBe(3.9);
    expect(describeFidelity(result, 5)).toContain('cut out');
  });

  it('refuses the outgoing side of a join and steps back out of it', () => {
    const result = composedFidelity(plan(), 0, 9.5);
    expect(result.reason).toBe('transition');
    expect(result.avoidOutputRange).toEqual([7, 8]);
    // 6.9 s of output is 2.9 s into the second kept stretch.
    expect(result.suggestedSourceTime).toBe(8.9);
  });

  it('refuses the incoming side of a join and steps forward out of it, at its own speed', () => {
    const result = composedFidelity(plan(), 1, 1);
    expect(result.reason).toBe('transition');
    expect(result.outputTime).toBe(7.5);
    // 8.1 s of output is 1.1 s into the clip, which at double speed is 2.2 s of source.
    expect(result.suggestedSourceTime).toBe(2.2);
  });

  it('accepts the incoming clip once the join is over', () => {
    const result = composedFidelity(plan(), 1, 4);
    expect(result.faithful).toBeTrue();
    expect(result.outputTime).toBe(9);
  });

  it('knows a clip that is not on the timeline', () => {
    expect(composedFidelity(plan(), 5, 1).reason).toBe('not-on-timeline');
  });
});

describe('edit fingerprint', () => {
  it('is stable for the same edit', () => {
    expect(editFingerprint(plan())).toBe(editFingerprint(plan()));
  });

  it('changes when anything that reaches the picture changes', () => {
    const base = editFingerprint(plan());
    expect(editFingerprint(plan({ zooms: [{ start: 1, end: 2, scale: 1.2 }] }))).not.toBe(base);
    expect(editFingerprint(plan({ captions: [{ start: 0, end: 1, caption: { text: 'Oi' } }] }))).not.toBe(base);
    expect(editFingerprint(plan({ fillFrame: true }))).not.toBe(base);
  });

  it('ignores live objects such as files and bitmaps', () => {
    class Handle { readonly size = 10; }
    const withHandle = plan({ images: [{ start: 0, end: 1, clipId: 'a', fadeSeconds: 0, image: { path: 'x.png', source: new Handle() } }] });
    const plain = plan({ images: [{ start: 0, end: 1, clipId: 'a', fadeSeconds: 0, image: { path: 'x.png' } }] });
    expect(editFingerprint(withHandle)).toBe(editFingerprint(plain));
  });

  it('tells short strings apart', () => {
    expect(fingerprintOf('a')).not.toBe(fingerprintOf('b'));
    expect(fingerprintOf('')).toMatch(/^edit-[0-9a-f]{16}$/);
  });
});
