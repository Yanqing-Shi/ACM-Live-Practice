# ICPC Live Project Status And Updates

Last updated: 2026-05-15

This file is now the project status index. Detailed status has been split into
agent-ready module briefs under `docs/agent-modules/`.

Use this file to decide which module a future sub-agent should own. Use the
module files as the handoff context for implementation, testing, or review.

## Product Snapshot

ICPC Live is a Web MVP plus an early VS Code extension MVP for remote
ICPC/UCup-style team practice.

The core rule is backend-enforced:

- One active controller per room.
- Only the controller can edit, create, rename, delete, change stdin mode/input,
  or run code.
- Non-controllers can observe, open files read-only, view members, view run
  history, and request control.

## Agent Module Map

| Module | Brief | Suggested owner |
| --- | --- | --- |
| Product and permissions | `docs/agent-modules/product-and-permissions.md` | Product rules, room roles, controller semantics |
| Web workspace | `docs/agent-modules/web-workspace.md` | Frontend room UI, empty workspace behavior, browser client |
| Backend state and export | `docs/agent-modules/backend-state-and-export.md` | Room state, persistence, snapshots, ZIP export, run history |
| Audit policy | `docs/agent-modules/audit-policy.md` | Audit surface constraints and startup cleanup |
| Deployment and operations | `docs/agent-modules/deployment-and-ops.md` | Docker, Render, health checks, public service notes |
| VS Code extension | `docs/agent-modules/vscode-extension.md` | Extension features, permissions, UI layout, manual test flow |
| Validation | `docs/agent-modules/validation.md` | Current checks and expected commands |

## Recommended Sub-Agent Split

For parallel work, keep write ownership disjoint:

- Backend agent: `backend/src/**`, backend tests, persistence/export behavior.
- Frontend agent: `frontend/**`, web UI behavior, browser room interactions.
- VS Code extension agent: `vscode-extension/**`, root `.vscode/**` only when
  launch/tasks behavior changes.
- Deployment agent: `Dockerfile`, `.dockerignore`, `render.yaml`,
  `PUBLIC_DEPLOY.md`, deployment notes.
- Documentation agent: `README.md`, `PROJECT_STATUS_AND_UPDATES.md`,
  `docs/agent-modules/**`.

When assigning a sub-agent, give it:

1. The relevant module brief.
2. The source paths it owns.
3. The validation command from `docs/agent-modules/validation.md`.
4. The invariant that controller permissions are enforced by the backend.

## Current Validation State

Backend:

```powershell
cd backend
npm.cmd test
```

Current backend test count:

```text
35 passing tests
```

VS Code extension:

```powershell
cd vscode-extension
npm.cmd test
```

Current extension test count:

```text
19 passing tests
```

Compile-only check:

```powershell
cd vscode-extension
npm.cmd run compile
```

The extension TypeScript compile currently passes.

## Notes For Future Updates

- Keep this file short and navigational.
- Put detailed feature status in the matching module file.
- If a change crosses module boundaries, update every affected module brief.
- If a new sub-agent ownership area emerges, add a new file under
  `docs/agent-modules/` and list it in the module map above.
