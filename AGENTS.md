# Project instructions

Use simple, direct English. Follow CONTRIBUTING.md for commands and compatibility rules.

- Keep relay wire operations in the Applesauce transport.
- Verify signed events before exposing data from any transport.
- Enforce author ownership for table writes.
- Preserve partial-write data and receipts when an operation fails.
- Do not turn relay acknowledgement into a claim of global or permanent storage.
- Update the documented protocol when record encoding changes.
- Run npm run check after a meaningful SDK change.
