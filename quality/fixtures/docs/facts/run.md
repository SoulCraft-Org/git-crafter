# Run it

Per decision 2 and decisions 1 to 3, run `npm test`, then `npm run build -- --watch`.

```bash
npm run -w @fx/tool lint:docs
npm run -w src/tool build
npm --workspace=@fx/nope run lint:docs
npm run gone:script && npm run lint:docs
npm run --if-present gone:too
npm ci
pnpm run nothing
```

See decisions 2, 4 and 5, and Decision 9.

Ranges count each number: decisions 3 to 5, and decisions 1 and 2, 2026-01-02 stops at 2.

Code and comments do not count: `decision 7` <!-- decision 8 -->.

Paths: `node src/app.txt --flag`, `python3 tools/missing.py`, `src/build/out.js`.

    cat facts/gone.md
