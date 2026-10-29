# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning: [SemVer](https://semver.org/).

## [0.2.0] — 2026-10-29

### Added

- `npm run demo`: three synthetic claims through the real workflow and HTTP API with a restart, no API key needed
- `--extractor llm` requires a spending limit and the provider's prices, meters reported tokens and stops before a case
  could exceed the limit; results include calls, tokens and cost
- Manual GitHub Actions workflow for a measured LLM evaluation with repository secrets

### Changed

- `npm run dev` and `npm start` read `.env` when it exists, as the setup instructions assumed
- README rewritten: problem and scope, decisions with trade-offs, the two evaluation modes side by side, troubleshooting
  and limitations; badges limited to CI, release and licence; new SECURITY.md on data sent to the model provider
- `--extractor gold` is reported as a policy and workflow regression: it no longer prints extraction metrics, which
  are trivially perfect when labels replace the model
- The LLM evaluation no longer needs `REVIEW_API_TOKEN`; model output is capped at 1,024 tokens
- The evaluation set uses fictional merchants and addresses instead of real businesses

### Fixed

- The grounding check accepted a total that only appeared inside a larger printed number (4.86 in `14,86`); totals
  must now be printed as whole amounts. Apostrophe thousands separators (`1'234.50`) are recognised (#9)

## [0.1.0] — 2026-10-29

### Added

- Deterministic expense policy engine with explainable findings (#5)
- LangGraph review workflow with human-in-the-loop interrupts and SQLite checkpoints (#6)
- Fastify API, LLM receipt extraction with grounding check, retry after provider failures, container image (#7)
- Evaluation dataset and harness with a CI regression gate; README and ADRs

[0.2.0]: https://github.com/milad-codes/expense-review-agent/releases/tag/v0.2.0
[0.1.0]: https://github.com/milad-codes/expense-review-agent/releases/tag/v0.1.0
