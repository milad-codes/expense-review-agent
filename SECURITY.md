# Security

## Reporting a problem

Please report suspected vulnerabilities privately through GitHub: **Security → Report a vulnerability** in this
repository. Don't open a public issue for them. This is a personal project, so there is no guaranteed response time,
but I read every report.

## Where data goes

- **Receipt text goes to the LLM provider** you configure (OpenAI or Anthropic) for extraction, and to LangSmith if you
  turn tracing on. Receipts can contain names and card fragments. Check the provider's data-handling terms before
  sending real receipts.
- Claims, findings, review decisions and the audit trail are stored in SQLite files under `DATA_DIR`.
- Logs redact the `Authorization` header and receipt text.

## How the design limits what the model can do

The model only fills in a receipt schema. Approve and reject decisions come from deterministic policy code, so
instructions hidden in a receipt can't approve a claim. The evaluation set includes such a case. A total that isn't
printed on the receipt sends the claim to a person.

## Before you deploy it

- Set a long random `REVIEW_API_TOKEN` and keep API keys in a secret store, never in the repository.
- Put the service behind a gateway that authenticates employees; the API itself does not.
- Terminate TLS in front of the service.
- Back up `DATA_DIR`: it holds every claim and every waiting review.

## Scope

A portfolio project maintained by one person. It has not had an external security review.
