# 0001 — The model extracts facts, code makes decisions

**Status:** accepted · 2026-10-29

## Context

Expense decisions must be consistent, explainable and auditable. An LLM is excellent at reading receipts in any layout
and language, but its judgement about policy is neither stable across runs nor explainable to an auditor, and receipt
text is untrusted input that can contain instructions.

## Decision

- The LLM produces only a typed `Receipt` (merchant, date, currency, total, category, attendees, nights, alcohol amount)
  via structured output. It may answer `readable: false` instead of guessing.
- A pure function `evaluateClaim()` applies the policy and returns findings with codes, severities and messages.
- The extracted total must be printed on the receipt (grounding check); otherwise the claim goes to a person.
- Anything uncertain goes to a human: unreadable receipts, unknown currencies, review findings.

## Consequences

- Policy changes are code changes with unit tests and an evaluation gate in CI.
- Prompt injection can at most distort extracted facts, which the grounding check and the reviewer see; it cannot approve a claim.
- Extraction quality is measured separately (`npm run eval -- --extractor llm`) from decision quality (`--extractor gold`).
