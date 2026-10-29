import { loadEnv } from '../src/config.js';

const required = { LLM_PROVIDER: 'openai', LLM_MODEL: 'some-model', REVIEW_API_TOKEN: 'r'.repeat(16) };

describe('loadEnv', () => {
  it('applies defaults', () => {
    expect(loadEnv(required)).toMatchObject({
      PORT: 3000,
      LOG_LEVEL: 'info',
      DATA_DIR: './data',
      EXTRACTION_MAX_ATTEMPTS: 2,
    });
  });

  it('requires an explicit provider, model and reviewer token', () => {
    expect(() => loadEnv({})).toThrow(/LLM_PROVIDER.*LLM_MODEL.*REVIEW_API_TOKEN/);
  });

  it('rejects short reviewer tokens', () => {
    expect(() => loadEnv({ ...required, REVIEW_API_TOKEN: 'short' })).toThrow(/REVIEW_API_TOKEN/);
  });
});
