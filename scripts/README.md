# scripts/

Repo-level operational scripts: deploys, secret pulls, code generation, one-off
maintenance. Shell (`.sh`) or Node ESM (`.mjs`) — no build step, no TypeScript.

Anything invoked from `package.json` root scripts or from CI lives here so the
workspace packages stay free of orchestration logic.
