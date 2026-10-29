# expense-review-agent

[![CI](https://github.com/milad-codes/expense-review-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/milad-codes/expense-review-agent/actions/workflows/ci.yml)
![LangGraph.js](https://img.shields.io/badge/LangGraph.js-1.x-1C3C3C)
![Node 22](https://img.shields.io/badge/node-22-339933)
![License: MIT](https://img.shields.io/badge/license-MIT-blue)

An AI agent that reviews employee expense claims, built with **LangGraph.js**. It reads messy receipt text with an LLM,
applies company policy with deterministic code, decides routine claims on its own and **pauses for a human reviewer**
on everything else — for as long as it takes, across restarts.

The design rule: **the model extracts facts, code makes decisions, people handle exceptions.**

## How a claim flows

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

```mermaid
sequenceDiagram
  participant E as Employee app
  participant A as Agent API
  participant G as LangGraph thread (SQLite checkpoints)
  participant R as Reviewer
  E->>A: POST /claims (receipt text)
  A->>G: invoke(thread_id = claimId)
  G-->>A: interrupted at human_review (OVER_LIMIT)
  A-->>E: 201 { status: "needs_review" }
  Note over G: process may restart; state is in SQLite
  R->>A: GET /reviews/pending
  R->>A: POST /claims/:id/review { approve, comment }
  A->>G: invoke(Command{ resume })
  G-->>A: finalize → approved
```

## What it demonstrates

| Concern                      | Implementation                                                                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Structured extraction        | `withStructuredOutput` with a zod schema; works with OpenAI and Anthropic; the model can _decline_ an unreadable receipt instead of guessing                  |
| Hallucinated numbers         | the extracted total must be printed on the receipt (`48,60`, `1.234,50`, `$1,234.50` …), otherwise a person checks it                                         |
| Prompt injection in receipts | receipt text is treated as data; decisions never come from the model (an injection case is in the eval set)                                                   |
| Policy                       | pure, unit-tested function: category limits, alcohol deduction, submission window, weekend rules, duplicates, approval limit — every rule explains itself     |
| Human-in-the-loop            | `interrupt()` with a zod response schema; invalid decisions are rejected and the claim keeps waiting                                                          |
| Durability                   | one LangGraph thread per claim, SQLite checkpointer; a test closes everything and resumes the review in a new process                                         |
| Failure handling             | provider outages are not mistaken for unreadable receipts: the API answers `503`, the claim is kept and `POST /claims/:id/retry` resumes from the failed step |
| Concurrency                  | two reviewers cannot both decide the same claim (tested)                                                                                                      |
| Evaluation                   | 21 labelled claims; gold-extraction run is a CI gate, LLM run reports extraction and routing quality                                                          |
| Observability                | pino logs with per-node timings and redaction, audit trail per claim, optional LangSmith tracing                                                              |

## Policy

| Rule                                                                                                                                                                                                                                     | Severity                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Duplicate (same employee, merchant, date, amount) · receipt after submission date · older than 90 days · nothing reimbursable                                                                                                            | **reject**                         |
| Meal > €60 per person · hotel > €180 per night · taxi/train > €150 · flight > €800 · office > €200 · software > €100 · total > €250 · weekend meal/taxi · no business purpose · unknown currency · category "other" · unreadable receipt | **human review**                   |
| Alcohol                                                                                                                                                                                                                                  | deducted, the rest can be approved |

## API

| Method | Path                 |                                                                                                                                                            |
| ------ | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/claims`            | `{ employeeId, receiptText, businessPurpose }` → `201` with status `approved`, `rejected` or `needs_review`; `503` + `claimId` if the LLM provider is down |
| GET    | `/claims/:id`        | full view incl. receipt, findings, review request, outcome and audit trail                                                                                 |
| POST   | `/claims/:id/retry`  | resume a failed claim from its checkpoint                                                                                                                  |
| GET    | `/reviews/pending`   | reviewer token; claims waiting for a decision                                                                                                              |
| POST   | `/claims/:id/review` | reviewer token; `{ decision: "approve" \| "reject", reviewer, comment }`                                                                                   |
| GET    | `/health`            |                                                                                                                                                            |

Errors are `application/problem+json`.

## Run it

```bash
cp .env.example .env            # choose LLM_PROVIDER, LLM_MODEL and set the API key
npm ci
npm run dev                     # http://localhost:3000

# or as a container (SQLite on a volume)
docker build -t expense-review-agent .
docker run -p 3000:3000 --env-file .env -v era-data:/data expense-review-agent
```

```bash
curl -s localhost:3000/claims -H 'content-type: application/json' -d '{
  "employeeId": "emp-42",
  "businessPurpose": "Dinner with the ACME CTO to close the contract",
  "receiptText": "TANTRIS München\n21.10.2026 Gäste: 2\n2x Menü 340,00\nGESAMT EUR 380,00"
}'
```

## Evaluation

```bash
npm run eval -- --extractor gold   # labelled receipts → policy + workflow only (CI gate: 100 % route accuracy)
npm run eval -- --extractor llm    # real model: extraction accuracy per field, route accuracy, finding F1, latency
```

The dataset (`evals/claims.jsonl`) covers routine claims, every policy rule, foreign currencies, an unreadable receipt,
a duplicate and a prompt-injection attempt. Results are written to `evals/results/`. No model scores are published
here: they depend on the model you choose, so run the LLM evaluation with your own key.

## Tests

```bash
npm test        # 83 tests: policy, workflow, persistence across restarts, extractor (fake model), HTTP API, metrics
```

## Project layout

```
src/
  domain/        receipt schema, money
  policy/        policy engine, duplicate fingerprint
  extraction/    extractor port, LLM extractor, model factory
  graph/         LangGraph state and graph
  store/         claim store (in-memory, SQLite)
  http/          Fastify API
  eval/          evaluation harness and metrics
  review-service.ts, server.ts
evals/claims.jsonl
docs/adr/
```

Design decisions: [0001 the model extracts, code decides](docs/adr/0001-model-extracts-code-decides.md) ·
[0002 durable threads for human review](docs/adr/0002-durable-threads-for-human-review.md)

## Limits

- Single-process locking; several instances would need a database lock or LangGraph Platform's thread queue.
- Fixed reference exchange rates.
- No employee authentication (expected from an SSO gateway); reviewers share one token.

## License

MIT
