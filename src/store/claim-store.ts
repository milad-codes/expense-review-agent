export type ClaimStatus = 'pending' | 'approved' | 'rejected';

export interface ClaimRecord {
  claimId: string;
  employeeId: string;
  fingerprint: string;
  status: ClaimStatus;
  updatedAt: string;
}

/** Persistence needed by the policy step: duplicate lookup and claim status. */
export interface ClaimStore {
  /** Id of another approved or pending claim with this fingerprint (rejected claims may be resubmitted). */
  findDuplicate(fingerprint: string, excludeClaimId: string): Promise<string | null>;
  save(record: ClaimRecord): Promise<void>;
  get(claimId: string): Promise<ClaimRecord | null>;
  listByStatus(status: ClaimStatus): Promise<ClaimRecord[]>;
}

export class InMemoryClaimStore implements ClaimStore {
  private readonly records = new Map<string, ClaimRecord>();

  async findDuplicate(fingerprint: string, excludeClaimId: string): Promise<string | null> {
    for (const record of this.records.values()) {
      if (
        record.fingerprint === fingerprint &&
        record.claimId !== excludeClaimId &&
        record.status !== 'rejected'
      ) {
        return record.claimId;
      }
    }
    return null;
  }

  async save(record: ClaimRecord): Promise<void> {
    this.records.set(record.claimId, { ...record });
  }

  async get(claimId: string): Promise<ClaimRecord | null> {
    return this.records.get(claimId) ?? null;
  }

  async listByStatus(status: ClaimStatus): Promise<ClaimRecord[]> {
    return [...this.records.values()].filter((r) => r.status === status);
  }
}
