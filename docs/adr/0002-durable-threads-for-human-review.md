# 0002 — Durable LangGraph threads for human review

**Status:** accepted · 2026-10-29

## Context

A claim that needs a reviewer can wait for days. Keeping it in memory, or re-running extraction when the reviewer
answers, would lose state on deploys and cost another LLM call with a possibly different result.

## Decision

- Each claim is one LangGraph thread (`thread_id = claimId`) with a SQLite checkpointer.
- `human_review` calls `interrupt()` with a zod response schema; the reviewer's decision resumes the thread with
  `Command({ resume })`. The node has no side effects before `interrupt()` because it is re-executed on resume.
- A failed step (e.g. provider outage) stays in the checkpoint and is resumed with `invoke(null)` via `POST /claims/:id/retry`.
- The claim is written to the claim store as `pending` during evaluation, so duplicates submitted during a review are caught.

## Consequences

- Restarts and deploys do not lose reviews (covered by a test that reopens the SQLite files in a new service).
- The checkpointer and claim store are ports: Postgres can replace SQLite for multi-instance deployments, together
  with a database lock for concurrent decisions.
