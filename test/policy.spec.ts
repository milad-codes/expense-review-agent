import { evaluateClaim, routeFor } from '../src/policy/policy.js';
import { context, lunch } from './fixtures.js';

const codes = (r: ReturnType<typeof evaluateClaim>) => r.findings.map((f) => f.code);

describe('evaluateClaim', () => {
  it('auto-approves a routine claim', () => {
    const result = evaluateClaim(lunch(), context());
    expect(result).toEqual({ amountEur: 48.6, reimbursableEur: 48.6, findings: [], route: 'auto_approve' });
  });

  it('converts foreign currencies to EUR', () => {
    const result = evaluateClaim(lunch({ currency: 'USD', total: 50 }), context());
    expect(result.amountEur).toBe(46);
    expect(result.route).toBe('auto_approve');
  });

  it('sends unknown currencies to a human without guessing an amount', () => {
    const result = evaluateClaim(lunch({ currency: 'XYZ' }), context());
    expect(result).toMatchObject({ amountEur: null, reimbursableEur: null, route: 'human_review' });
    expect(codes(result)).toEqual(['UNKNOWN_CURRENCY']);
  });

  it('deducts alcohol and explains it', () => {
    const result = evaluateClaim(lunch({ total: 70, alcoholAmount: 18.5 }), context());
    expect(result.reimbursableEur).toBe(51.5);
    expect(result.findings).toEqual([
      expect.objectContaining({ code: 'ALCOHOL_EXCLUDED', severity: 'info' }),
    ]);
    expect(result.route).toBe('auto_approve');
  });

  it('rejects a receipt with nothing reimbursable', () => {
    const result = evaluateClaim(lunch({ total: 30, alcoholAmount: 30 }), context());
    expect(codes(result)).toContain('NOTHING_REIMBURSABLE');
    expect(result.route).toBe('auto_reject');
  });

  describe('category limits', () => {
    it('applies the meal limit per person', () => {
      expect(evaluateClaim(lunch({ total: 110, attendees: 2 }), context()).route).toBe('auto_approve');
      const over = evaluateClaim(lunch({ total: 130, attendees: 2 }), context());
      expect(over.findings[0]).toMatchObject({
        code: 'OVER_LIMIT',
        message: expect.stringContaining('€65.00 per person'),
      });
      expect(over.route).toBe('human_review');
    });

    it('applies the lodging limit per night and needs the number of nights', () => {
      const hotel = lunch({
        category: 'lodging',
        merchant: 'Hotel Isar',
        total: 340,
        attendees: 1,
        nights: 2,
      });
      expect(evaluateClaim(hotel, context()).route).toBe('human_review'); // only the auto-approval limit
      expect(codes(evaluateClaim(hotel, context()))).toEqual(['ABOVE_AUTO_APPROVAL_LIMIT']);
      expect(codes(evaluateClaim({ ...hotel, total: 400 }, context()))).toContain('OVER_LIMIT');
      expect(codes(evaluateClaim({ ...hotel, nights: 0 }, context()))).toContain('MISSING_NIGHTS');
    });

    it.each([
      ['ground_transport', 151],
      ['airfare', 801],
      ['office_supplies', 201],
      ['software', 101],
    ] as const)('flags %s above its limit', (category, total) => {
      expect(codes(evaluateClaim(lunch({ category, total, attendees: 1 }), context()))).toContain(
        'OVER_LIMIT',
      );
    });

    it('never auto-approves the "other" category', () => {
      expect(evaluateClaim(lunch({ category: 'other', total: 5, attendees: 1 }), context()).route).toBe(
        'human_review',
      );
    });
  });

  describe('dates', () => {
    it('rejects receipts dated after submission', () => {
      expect(codes(evaluateClaim(lunch({ date: '2026-10-23' }), context()))).toContain('FUTURE_DATE');
    });

    it('rejects receipts older than the submission window', () => {
      // submitted 2026-10-22: 90 days earlier is still in time, 91 days is not
      expect(codes(evaluateClaim(lunch({ date: '2026-07-24' }), context()))).not.toContain(
        'SUBMITTED_TOO_LATE',
      );
      expect(codes(evaluateClaim(lunch({ date: '2026-07-23' }), context()))).toContain('SUBMITTED_TOO_LATE');
    });

    it('asks for approval of weekend meals and taxis but not weekend software', () => {
      expect(codes(evaluateClaim(lunch({ date: '2026-10-18' }), context()))).toEqual(['WEEKEND_EXPENSE']);
      expect(
        codes(
          evaluateClaim(
            lunch({ date: '2026-10-18', category: 'software', total: 20, attendees: 1 }),
            context(),
          ),
        ),
      ).toEqual([]);
    });
  });

  it('needs a business purpose', () => {
    expect(codes(evaluateClaim(lunch(), context({ businessPurpose: 'lunch' })))).toEqual([
      'MISSING_BUSINESS_PURPOSE',
    ]);
  });

  it('rejects duplicates', () => {
    const result = evaluateClaim(lunch(), context({ duplicateOf: 'claim-1' }));
    expect(result.findings[0]).toMatchObject({
      code: 'DUPLICATE',
      message: expect.stringContaining('claim-1'),
    });
    expect(result.route).toBe('auto_reject');
  });

  it('blocks win over review findings', () => {
    const result = evaluateClaim(lunch({ total: 500, date: '2026-10-23' }), context());
    expect(codes(result)).toEqual(
      expect.arrayContaining(['FUTURE_DATE', 'OVER_LIMIT', 'ABOVE_AUTO_APPROVAL_LIMIT']),
    );
    expect(result.route).toBe('auto_reject');
  });
});

describe('routeFor', () => {
  it('treats info findings as approvable', () => {
    expect(routeFor([{ code: 'ALCOHOL_EXCLUDED', severity: 'info', message: '' }])).toBe('auto_approve');
  });
});
