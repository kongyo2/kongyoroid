# kongyoroid for agents

`@kongyo2/kongyoroid` turns Japanese text into speech and scores into singing. Every command reads flags or JSON and writes exactly one JSON object per line, so an agent never has to parse prose.

## Decide the engine first

| Situation | Engine | Notes |
| --- | --- | --- |
| Default | `formant` | Built-in engine: kana text or kana notation, deterministic, no external service. |
| Character voices, kanji text, readings, user dictionary | `voicevox` | Needs a running VOICEVOX ENGINE (default `http://127.0.0.1:50021`). Selected automatically when `speaker`, `singer`, or `teacher` is given, or with `engine: "voicevox"`. |
| Either | `auto` | Uses voicevox when the endpoint answers within 3 s, otherwise formant; a negative probe is retried after 30 s. The result JSON reports `engine`. |

Check the engine with `kongyoroid doctor` (exit 0 when reachable, 3 otherwise). Start VOICEVOX with the desktop app or `docker run --rm -p 127.0.0.1:50021:50021 voicevox/voicevox_engine:cpu-latest`.

## Commands

```
kongyoroid speak --text "こんにちは" -o hello.wav                 # built-in formant engine
kongyoroid speak --text "こんにちは" --speaker ずんだもん -o zunda.wav  # VOICEVOX (a style selects it)
kongyoroid sing --lyrics "ドレミ" --melody "C4 D4 E4" --beats "1 1 2" -o scale.wav
kongyoroid render --input request.json -o out.wav        # any JSON request; "-" reads stdin
kongyoroid batch --input jobs.jsonl --output-dir out      # {"id":"a","request":{...}} per line
kongyoroid reading --text "橋の端"                         # engine reading as kana notation
kongyoroid voices --kind speech|song|all [--query めたん]  # style ids, characters, types
kongyoroid dict add --surface 金曜 --pronunciation キンヨウ --accent 0
kongyoroid play out.wav
kongyoroid schema | kongyoroid capabilities
```

Success goes to stdout: `{"ok":true,"path":"/abs/out.wav","engine":"voicevox","styles":{"speaker":{"id":3,...}},"kana":"コンニチワ'","durationSeconds":1.2,"sha256":"...",...}`.
Failure goes to stderr: `{"ok":false,"error":{"code":"ENGINE_UNAVAILABLE","message":"...","hint":"...","path":"$.speaker","retryable":true}}`.

Exit codes: `0` ok, `1` internal, `2` invalid input, `3` engine problem, `4` file or player problem, `130` cancelled. `batch` exits with the worst per-line code and keeps going.

`-o -` writes WAV bytes to stdout and the JSON to stderr (`kongyoroid speak -t あ -o - | aplay`). Without `-o` a file named `kongyoroid-<kind>-<hash>.wav` is created in the working directory. Existing files are never overwritten without `--force`.

## Request JSON (see `kongyoroid schema`)

Speech:

```json
{ "kind": "speech", "text": "今日はいい天気ですね？", "speaker": "ずんだもん/ノーマル",
  "speed": 1.0, "pitch": 0, "intonation": 1, "volume": 1, "prePause": 0.1, "postPause": 0.1,
  "pauseScale": 1, "upspeak": true, "split": "sentence", "sampleRate": 24000 }
```

Song:

```json
{ "kind": "song", "tempo": 120, "singer": "ずんだもん",
  "notes": { "lyrics": "きらきらぼし", "melody": "C4 C4 G4 G4 A4 A4 G4 ~", "beats": "1 1 1 1 1 1 1 1" } }
```

Rules that VOICEVOX enforces and kongyoroid checks before calling the engine:

- One kana mora per pitched note (`ア`, `キャ`, `ン`, `ッ`). Multi-mora lyrics are rejected with the path of the offending note.
- `R` in the melody is a rest and consumes no lyric. `~` (or the lyric `ー`) holds the previous vowel on a new note.
- Keys are note names (`C4`, `F#4`, `Bb3`) or MIDI integers (60 = C4). `transpose` shifts everything in semitones.
- Unknown properties are rejected (`$.speeed` style paths). Numbers outside their documented range are rejected.

## Controlling readings (VOICEVOX)

1. `kongyoroid reading --text "橋の端"` returns the engine's reading, e.g. `ハシノ'/ハシ'`.
2. Fix it with `kana` notation: katakana, `/` between accent phrases, `、` for a pause, `'` after the accent nucleus, `_` before a devoiced vowel, `？` for a question. `kongyoroid speak --text "橋の端" --kana "ハシノ'/ハシ'"`. Hiragana and long-vowel marks are accepted and normalized (`すーぱー'` becomes `スウパア'`) before the engine sees them.
3. Make it permanent with the user dictionary: `kongyoroid dict add --surface 端 --pronunciation ハシ --accent 1 --word-type COMMON_NOUN`.

## Library

```ts
import { Kongyoroid } from "@kongyo2/kongyoroid";

const agent = new Kongyoroid({ endpoint: "http://127.0.0.1:50021", speaker: "ずんだもん" });
const speech = await agent.speak("こんにちは");           // RenderResult { audio: Uint8Array (WAV), info, styles, kana, ... }
const song = await agent.sing({ notes: { lyrics: "ドレミ", melody: "C4 D4 E4" } });
const reading = await agent.reading("橋の端");           // { kana, phrases, speaker }
const styles = await agent.voices("song");
```

`render(request: unknown)` validates untrusted JSON and throws `KongyoroidError` with `code`, `path`, `hint`, `retryable`. Pass `{ signal }` to cancel. Every method is safe to call concurrently; renders are limited by `concurrency` (default 2) and cached by request hash (memory, plus `cacheDir` on disk). Speech cache keys include a digest of the engine's user dictionary, so dictionary edits never serve stale audio.

## Environment variables

`KONGYOROID_ENDPOINT` (alias `VOICEVOX_URL`), `KONGYOROID_ENGINE`, `KONGYOROID_SPEAKER`, `KONGYOROID_SINGER`, `KONGYOROID_TEACHER`, `KONGYOROID_CACHE_DIR`. Flags override environment variables.

## Limits

Text up to 20000 characters per request (split into sentence chunks that are synthesized concurrently), 4096 notes per score, 3600 seconds of audio per render (1200 seconds for the formant engine, which encodes in memory), 8 MiB of JSON input, 10000 lines per batch.
