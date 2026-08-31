# Data Access

## Purpose

Hartlib limits access to restricted content. The reachable demo uses one
active visitor session, one chat, authorized public-source documents, saved
memories, and durable AI evidence. Access is checked at the API boundary and
rechecked at every content boundary.

## Data classes

Operational metadata includes session status, source metadata, run status,
usage counts, activity codes, timings, error codes, and job state.

Restricted content includes user questions and answers, selected conversation,
saved memories and revisions, retrieval plans and previews, selected passages,
web quotations, context manifests, provider output, citations, and run-owned
source uses. Smithers task inputs and outputs are restricted workflow data and
are not API data.

Source rows retain metadata and immutable document snapshots. The worker reads
content only for an accepted run scope. It sends the minimum selected text to
the configured provider and stores exact hashes and ranges needed to validate
the answer. Public projections contain no prompt, provider body, SQL, private
identity, or stack trace.

## Active-session boundary

`hartlib_demo` is HttpOnly, SameSite=Lax, Path=/, and has a 30-day max age.
Health, session bootstrap, and exact reset replay are the only exceptions to
the active-session requirement. Bootstrap keeps an existing cookie only when
the matching session row is active. Reset revokes the predecessor before it
returns and gives the client a server-minted successor cookie without exposing
either visitor ID.

Every chat, source, document, memory, debug, mutation, and SSE request checks
the active session and owner boundary. A revoked cookie cannot read old rows,
open an old stream, or mutate a successor. The successor starts with an empty
chat and empty client state.

## AI data flow

The acceptance transaction snapshots exactly `userId`, `chatId`, `companyId`,
`publicSourceIds`, `memoryMode`, `memoryRevisionIds`, web state, provider and
endpoint identity, model IDs, web transport, and allowed domains. The snapshot
is strict, sorted, immutable, and never rebuilt from mutable grants.

Retrieval searches only the accepted public-source rows and older messages in
the same chat. The provider sees run-local result IDs and bounded previews.
Code retains canonical identities, hashes, source ranges, and authorization
proof in private run-owned rows. Citation text is returned only after code
validates the exact source map and range.

Memory reads use opaque IDs and exact revisions. A stopped or failed run never
applies memory. Tombstone and revert preserve the revision chain. Memory
mutation checks the expected head revision and reports a typed conflict.

Web research is opt-in and disabled when deployment, company, transport, or
allowlist gates fail. Captured URL, time, quotation, and usage counts are
retained as restricted run data. The public debug response contains counts and
safe codes, not restricted content.

## Retention and deletion

Visible message deletion removes one row after active-run reconciliation. Its
paired row, run, source map, source uses, observations, exposures, usage, and
memory evidence remain. Editing the last visible question supersedes its run,
removes only the old assistant row, and creates one replacement run.

Reset creates one successor and one `demo_identity_purge` job. The job stores
payload exactly `{ visitorId }`, has a unique key derived from that UUID, keeps
attempts and `last_error`, caps delay, and has no attempt ceiling. It cancels
old queued and active work, waits or retries until workers yield, and deletes
the predecessor identity graph in foreign-key order. It never deletes its own
job row. The operation row remains successor-owned and loses its predecessor
foreign key when purge removes the old session.

The purge graph includes sessions, users, companies, source settings, chats,
messages, runs, source evidence, usage, observations, exposures, memories,
workflow rows, and job references. Foreign-key order and post-purge queries
prove that no old identity data remains and that the successor cannot see it.

## Staff and support access

Normal tools expose operational metadata only: status, counts, timings, usage,
safe errors, and configuration. They do not expose prompts, answers, source
text, memories, web quotations, or provider bodies. The shipped demo has no
support, billing, export, notification, or account-admin route. Any future
restricted-support workflow must add a separate reviewed contract and must not
weaken the active-session or owner boundary.

## Proof

Schema tests reject unknown keys and cross-owner identifiers. Domain and worker
integration tests use real PostgreSQL. Playwright proves response loss,
concurrent reset operations, immediate revocation, stream closure, successor
isolation, and full purge. Source, route, bundle, storage, and dependency scans
prove that no unregistered browser storage or deleted product capability ships.
