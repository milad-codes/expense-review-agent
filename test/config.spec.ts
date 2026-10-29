import { loadEnv } from '../src/config.js';

describe('loadEnv', () => {
  it('applies defaults', () => {
    expect(loadEnv({})).toMatchObject({ PORT: 3000, LOG_LEVEL: 'info', DATA_DIR: './data' });
  });

  it('lists every invalid variable', () => {
    expect(() => loadEnv({ PORT: 'x', LOG_LEVEL: 'loud' })).toThrow(/PORT.*LOG_LEVEL/);
  });
});
