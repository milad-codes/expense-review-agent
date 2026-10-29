import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { SqliteClaimStore } from '../src/store/sqlite-claim-store.js';
import { claim, createService } from './support.js';

describe('durable reviews (SQLite)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'era-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const open = (idPrefix = 'claim') => {
    const store = new SqliteClaimStore(join(dir, 'claims.sqlite'));
    const checkpointer = SqliteSaver.fromConnString(join(dir, 'checkpoints.sqlite'));
    return { ...createService({ store, checkpointer, idPrefix }), close: () => store.close() };
  };

  it('resumes a review in a new process after a restart', async () => {
    const before = open();
    const { claimId } = await before.service.submit(claim('big dinner'));
    before.close();

    const after = open(); // fresh service, same files: nothing in memory survives
    expect((await after.service.pending()).map((c) => c.claimId)).toEqual([claimId]);
    const view = await after.service.decide(claimId, { decision: 'approve', reviewer: 'Lena' });
    expect(view.status).toBe('approved');
    expect(view.events.map((e) => e.step)).toEqual(['extract', 'evaluate', 'human_review', 'finalize']);
    expect((await after.store.get(claimId))?.status).toBe('approved');
    after.close();
  });

  it('detects duplicates across restarts', async () => {
    const first = open();
    await first.service.submit(claim('routine lunch'));
    first.close();
    const second = open('after-restart');
    const view = await second.service.submit(claim('routine lunch'));
    expect(view.evaluation?.findings.map((f) => f.code)).toContain('DUPLICATE');
    second.close();
  });
});
