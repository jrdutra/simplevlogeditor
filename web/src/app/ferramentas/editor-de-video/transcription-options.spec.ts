import {
  resolveTranscriptionLanguage,
  resolveTranscriptionModel
} from './transcription-options';

describe('MCP transcription options', () => {
  it('accepts the model aliases seen in existing AI clients', () => {
    expect(resolveTranscriptionModel('base')).toBe('onnx-community/whisper-base_timestamped');
    expect(resolveTranscriptionModel('Small-Quality')).toBe('onnx-community/whisper-small_timestamped');
    expect(resolveTranscriptionModel('turbo')).toBe('onnx-community/whisper-large-v3-turbo_timestamped');
  });

  it('accepts ISO, localized and automatic language aliases', () => {
    expect(resolveTranscriptionLanguage('pt')).toBe('portuguese');
    expect(resolveTranscriptionLanguage('PT-BR')).toBe('portuguese');
    expect(resolveTranscriptionLanguage('português')).toBe('portuguese');
    expect(resolveTranscriptionLanguage('auto')).toBe('');
  });
});
