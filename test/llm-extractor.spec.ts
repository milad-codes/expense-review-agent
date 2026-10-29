import { FakeListChatModel } from '@langchain/core/utils/testing';
import { ExtractionError } from '../src/extraction/extractor.js';
import { LlmReceiptExtractor, totalIsGrounded } from '../src/extraction/llm-extractor.js';
import { lunch } from './fixtures.js';

const RECEIPT_TEXT = `CAFÉ AM BEISPIELPLATZ
Beispielstraße 11, München
20.10.2026  12:41
2x Mittagsmenü        43,80
2x Wasser              4,80
SUMME EUR             48,60`;

const reply = (value: unknown) => JSON.stringify(value);
const extractorFor = (...responses: string[]) =>
  new LlmReceiptExtractor(new FakeListChatModel({ responses }), { method: 'jsonMode', maxAttempts: 2 });

describe('LlmReceiptExtractor', () => {
  it('returns the structured receipt', async () => {
    const extractor = extractorFor(reply({ readable: true, problem: '', receipt: lunch() }));
    await expect(extractor.extract(RECEIPT_TEXT)).resolves.toEqual(lunch());
  });

  it('turns "unreadable" into an ExtractionError with the model\'s reason', async () => {
    const extractor = extractorFor(reply({ readable: false, problem: 'total is cut off', receipt: null }));
    await expect(extractor.extract('blurry')).rejects.toThrow(new ExtractionError('total is cut off'));
  });

  it('retries once on invalid output', async () => {
    const extractor = extractorFor(
      'not json at all',
      reply({ readable: true, problem: '', receipt: lunch() }),
    );
    await expect(extractor.extract(RECEIPT_TEXT)).resolves.toMatchObject({ total: 48.6 });
  });

  it('gives up after the configured attempts', async () => {
    const extractor = extractorFor(
      reply({ readable: true, problem: '', receipt: { merchant: '' } }),
      'still wrong',
    );
    await expect(extractor.extract(RECEIPT_TEXT)).rejects.toThrow(/no valid extraction after 2 attempts/);
  });

  it('rejects a total that is not printed on the receipt', async () => {
    const extractor = extractorFor(reply({ readable: true, problem: '', receipt: lunch({ total: 486 }) }));
    await expect(extractor.extract(RECEIPT_TEXT)).rejects.toThrow(/486.00 does not appear/);
  });
});

describe('totalIsGrounded', () => {
  it.each([
    ['SUMME 48,60 EUR', 48.6],
    ['Total: $1,234.50', 1234.5],
    ['Gesamt 1.234,50 €', 1234.5],
    ['TOTAL 12.00', 12],
    ['Total 1 234,50 EUR', 1234.5],
    ["Total CHF 1'234.50", 1234.5],
    ['SUMME\nEUR 48,60', 48.6],
  ])('finds the total in %j', (text, total) => {
    expect(totalIsGrounded(text, total)).toBe(true);
  });

  it('does not match a different amount', () => {
    expect(totalIsGrounded('SUMME 48,60', 4.86)).toBe(false);
  });

  it.each([
    ['GESAMT EUR 14,86', 4.86],
    ['Summe 1.234,50 €', 234.5],
    ['Total: $1,234.50', 234.5],
    ['Betrag 148,60', 48.6],
    ['2x Menü 340,00', 40],
  ])('does not accept a total that is only part of a larger number in %j', (text, total) => {
    expect(totalIsGrounded(text, total)).toBe(false);
  });
});

describe('provider errors', () => {
  it('are rethrown instead of being reported as an unreadable receipt', async () => {
    const failing = new FakeListChatModel({ responses: ['x'] });
    failing.invoke = async () => {
      throw new Error('429 rate limited');
    };
    const extractor = new LlmReceiptExtractor(failing, { method: 'jsonMode' });
    const error = await extractor.extract(RECEIPT_TEXT).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(ExtractionError);
    expect((error as Error).message).toMatch(/429/);
  });
});
