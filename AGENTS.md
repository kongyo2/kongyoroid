# AGENTS.md

Two audiences: agents that **use** kongyoroid to produce Japanese speech and singing, and agents that **change** this repository.

## Using kongyoroid

kongyoroid is a JSON-first CLI (`kongyoroid <command>`) and a typed ESM library (`@kongyo2/kongyoroid`). The built-in formant engine is the default and needs nothing else installed. VOICEVOX is optional and only used when a `speaker`, `singer`, or `teacher` style is given.

### The loop

1. `kongyoroid validate --text "…"` (or `--input request.json`) checks structure and semantics without rendering and returns `renderable`, an estimate (`durationSeconds`, `wavBytes`), warnings, and `requestHash`.
2. `kongyoroid plan --text "…"` returns the reading (`plan.reading.kana`, accent phrases with `accentSource`), mora and note timing, and the pitch range. Read it before rendering long or important text.
3. `kongyoroid speak`, `sing`, or `render` writes the WAV and prints one JSON line with `path`, `sha256`, `frames`, `kana`, `warnings`, and `adjustments`.
4. On an error (`ok: false`, exit code 2), apply `error.repairOptions[].action` or the `hint`, then retry. Exit 3 means an engine problem (start VOICEVOX or run `doctor`), exit 4 an I/O problem (for example an existing file with different content: pass `--force`).

### Rules of thumb

- Branch on `error.code`, `error.path`, and `repairOptions[].action`, never on message text.
- Prefer `text` for ordinary Japanese. Use `kana` (AquesTalk-style notation: `ハシ'ノ/ハシデ/ハ'シヲ/_ツカウ。`) only to fix a reading or when the text contains characters the frontend cannot read (`UNREADABLE_TEXT`). Kana input is read literally, so keep punctuation in it.
- Fix recurring readings with a dictionary (`--dict-entry surface=READING:ACCENT`, `--dictionary file.json`, or `dictionary: [...]` in the request) instead of rewriting text. `kongyoroid reading` shows which entries fired (`dictionaryHits`) and where each accent came from.
- For songs, give one mora per pitched note or use `~` (tie) and `~G4` (melisma) to hold vowels. Watch `adjustments` (`CONSONANT_COMPRESSED`) and fix `NOTE_TOO_SHORT` by lengthening notes, lowering the tempo, or holding the previous vowel.
- For live output pipe tokens into `kongyoroid speak --input - --stream --output - --format pcm` (s16le, mono, 24 kHz by default) or `--format ndjson` (sentence events plus base64 audio blocks).
- Identical requests produce identical bytes. Rewriting an unchanged file is a no-op (`unchanged: true`); use `requestHash` to deduplicate work and `--cache-dir` to reuse renders across processes.
- `kongyoroid capabilities` and `kongyoroid schema` describe the contract; `kongyoroid <command> --help` lists flags with examples.

Full reference: [docs/cli.md](docs/cli.md). Library entry point: `new Kongyoroid(options)` with `speak`, `sing`, `render`, `validate`, `plan`, `compile` + `renderPlan`, `speakStream`, `reading`, `voices`, `doctor`, `inspect`.

## Working on this repository

- Node 22.18+, TypeScript run directly by Node (`.ts` type stripping). Sources are ESM with explicit `.ts` import specifiers. No build step is needed to run tests or the CLI (`node src/cli.ts …`).
- `npm run check` must pass before a commit: `tsc` (strict, `isolatedDeclarations`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), the test typecheck, `oxlint --deny-warnings`, `prettier --check`, the comment scanner, and `node --test`. CI also runs `npm run lint:typed`, `npm run build`, and `npm run verify:package` (packs the tarball and runs a consumer).
- **No comments in `src/`, `test/`, or `scripts/`** (the comment scanner fails the build). Put rationale in [docs/dsp.md](docs/dsp.md) or the CHANGELOG and use descriptive names instead.
- Every exported function and constant needs an explicit type annotation (`isolatedDeclarations`). Avoid `as` casts and `any`; the type-aware lint rejects unsafe assertions. Narrow with guards from `src/validate.ts`.
- Tests live in `test/*.test.ts` and use `node:test`. Audio behaviour is tested by measurement (pitch in cents, RMS, spectral peaks, block-size independence), not by golden files. Keep tests deterministic; the mock VOICEVOX engine is in `test/helpers/mock-engine.ts`.
- The public contract is `src/schema.ts` (JSON Schema), `src/errors.ts` (error and exit codes), `src/cli/help.ts` (help text), and `src/index.ts` (exports). Changing any of them is a user-visible change: update `docs/cli.md`, the README, the examples under `examples/`, and `CHANGELOG.md` in the same commit.
- Waveform changes (anything under `src/synth/`) must keep `test/synth.test.ts` and `test/song.test.ts` passing; bump `ENGINE_VERSION` in `src/version.ts` when rendered audio changes, and `PLAN_VERSION` when the plan JSON shape changes.
- The Japanese frontend (`kanji2koe-openjtalk`) is loaded lazily and cached per process. Reading tests in `test/frontend.test.ts` pin real readings; when the dependency is upgraded, review those expectations against `kongyoroid reading` output rather than loosening them.
