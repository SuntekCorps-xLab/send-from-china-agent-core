# Public Product Identifier Contract

The publisher, not the gateway, assigns every `public_id`.

- A public identifier is an opaque 22-character base62 string derived with a
  user-owned keyed one-way function.
- It has no unkeyed, lexical, sequential, or reversible relationship to a
  private product, listing, supplier, warehouse, or platform identifier.
- The gateway only validates and returns `public_id`; it never generates, decodes, or resolves one to a private identifier.
- The key exists only in the user's publishing environment and is never passed
  to the gateway or written to an artifact.
- The reference publisher derives stable identifiers without storing a mapping
  table. A private deployment may keep its own mapping, but it must never be
  committed to this repository.

Changing the key changes every identifier. Rotate it only as a planned breaking
change with an explicit downstream retention and migration policy.
