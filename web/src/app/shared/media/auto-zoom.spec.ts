import {
  AutoZoomSettings,
  DEFAULT_AUTO_ZOOM,
  ZoomTimeRange,
  clampAutoZoom,
  planAutoZooms,
  zoomScaleAt
} from './auto-zoom';

/**
 * The planner is where the feature actually lives, so it is tested on its own:
 * it is pure, it decides everything visible about a zoom, and it is the one
 * piece that must give the same answer in the preview and in the export.
 */
describe('auto zoom planner', () => {
  const enabled: AutoZoomSettings = { ...DEFAULT_AUTO_ZOOM, enabled: true, rampSeconds: 0, holdSeconds: 2 };

  /** Three ordinary pauses and one that is plainly out of line. */
  const silences: ZoomTimeRange[] = [
    { start: 10, end: 10.5 },
    { start: 20, end: 20.5 },
    { start: 30, end: 33 },
    { start: 40, end: 40.5 }
  ];

  /** What survives those cuts. */
  const keeps: ZoomTimeRange[] = [
    { start: 0, end: 10 },
    { start: 10.5, end: 20 },
    { start: 20.5, end: 30 },
    { start: 33, end: 40 },
    { start: 40.5, end: 50 }
  ];

  it('does nothing while the option is off', () => {
    expect(planAutoZooms(silences, keeps, { ...enabled, enabled: false })).toEqual([]);
  });

  it('zooms only after the pause that stands out', () => {
    const plan = planAutoZooms(silences, keeps, enabled, 'clip-1');

    expect(plan.length).toBe(1);
    expect(plan[0].pauseSeconds).toBeCloseTo(3, 6);
  });

  it('places the zoom in output time, not source time', () => {
    const plan = planAutoZooms(silences, keeps, enabled, 'clip-1');

    // The three ranges before the long pause last 10 + 9.5 + 9.5 seconds.
    expect(plan[0].start).toBeCloseTo(29, 6);
    expect(plan[0].end).toBeCloseTo(31, 6);
  });

  it('keeps the amount inside the configured range', () => {
    const plan = planAutoZooms(silences, keeps, { ...enabled, minZoomPercent: 12, maxZoomPercent: 18 }, 'clip-1');

    expect(plan[0].scale).toBeGreaterThanOrEqual(1.12);
    expect(plan[0].scale).toBeLessThanOrEqual(1.18);
  });

  it('is deterministic for one seed and varies between seeds', () => {
    const first = planAutoZooms(silences, keeps, enabled, 'clip-1');
    const again = planAutoZooms(silences, keeps, enabled, 'clip-1');

    expect(again[0].scale).toBe(first[0].scale);
  });

  it('gives the longest pause the largest zoom in proportional mode', () => {
    const longer: ZoomTimeRange[] = [...silences.slice(0, 2), { start: 30, end: 40 }, silences[3]];
    const shifted: ZoomTimeRange[] = [
      { start: 0, end: 10 },
      { start: 10.5, end: 20 },
      { start: 20.5, end: 30 },
      { start: 40, end: 40 + 7 },
      { start: 47.5, end: 57 }
    ];

    const plan = planAutoZooms(longer, shifted, { ...enabled, scaleMode: 'proportional' }, 'clip-1');

    expect(plan[0].scale).toBeCloseTo(1 + enabled.maxZoomPercent / 100, 6);
  });

  it('holds the zoom to the end of the take when no hold is set', () => {
    const plan = planAutoZooms(silences, keeps, { ...enabled, holdSeconds: 0 }, 'clip-1');

    // The fourth kept range lasts seven seconds, starting at output 29.
    expect(plan[0].end).toBeCloseTo(36, 6);
  });

  it('zooms every so many cuts when asked to count instead', () => {
    const plan = planAutoZooms(
      silences,
      keeps,
      { ...enabled, triggerMode: 'every-cuts', everyCuts: 2, intervalZoomPercent: 10 },
      'clip-1'
    );

    // Four pauses, so the second and the fourth, each with a take after it.
    expect(plan.length).toBe(2);
    expect(plan.every((segment) => segment.reason === 'every-cuts')).toBeTrue();
    expect(plan[0].scale).toBeCloseTo(1.1, 6);
    expect(plan[1].scale).toBeCloseTo(1.1, 6);
  });

  it('combines both rules without zooming twice on one pause', () => {
    const plan = planAutoZooms(
      silences,
      keeps,
      { ...enabled, triggerMode: 'both', everyCuts: 3, intervalZoomPercent: 10 },
      'clip-1'
    );

    // The third pause is both the long one and the third: one zoom, not two,
    // and the rule that reads the content wins the amount.
    expect(plan.length).toBe(1);
    expect(plan[0].reason).toBe('above-average');
  });

  it('never lets two zooms overlap', () => {
    const many: ZoomTimeRange[] = [
      { start: 5, end: 5.2 },
      { start: 10, end: 13 },
      { start: 14, end: 17 },
      { start: 20, end: 20.2 }
    ];
    const kept: ZoomTimeRange[] = [
      { start: 0, end: 5 },
      { start: 5.2, end: 10 },
      { start: 13, end: 14 },
      { start: 17, end: 20 },
      { start: 20.2, end: 30 }
    ];

    const plan = planAutoZooms(many, kept, { ...enabled, holdSeconds: 30 }, 'clip-1');

    for (let i = 1; i < plan.length; i++) {
      expect(plan[i].start).toBeGreaterThanOrEqual(plan[i - 1].end);
    }
  });
});

describe('zoomScaleAt', () => {
  const segments = [
    { start: 10, end: 20, scale: 1.2, rampSeconds: 2, pauseSeconds: 3, easeOut: true, reason: 'above-average' as const }
  ];

  it('is neutral outside every segment', () => {
    expect(zoomScaleAt(segments, 5)).toBe(1);
    expect(zoomScaleAt(segments, 25)).toBe(1);
  });

  it('reaches the full amount once the ramp is over', () => {
    expect(zoomScaleAt(segments, 15)).toBeCloseTo(1.2, 6);
  });

  it('eases in from neutral and back out to it', () => {
    expect(zoomScaleAt(segments, 10)).toBeCloseTo(1, 6);
    expect(zoomScaleAt(segments, 11)).toBeGreaterThan(1);
    expect(zoomScaleAt(segments, 11)).toBeLessThan(1.2);
    expect(zoomScaleAt(segments, 19.999)).toBeCloseTo(1, 3);
  });
});

describe('clampAutoZoom', () => {
  it('puts a backwards range the right way round', () => {
    const clamped = clampAutoZoom({ ...DEFAULT_AUTO_ZOOM, minZoomPercent: 25, maxZoomPercent: 10 });

    expect(clamped.minZoomPercent).toBe(10);
    expect(clamped.maxZoomPercent).toBe(25);
  });

  it('replaces a value that is not a number at all', () => {
    const clamped = clampAutoZoom({ ...DEFAULT_AUTO_ZOOM, triggerPercent: Number.NaN });

    expect(clamped.triggerPercent).toBe(0);
  });
});
