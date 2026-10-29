import Database from 'better-sqlite3';
import type { ClaimRecord, ClaimStatus, ClaimStore } from './claim-store.js';

interface Row {
  claim_id: string;
  employee_id: string;
  fingerprint: string;
  status: ClaimStatus;
  updated_at: string;
}

const toRecord = (row: Row): ClaimRecord => ({
  claimId: row.claim_id,
  employeeId: row.employee_id,
  fingerprint: row.fingerprint,
  status: row.status,
  updatedAt: row.updated_at,
});

/** SQLite-backed claim index (duplicates, pending list). better-sqlite3 is synchronous; methods stay async for the port. */
export class SqliteClaimStore implements ClaimStore {
  private readonly db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      create table if not exists claims (
        claim_id text primary key,
        employee_id text not null,
        fingerprint text not null,
        status text not null check (status in ('pending', 'approved', 'rejected')),
        updated_at text not null
      );
      create index if not exists claims_fingerprint on claims (fingerprint);
      create index if not exists claims_status on claims (status, updated_at);
    `);
  }

  async findDuplicate(fingerprint: string, excludeClaimId: string): Promise<string | null> {
    const row = this.db
      .prepare(
        `select claim_id from claims where fingerprint = ? and claim_id <> ? and status <> 'rejected'
         order by updated_at limit 1`,
      )
      .get(fingerprint, excludeClaimId) as { claim_id: string } | undefined;
    return row?.claim_id ?? null;
  }

  async save(record: ClaimRecord): Promise<void> {
    this.db
      .prepare(
        `insert into claims (claim_id, employee_id, fingerprint, status, updated_at)
         values (@claimId, @employeeId, @fingerprint, @status, @updatedAt)
         on conflict (claim_id) do update set
           fingerprint = excluded.fingerprint, status = excluded.status, updated_at = excluded.updated_at`,
      )
      .run(record);
  }

  async get(claimId: string): Promise<ClaimRecord | null> {
    const row = this.db.prepare('select * from claims where claim_id = ?').get(claimId) as Row | undefined;
    return row ? toRecord(row) : null;
  }

  async listByStatus(status: ClaimStatus): Promise<ClaimRecord[]> {
    const rows = this.db
      .prepare('select * from claims where status = ? order by updated_at')
      .all(status) as Row[];
    return rows.map(toRecord);
  }

  close(): void {
    this.db.close();
  }
}
