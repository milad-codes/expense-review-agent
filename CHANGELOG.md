# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning: [SemVer](https://semver.org/).

## [Unreleased]

### Fixed

- The grounding check accepted a total that only appeared inside a larger printed number (4.86 in `14,86`); totals
  must now be printed as whole amounts. Apostrophe thousands separators (`1'234.50`) are recognised (#9)

## [0.1.0] — 2026-10-29

### Added

- Deterministic expense policy engine with explainable findings (#5)
- LangGraph review workflow with human-in-the-loop interrupts and SQLite checkpoints (#6)
- Fastify API, LLM receipt extraction with grounding check, retry after provider failures, container image (#7)
- Evaluation dataset and harness with a CI regression gate; README and ADRs

[0.1.0]: https://github.com/milad-codes/expense-review-agent/releases/tag/v0.1.0
