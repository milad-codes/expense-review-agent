import { claimFingerprint } from '../src/policy/fingerprint.js';
import { InMemoryClaimStore } from '../src/store/claim-store.js';
import { lunch } from './fixtures.js';

describe('claimFingerprint', () => {
  it('ignores case, accents and punctuation in the merchant name', () => {
    expect(claimFingerprint('e1', lunch({ merchant: 'Café am Beispielplatz' }))).toBe(
      claimFingerprint('e1', lunch({ merchant: 'CAFE  AM BEISPIELPLATZ.' })),
    );
  });

  it('differs per employee, date and amount', () => {
    const base = claimFingerprint('e1', lunch());
    expect(claimFingerprint('e2', lunch())).not.toBe(base);
    expect(claimFingerprint('e1', lunch({ date: '2026-10-21' }))).not.toBe(base);
    expect(claimFingerprint('e1', lunch({ total: 48.61 }))).not.toBe(base);
  });
});

describe('InMemoryClaimStore.findDuplicate', () => {
  it('matches approved and pending claims but not rejected ones or the claim itself', async () => {
    const store = new InMemoryClaimStore();
    const record = { employeeId: 'e1', fingerprint: 'fp', updatedAt: '2026-10-22T00:00:00Z' };
    await store.save({ ...record, claimId: 'c1', status: 'rejected' });
    expect(await store.findDuplicate('fp', 'c9')).toBeNull();
    await store.save({ ...record, claimId: 'c2', status: 'pending' });
    expect(await store.findDuplicate('fp', 'c9')).toBe('c2');
    expect(await store.findDuplicate('fp', 'c2')).toBeNull();
  });
});
