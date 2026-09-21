import { describe, it, expect, vi } from 'vitest';
import { runAgent } from '@a11y-lens/cli/src/agent.mjs';

describe('a11y-lens patch behavior', () => {
  it('runAgent behavior is intact and can be mocked for retries', () => {
    const mockAgent = {
      invoke: vi.fn().mockImplementation(() => {
        throw new Error('ETIMEDOUT');
      })
    };

    const result = runAgent(mockAgent, 'prompt');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('ETIMEDOUT');
    expect(typeof result.error).toBe('string');
  });
});
