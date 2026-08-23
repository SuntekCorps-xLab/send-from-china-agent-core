# Public Product Identifier Contract

The publisher, not the gateway, assigns every `public_id`.

- A public identifier is an opaque, randomly generated 22-character base62 string.
- It has no mathematical, lexical, or reversible relationship to a private product, listing, supplier, warehouse, or platform identifier.
- The gateway only validates and returns `public_id`; it never generates, decodes, or resolves one to a private identifier.
- The mapping between public and private identifiers exists only in the private publishing environment.
- Mapping tables, mapping examples, private identifiers, and identifier-generation code must not be committed to this repository.

Changing an identifier requires publishing a new snapshot and handling the old identifier according to the downstream retention policy.
