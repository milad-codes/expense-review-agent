# Contributing

1. Open an issue describing the problem first.
2. Branch from `main` using a type prefix: `feat/`, `fix/`, `perf/`, `test/`, `refactor/`, `docs/`, `chore/`.
3. Keep commits focused and use [Conventional Commits](https://www.conventionalcommits.org/) messages.
4. Before opening a pull request run `npm run lint && npm run format:check && npm run typecheck && npm test && npm run eval -- --extractor gold --min-route-accuracy 1`.
5. Fill in the pull request template (problem, approach, architecture, testing, trade-offs). Policy changes need updated
   labels in `evals/claims.jsonl`; non-obvious decisions get an ADR in `docs/adr`.
