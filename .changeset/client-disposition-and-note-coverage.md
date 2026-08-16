---
'@tapflowio/mcp-server': minor
'@tapflowio/flow-runner': minor
---

Say why a session-scoped failure happened in four places that did not, and declare what each client does with every message it can receive

Both clients decorate a failure with what the relay has told them about that session — so a caller reading
"No booted device" also learns that the agent reconnected and cleared its binding. The mechanism was shared
and the coverage was not.

What a user can observe:

- **A refused `connect_device` now says which of the three refusals it was.** It used to report the relay's
  prose alone, so "the device is open in another browser session" and "this Mac is over its resource
  ceiling" arrived as sentences a model had to guess at rather than the closed reason it can act on.
- **A failed screenshot or UI-tree query says what is wrong with the *session*.** They reported what the
  relay said about the request and nothing about the session it belonged to — so a query failing because
  the agent reconnected and dropped its device binding read as a bare 409. `flow-runner`'s screenshot was
  worse: an HTTP status alone. That is the least useful moment for it, since a screenshot is usually being
  taken to explain a step that has already failed.

Those four were never reverted; they were never written. A static check now holds every construction in
both clients to reaching the session record, which is what #546 asked for — and finding the rule took three
attempts, because anchoring on `throw`, on the error's class, or on the method's name each let a real case
through. Anchoring on the construction and asking whether the expression reaches the record covers the
rejections inside closures too, which is where the highest-leverage one lives: a single deleted call in
`waitFor` would strip the cause from every request's timeout in the file.

Each package also gains an `inboundDisposition` module: a declaration, per message a browser socket can
receive, of whether this client reads it and what it does — or why it deliberately does not. The compiler
owns the key set, so a message added to the wire breaks both files until someone decides. Unlike the
dashboard's equivalent, the check runs in both directions: an entry claiming a message is ignored fails if
anything in the package starts reading it.
