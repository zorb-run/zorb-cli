---
"zorb": patch
---

Drop the `./` prefix from the `bin.zorb` path in `package.json`. npm's publish normalisation was stripping the prefix and emitting a misleading "script name `bin/zorb.cjs` was invalid and removed" warning — the entry was actually rewritten in place. With the prefix gone, input and normalised form match and the warning stops firing.
