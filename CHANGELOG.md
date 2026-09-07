# Changelog

## 2.0.0

A rebuild around the built-in engine. Rendered audio, the plan JSON, kana notation semantics, and the cache layout all changed; requests written for 1.0.0 still parse (`schemaVersion` 1 is accepted), but they produce different waveforms.

### Breaking

- The built-in formant engine is a new synthesizer (`ENGINE_VERSION` `formant-2.0.0`): every request renders differently from 1.0.0. `PLAN_VERSION` and `SCHEMA_VERSION` are now 2.
- Kana notation: an accent mark is optional and its absence means a flat (平板) phrase; `/` `、` `。` `？` `！` are boundaries with distinct pauses and intonation; a trailing `、` keeps its pause while a trailing sentence mark adds none (trailing silence is `postPause` only). Formatted kana now emits boundary characters, including `。` at sentence ends.
- Text is analysed per sentence by the jpreprocess frontend (`kanji2koe-openjtalk`, a new runtime dependency). Characters the frontend cannot read fail with `UNREADABLE_TEXT` unless `strictReading: false`.
- Song notes are validated more strictly: a continuation (`tie` / `melisma`) must directly follow a pitched note, a tie must keep the key, a lyric cannot be `ッ` alone or end in `ッ`, and `velocity` and `gainDb` are exclusive. Notes shorter than their vowel minimum fail with `NOTE_TOO_SHORT` instead of rendering silently.
- VOICEVOX is no longer probed unless a style is given or `engine` is `voicevox` / `auto`; the client is created lazily.
- The on-disk cache moved to a `kongyoroid-cache/` subdirectory with `.kcache` files and a new key layout; old cache files are ignored.
- Result objects gained `voice`, `requestHash`, `timings`, `adjustments`, `peak`, `rms`, `limitedSamples`, and `engineVersion`; `Reading` phrases carry `accentSource` and `boundary`, and dictionary hits carry `accent` and `source`.
- CLI: `voices`, `doctor`, `reading`, and `dict` work offline against the built-in engine; `--engine all` is accepted by `voices` and `doctor`; `--pitch-semitones` is the preferred pitch control and `--pitch` keeps VOICEVOX `pitchScale` semantics.
- Node 22.18 or newer is required.

### Added

- Japanese text frontend: jpreprocess + NAIST-JDic readings and accents, a pre-normalizer (dates, times, versions, IP-like numbers, units, currency, signs, ranges, `#N`, URLs and e-mail addresses, Markdown markers, width folding with source offsets), a ~500-word technical lexicon with accents (acronyms follow the last-letter rule and are merged into one accent phrase), unreadable-character detection with `sourceSpan` and repair options, and rule-based devoicing for kana input.
- Local dictionaries (`LocalDictionary`, `dictionary` in requests, `--dict-entry`, `--dictionary`, `dict` command with `list` / `add` / `update` / `delete` / `check`): readings plus optional accents, matched by position in the sentence so repeated readings are not confused.
- Speech prosody: Fujisaki phrase and accent commands placed from accent phrases, question rises, final lowering, sentence-wide exclamation emphasis, paragraph pauses, and `intonation` scaling. Mora timing scales uniformly with `speed`, including consonants and glides.
- Synthesizer: LF glottal model with `Rd` control (breathiness, per-voice tension, pressed onsets), two-times oversampled source with a half-band decimator, five-formant cascade with nasal pole and zero, parallel frication branch with per-phoneme spectra, aspiration modulated by the open phase, deterministic jitter, shimmer, and flutter, a continuous soft limiter, and one-millisecond control smoothing. Rendering is independent of block size and identical in synchronous and streaming paths.
- Seven built-in voices (`neutral`, `female`, `male`, `child`, `soft`, `bright`, `deep`) with pitch ranges and hashes.
- Song planner: note ids, ties and melismas with vowel continuity, automatic or explicit re-articulation, per-note velocity or gain, per-note vibrato and portamento, scoops, multi-mora lyrics per note (up to 8), consonant budgeting with borrowing from rests and preceding notes, compression adjustments (`CONSONANT_TAKEN_FROM_NOTE`, `CONSONANT_COMPRESSED`, `CONSONANT_HEAVILY_COMPRESSED`), log-domain pitch curves with hold points, and per-sustain vibrato regions. Compact scores accept `~` and `~G4`; MML input (`t o < > l v n r & [lyric]`) is supported.
- Inspection before rendering: `validate` and `plan` (summary, phonemes, acoustics detail), `compile` + `renderPlan` in the library, `requestHash` / `planHash` / voice hashes, and `--plan-out`.
- Streaming: `speak --stream` with `wav`, `pcm`, and `ndjson` formats, sentence-by-sentence synthesis with look-ahead planning, and `speakStream` / `renderStream` / `renderPcmStream` in the library. Between-sentence pauses match whole-text rendering; the request's `postPause` is emitted once at the end.
- Structured errors with `repairOptions`, `sourceSpan`, `surface`, and `retryAfterMs`; a compact one-line diagnostic format (`--diagnostics compact`); new error codes `UNREADABLE_TEXT`, `NOTE_TOO_SHORT`, `PITCH_OUT_OF_RANGE`, `FRONTEND_UNAVAILABLE`.
- Idempotent output writes (`written` / `unchanged`), in-flight de-duplication of identical renders, a namespaced disk cache with `stats` / `prune` / `clear`, and `capabilities` output listing commands, environment variables, limits, exit codes, and error codes.
- Per-command `--help` with examples, `kongyoroid inspect` pitch analysis, and JSON Schemas (draft 2020-12) for requests, batch jobs, and dictionaries.

### Fixed

- `speed` no longer stretches only vowels: consonants, palatal glides, and pauses scale with it.
- Trailing pause marks in kana are preserved through normalization and round-trip through `formatKanaNotation`.
- VOICEVOX kana validation uses the same notation parser as the built-in engine, and `pitchSemitones` maps to `pitchScale` for VOICEVOX speech.
- Ties and melismas keep a single vowel segment instead of re-attacking, and repeated vowels are re-articulated audibly.
- Song pitch tracks hold each note's pitch until the transition window instead of gliding across whole notes.

## 1.0.0

Initial release: VOICEVOX-backed speech and singing with a first built-in formant engine, JSON CLI, batch mode, caching, and playback helpers.
