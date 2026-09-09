import { ChangeDetectorRef, ElementRef } from '@angular/core';
import { DataService } from '../../data.service';
import { SupressaoDeRuidoComponent } from './supressao-de-ruido.component';
import { DecodedAudio } from './media-audio';
import { GainField } from './spectral-gain';

describe('noise result settings', () => {
  let component: SupressaoDeRuidoComponent;
  beforeEach(() => {
    component = new SupressaoDeRuidoComponent({ setTituloAplicacao: () => {} } as unknown as DataService,
      { markForCheck: () => {} } as ChangeDetectorRef, 'browser' as unknown as object);
  });
  it('labels the completed result instead of the newly selected controls', () => {
    component.applied = { engine: 'gtcrn', strength: 1, preserveHighs: false };
    component.engineId = 'rnnoise';
    component.strengthIndex = 2;
    expect(component.appliedEngine).toBe('Voice model');
    expect(component.appliedStrength).toBe('Balanced');
    expect(component.settingsChanged).toBeTrue();
  });
  it('flags brightness changes as unapplied', () => {
    component.applied = { engine: 'gtcrn', strength: 1, preserveHighs: false };
    component.preserveHighs = true;
    expect(component.settingsChanged).toBeTrue();
  });
  it('keeps an existing diagnosis if a new analysis is cancelled', async () => {
    component.file = new File([], 'test.wav');
    const previous = { status: 'Inconclusive' } as NonNullable<typeof component.noiseReport>;
    component.noiseReport = previous;
    const state = component as unknown as { decoded: DecodedAudio };
    state.decoded = { channels: [new Float32Array(48000)], rate: 16000, seconds: 3, hasVideo: false };
    const job = component.analyse();
    expect(component.busy).toBeTrue();
    component.stop();
    await job;
    expect(component.noiseReport).toBe(previous);
    expect(component.busy).toBeFalse();
  });
  it('clears references and the diagnosis when another file is loaded', () => {
    component.useBackgroundReference = component.useVoiceReference = true;
    component.noiseReport = {} as NonNullable<typeof component.noiseReport>;
    component.clearFile();
    expect(component.noiseReport).toBeNull();
    expect(component.useBackgroundReference).toBeFalse();
    expect(component.useVoiceReference).toBeFalse();
  });
  it('keeps a completed result when a rerun is cancelled', async () => {
    component.file = new File([], 'test.wav');
    component.cleanedUrl = 'blob:previous';
    component.applied = { engine: 'rnnoise', strength: 1, preserveHighs: false };
    component.engineId = 'rnnoise';
    const state = component as unknown as { decoded: DecodedAudio; cleaned: { channels: Float32Array[]; rate: number } };
    state.decoded = { channels: [new Float32Array(48000)], rate: 48000, seconds: 1, hasVideo: false };
    const previous = { channels: [new Float32Array(100)], rate: 48000 };
    state.cleaned = previous;
    const job = component.run();
    component.stop();
    await job;
    expect(component.cleanedUrl).toBe('blob:previous');
    expect(state.cleaned).toBe(previous);
    expect(component.applied?.engine).toBe('rnnoise');
    expect(component.message).toBe('Stopped.');
  });
  it('invalidates analysis when the device changes and keeps Classic on CPU', () => {
    const state = component as unknown as { field: GainField; fieldEngine: string; fieldDevice: string };
    state.field = { frames: [new Float32Array([1])], step: 0.01, bandwidth: 1 };
    state.fieldEngine = 'gtcrn';
    state.fieldDevice = 'cpu';
    expect(component.needsEngine).toBeFalse();
    component.device = 'webgpu';
    expect(component.needsEngine).toBeTrue();
    component.engineId = 'rnnoise';
    expect(component.effectiveDevice).toBe('cpu');
  });
  it('plays the picture muted and in sync with cleaned audio', () => {
    const video = { currentTime: 0, muted: false, play: jasmine.createSpy().and.resolveTo(), pause: jasmine.createSpy() };
    const audio = { currentTime: 3 };
    const refs = component as unknown as { beforeRef: ElementRef<unknown>; afterRef: ElementRef<unknown> };
    refs.beforeRef = new ElementRef(video);
    refs.afterRef = new ElementRef(audio);
    component.compare = 'after';
    component.onPlay('after');
    expect(video.muted).toBeTrue();
    expect(video.currentTime).toBe(3);
    expect(video.play).toHaveBeenCalled();
    component.onPause('after');
    expect(video.pause).toHaveBeenCalled();
  });
});
