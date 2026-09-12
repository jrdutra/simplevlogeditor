import { EDITOR_AGENT_API_VERSION, EditorAgentError, finiteNumber, stringValue } from './editor-agent-api';

describe('editor agent API contract', () => {
  it('has a stable positive version', () => expect(EDITOR_AGENT_API_VERSION).toBeGreaterThan(0));

  it('rejects non-finite timeline values', () => {
    expect(() => finiteNumber(Number.NaN, 'start')).toThrowError(EditorAgentError);
    expect(() => finiteNumber(Infinity, 'end')).toThrowError(EditorAgentError);
  });

  it('normalizes required identifiers without changing their value', () => {
    expect(stringValue('clip-7', 'clipId')).toBe('clip-7');
    expect(() => stringValue('  ', 'clipId')).toThrowError(EditorAgentError);
  });
});
