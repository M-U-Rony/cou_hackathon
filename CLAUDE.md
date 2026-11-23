# FairPrice BD

Bangla dashboard that flags unusual food-price rises. Python pipeline + quantile model (`pipeline/`, `modeling/`), React/Vite/TS dashboard (`dashboard/`).

## Test-driven development (required)
1. Write a failing test first and run it to see it fail (red).
2. Write the minimum code to make it pass (green), then refactor.
3. Keep ALL tests green before finishing. A bug fix starts with a test that reproduces the bug.
4. If a test exposes a real bug you are not asked to fix, mark it `xfail(strict=True, reason=...)` and report it; do not silently change behaviour.

## Commands
- Python: `pip install -r requirements-dev.txt`, then `python -m pytest` from the repo root (tests in `tests/`, synthetic data only, no model training).
- Dashboard: from `dashboard/`, `npm test` (Vitest + Testing Library, files `src/**/*.test.ts(x)`). Typecheck: `tsc -p tsconfig.app.json --noEmit`.
- Never run `npm install` in `dashboard/node_modules` from a Linux sandbox: it was installed on Windows. Sync to a scratch copy (`rsync -a --exclude node_modules dashboard/ ~/dash-ci/`) and test there. Use `npm install --legacy-peer-deps` if npm 10 crashes on vitest's optional peers.

## Conventions
- Files use CRLF line endings. Edit with tools that preserve them (e.g. Python `open(..., newline='')`); do not retype whole files.
- UI text is Bangla; keep wording consistent with `TONE_BN` and `modeling/explain_bn.py` (`VERDICT_BN`).
- Verify UI changes in the browser at http://localhost:5173 before committing.
