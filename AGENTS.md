# Request context observer

One MIT repository, three independently usable entrypoints:

- `src/server.ts`: capture and query backend.
- `src/tui.tsx` and `src/ui/`: optional TUI viewer and shared presentation logic.
- `extension/`: optional Chrome/Edge viewer.
- `src/contract.ts`: shared RPC contract.

Repository/package: `opencode-context-observe`.
Runtime plugin ID: `o3p.context.observe` (server and TUI use the same ID in separate host registries).
Command IDs: `o3p.context.observe.<action>`.

Coordinate shared-contract changes with both viewers. Do not change production configuration without explicit approval. Never restart the service hosting the current agent. Use synthetic fixtures in isolated environments, not private prompts or credentials. Never suppress type errors or weaken tests.
