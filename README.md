# expense-review-agent

[![CI](https://github.com/milad-codes/expense-review-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/milad-codes/expense-review-agent/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/milad-codes/expense-review-agent)](https://github.com/milad-codes/expense-review-agent/releases)
[![License: MIT](https://img.shields.io/github/license/milad-codes/expense-review-agent)](LICENSE)

An agent that reviews employee expense claims, built with LangGraph.js. The work is split three ways:

- a language model reads the receipt;
- deterministic code applies the expense policy;
- a person decides what the policy can't settle.

Claims that wait for a person survive restarts.

## The problem

Most expense claims are routine, and a long tail needs judgement.

- **If a model makes the decisions,** they are hard to audit, and receipt text is untrusted input that can carry instructions.
- **If people check everything,** it's slow.

This project keeps each part where it is reliable. The model only extracts facts. Code decides and explains every decision. People handle the exceptions.

**In scope:** receipt text to a structured receipt, policy evaluation, routing, human review with durable waiting, an HTTP API, an evaluation harness.
**Out of scope:** reading images (the input is receipt text), employee authentication, payment or accounting integration, live exchange rates, review by more than one person.

## Design decisions

| Decision                                                                                                           | Why                                                                                                                                                       | Trade-off                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| The model extracts, code decides ([ADR 0001](docs/adr/0001-model-extracts-code-decides.md))                        | Decisions are deterministic, explainable and unit-tested. Text in a receipt can't approve a claim; the evaluation set includes such an injection attempt. | Policy changes need a code change. Extraction can still be wrong, so the next row exists.                       |
| Grounding check on the total                                                                                       | The extracted total must be printed on the receipt as a whole amount, so an invented or altered total goes to a person.                                   | Receipts with unusual number formats go to human review too.                                                    |
| One LangGraph thread per claim, SQLite checkpoints ([ADR 0002](docs/adr/0002-durable-threads-for-human-review.md)) | A claim can wait at `interrupt()` for days and resume after a restart (tested).                                                                           | One process and a local SQLite file. Several instances would need a shared checkpointer and a distributed lock. |
| Provider failures are not "unreadable receipts"                                                                    | When the LLM provider fails, the API answers `503`, keeps the claim and resumes from the failed step on `POST /claims/:id/retry`.                         | Clients have to retry.                                                                                          |
| One decision per claim                                                                                             | Two reviewers can't both decide the same claim (tested).                                                                                                  | The lock is held in process memory.                                                                             |

```mermaid
flowchart LR
  start([POST /claims]) --> extract[extract<br/><sub>LLM structured output<br/>+ grounding check</sub>]
  extract -->|readable| evaluate[evaluate<br/><sub>deterministic policy<br/>+ duplicate check</sub>]
  extract -->|unreadable| unreadable[mark_unreadable]
  evaluate -->|approve / reject| finalize[finalize]
  evaluate -->|needs a person| review{{human_review<br/><sub>interrupt()</sub>}}
  unreadable --> review
  review -->|POST /claims/:id/review| finalize
  finalize --> done([approved / rejected<br/>+ audit trail])
```

## Policy

| Rule                                                                                                                                                                                                                                                                         | Outcome                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Duplicate (same employee, merchant, date and amount) · receipt dated after submission · older than 90 days · nothing reimbursable                                                                                                                                            | **reject**                         |
| Meal over €60 per person · hotel over €180 per night · taxi or train over €150 · flight over €800 · office supplies over €200 · software over €100 · total over €250 · weekend meal or taxi · no business purpose · unknown currency · category "other" · unreadable receipt | **human review**                   |
| Alcohol                                                                                                                                                                                                                                                                      | deducted; the rest can be approved |

The limits are example values in `src/policy/policy.ts`, not any real company's policy.

## Try it without an API key

```bash
npm ci
npm run demo
```

```text
team lunch     → approved     findings: none
client dinner  → needs_review findings: OVER_LIMIT, ABOVE_AUTO_APPROVAL_LIMIT
drinks only    → rejected     findings: ALCOHOL_EXCLUDED, NOTHING_REIMBURSABLE

restarting: closing the API and the SQLite files, then opening them again …
pending after restart: 28e16067-… (€380)
reviewer approves → approved
audit trail: extract → evaluate → human_review → finalize
```

The demo sends three synthetic receipts through the HTTP API, restarts, and approves the waiting claim. Labelled extraction stands in for the model. Everything else is the real code: the policy, the LangGraph workflow, the SQLite checkpoints and the claim store.

## Run the API with a model

```bash
cp .env.example .env    # LLM_PROVIDER, LLM_MODEL, the provider's API key, REVIEW_API_TOKEN
npm ci
npm run dev             # http://localhost:3000; reads .env
```

```bash
curl -s localhost:3000/claims -H 'content-type: application/json' -d '{
  "employeeId": "emp-42",
  "businessPurpose": "Dinner with the customer to close the contract",
  "receiptText": "RESTAURANT ZUM MUSTERHOF\n21.10.2026 Gäste: 2\n2x Menü 340,00\nGESAMT EUR 380,00"
}'
```

You can also run it as a container: `docker build -t expense-review-agent .`, then `docker run -p 3000:3000 --env-file .env -v era-data:/data expense-review-agent`.

| Method | Path                 |                                                                                                                                                    |
| ------ | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/claims`            | `{ employeeId, receiptText, businessPurpose }` → `201` with `approved`, `rejected` or `needs_review`; `503` and a `claimId` if the provider failed |
| GET    | `/claims/:id`        | receipt, findings, review request, outcome and audit trail                                                                                         |
| POST   | `/claims/:id/retry`  | resume a failed claim from its checkpoint                                                                                                          |
| GET    | `/reviews/pending`   | reviewer token; claims waiting for a decision                                                                                                      |
| POST   | `/claims/:id/review` | reviewer token; `{ decision: "approve" \| "reject", reviewer, comment }`                                                                           |
| GET    | `/health`            |                                                                                                                                                    |

Errors are `application/problem+json`.

## Evaluation: two different measurements

|                  | Policy and workflow regression                                             | LLM evaluation                                                                                                |
| ---------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| What it measures | Policy and routing, given correct extraction: the labels replace the model | The model's extraction per field, plus routing and findings end to end                                        |
| Model calls      | none                                                                       | yes, paid                                                                                                     |
| Command          | `npm run eval -- --extractor gold`                                         | `npm run eval -- --extractor llm --max-cost-usd 1 --input-usd-per-mtok <price> --output-usd-per-mtok <price>` |
| Where it runs    | CI, on every change; it must stay at 100 %                                 | by hand, locally or through the "LLM evaluation (manual)" workflow with repository secrets                    |

The LLM evaluation refuses to start without a spending limit and the model's current prices from the provider's pricing page. It meters the tokens the provider reports. It stops before a case whose worst case could exceed the limit, and records calls, tokens and cost with the results in `evals/results/`.

The dataset, [`evals/claims.jsonl`](evals/claims.jsonl), has 21 synthetic claims that I wrote and labelled. They cover:

- every policy rule
- foreign currencies
- an unreadable receipt
- a duplicate
- a prompt-injection attempt

That's enough to catch regressions, not to claim accuracy.

**No model scores are published yet.** They'll appear here only from a measured run, with the model, date, cost and dataset version.

## Tests

`npm test` covers:

- every policy rule
- the workflow, including a restart while a claim waits and a concurrent second decision
- the extractor against a fake model: grounding, retries after invalid output, provider errors
- the HTTP API
- the evaluation metrics, the token meter and the budget

## Troubleshooting

| Symptom                                                                   | Cause and fix                                                                                          |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `Invalid environment configuration: …`                                    | Set the listed variables in `.env`. `LLM_MODEL` has no default on purpose.                             |
| `401` on `/reviews/pending` or `/review`                                  | Send `Authorization: Bearer <REVIEW_API_TOKEN>`.                                                       |
| `503` with a `claimId`                                                    | The provider failed (network, quota, key). The claim is saved; call `POST /claims/<id>/retry` later.   |
| Every receipt goes to human review, with "does not appear on the receipt" | The model returned totals that aren't printed on the receipts. Check the model and the receipt format. |
| `npm run eval -- --extractor llm` exits with 2                            | The spending limit, prices or provider settings are missing; the message says which.                   |
| It exits with 3                                                           | The budget stopped the run. The partial results are saved.                                             |
| `database is locked`                                                      | Two processes share one `DATA_DIR`. Run one instance per directory.                                    |

## Limitations

- One process: the decision lock is in memory, and the checkpoints and claims are SQLite files.
- Exchange rates are fixed reference values for EUR, USD, GBP, CHF, TRY and PLN. Other currencies go to review.
- No employee authentication (expected from a gateway), and reviewers share one token.
- The input is receipt text, not images.
- No measured model accuracy yet, and the 21-case dataset is small.

## Project layout

```text
src/
  domain/        receipt schema, money
  policy/        policy engine, duplicate fingerprint
  extraction/    extractor port, LLM extractor, model factory
  graph/         LangGraph state and graph
  store/         claim store (in memory, SQLite)
  http/          Fastify API
  eval/          evaluation harness, metrics, token budget
scripts/demo.ts  walkthrough without a model
evals/           labelled synthetic claims
docs/adr/        design decisions
```

Changes are listed in [CHANGELOG.md](CHANGELOG.md), and releases are on the [releases page](https://github.com/milad-codes/expense-review-agent/releases).

## Security and licence

See [SECURITY.md](SECURITY.md): what is sent to the model provider, and the checks to make before deploying. Released under the [MIT licence](LICENSE).
