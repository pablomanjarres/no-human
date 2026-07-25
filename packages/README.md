# packages/

Shared libraries consumed by `apps/*` and by each other. Never deployed on
their own, always `private: true`, always ESM.

Each package builds with `tsc -p tsconfig.build.json` into `dist/` and exposes
`dist/` through its `exports` map, with `src/` as the dev fallback. Turbo's
`^build` dependency means a consumer's typecheck waits for its dependencies'
declarations.

`core/` is a placeholder that pins these conventions — copy its shape.
