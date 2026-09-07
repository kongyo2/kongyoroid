# CLI リファレンス

すべてのコマンドは標準出力に **1 行 1 JSON** を書き、失敗時は標準エラーに `{"ok":false,"error":{...}}` を書いて 0 以外で終了します。`--output -` で音声を標準出力へ流す時だけ、JSON は標準エラーに出ます。`kongyoroid <command> --help` で各コマンドのフラグと実例を表示します。

## 共通の約束

### 終了コード

| コード | 意味 | 典型的な原因 |
| --- | --- | --- |
| 0 | 成功 | |
| 1 | 内部エラー | バグ。`error.detail` を添えて報告 |
| 2 | 入力エラー | 不正な JSON、未知のプロパティ、読めない文字、短すぎる音符、音域外 |
| 3 | エンジン利用不可 | VOICEVOX 未起動・タイムアウト、フロントエンドのロード失敗 |
| 4 | 入出力エラー | 既存ファイルの上書き拒否、読めない入力ファイル、プレイヤー無し |
| 130 | 中断 | SIGINT / AbortSignal |

### エラーオブジェクト

```json
{"ok":false,"error":{
  "code":"UNREADABLE_TEXT",
  "message":"Unreadable text \"彁\": the frontend has no reading for it and would drop it silently.",
  "retryable":false,
  "path":"$.text",
  "hint":"Give the reading in kana, add a dictionary entry with surface and reading, or remove the characters.",
  "detail":{"unreadable":[{"surface":"彁","sourceSpan":{"start":0,"end":1,"unit":"unicode-code-point"}}]},
  "repairOptions":[
    {"action":"provide-kana","description":"Pass the whole pronunciation in the kana field.","path":"$.kana"},
    {"action":"add-dictionary-entry","description":"Add a dictionary entry { surface: \"彁\", reading: <katakana> }.","path":"$.dictionary"},
    {"action":"remove-characters","description":"Remove or rewrite the unreadable characters in text.","path":"$.text"}],
  "sourceSpan":{"start":0,"end":1,"unit":"unicode-code-point"},
  "surface":"彁"}}
```

| フィールド | 内容 |
| --- | --- |
| `code` | `INVALID_INPUT` `UNSUPPORTED_TEXT` `UNREADABLE_TEXT` `NOTE_TOO_SHORT` `PITCH_OUT_OF_RANGE` `FRONTEND_UNAVAILABLE` `ENGINE_UNAVAILABLE` `ENGINE_HTTP` `ENGINE_REJECTED` `ENGINE_PROTOCOL` `TIMEOUT` `QUEUE_FULL` `IO_ERROR` `PLAYER_UNAVAILABLE` `ABORTED` `INTERNAL` |
| `path` | 問題の場所。リクエストは `$.notes[1].beats`、フラグは `$flags.speed`、標準入力は `$.input` |
| `retryable` / `retryAfterMs` | そのまま再送して直る可能性があるか |
| `repairOptions[]` | `action` (`provide-kana` `add-dictionary-entry` `remove-characters` `increase-duration` `allow-consonant-compression` `use-vowel-continuation` `lower-pitch` `raise-sample-rate` `clamp-pitch` `shorten-input` `split-input` `use-force` `start-engine` `use-formant-engine` `retry-later`) と説明、対象 `path` |
| `sourceSpan` / `surface` | 元テキスト内の位置 (Unicode コードポイント単位、`end` は排他的) と該当文字列 |
| `detail` | コード固有の構造化情報 (`availableMs` / `requiredMs` / `noteId`、`unreadable[]`、`alignment` など) |

### 警告と助言

成功時の JSON には `warnings[]` (`severity`: `warning` / `advice`) と `adjustments[]` (自動で変えたこと) が入ります。主なコード:

| コード | 種別 | 意味 |
| --- | --- | --- |
| `UNREADABLE_TEXT_SKIPPED` | warning | `--no-strict-reading` で読み飛ばした文字 |
| `ASCII_WORD_UNKNOWN` | advice | レキシコンに無い 5 文字以上の英単語。文字ごとに読まれる可能性 |
| `URL_READ_LITERALLY` | advice | URL を記号ごと読み下した |
| `HEURISTIC_READING` | advice | フロントエンド無しでかなを機械的に読んだ |
| `F0_OUTSIDE_VOICE_RANGE` | warning | ボイスの得意音域を外れている |
| `CONSONANT_HEAVILY_COMPRESSED` | warning | 子音を 45 % 未満まで短縮した |
| `CONSONANT_TAKEN_FROM_NOTE` / `CONSONANT_COMPRESSED` | adjustment | 子音が音符内に入った / 短縮された |

`--diagnostics compact` を付けると、警告を 1 行ずつ次の形式で出します (`speak` 系は標準エラー、`validate` は標準出力)。

```
<request>:1:1: advice kongyoroid(ASCII_WORD_UNKNOWN): The word "kongyoroidsynth" is not in the built-in lexicon; the frontend may spell it letter by letter. help: Add a dictionary entry with its katakana reading, or write the reading in kana.
```

形式は `場所: 重要度 kongyoroid(コード): メッセージ help: 助言`。場所は `--input` のファイル名 (無ければ `<request>`) に、`sourceSpan` があれば `:行:桁` (1 始まり)、無ければ `:$.path` を続けます。

### 共通フラグ

| フラグ | 内容 |
| --- | --- |
| `--engine formant\|voicevox\|auto` | エンジン。既定 `formant`。VOICEVOX のスタイルを指定すると自動的に `voicevox` |
| `--voice ID` | 内蔵ボイス (`neutral` `female` `male` `child` `soft` `bright` `deep`) |
| `--dictionary FILE` | ローカル辞書 JSON (`KONGYOROID_DICTIONARY`) |
| `--cache-dir DIR` / `--no-cache` | ディスクキャッシュ (`DIR/kongyoroid-cache/` を使う) / 無効化 |
| `--endpoint URL` `--timeout-ms N` `--retries N` | VOICEVOX ENGINE の接続設定 |
| `--concurrency N` | バッチの並列数と HTTP の同時接続数 |

出力系フラグ (`speak` `sing` `render`):

| フラグ | 内容 |
| --- | --- |
| `-o, --output FILE\|-` | WAV の出力先 (既定 `kongyoroid-<kind>-<hash>.wav`)。`-` で標準出力 |
| `--force` | 既存ファイルを置き換える (同一内容なら `--force` 無しでも成功し `unchanged: true`) |
| `--play` | 書き出し後にシステムプレイヤーで再生 |
| `--plan-out FILE\|-` | 合成計画 (読み・音素・時刻) も JSON で書く |
| `--dry-run` | 検証と計画だけ (出力は `validate` と同じ) |
| `--diagnostics json\|compact` | 警告の出し方 |

環境変数: `KONGYOROID_ENGINE` `KONGYOROID_VOICE` `KONGYOROID_DICTIONARY` `KONGYOROID_CACHE_DIR` `KONGYOROID_ENDPOINT` (別名 `VOICEVOX_URL`) `KONGYOROID_SPEAKER` `KONGYOROID_SINGER` `KONGYOROID_TEACHER`。

## speak

```
kongyoroid speak (--text TEXT | --input FILE|-) [options]
```

| フラグ | 内容 |
| --- | --- |
| `-t, --text TEXT` / `-i, --input FILE\|-` | 読み上げるテキスト / ファイル・標準入力から |
| `--kana NOTATION` | かな記法で発音を指定 (テキスト解析を飛ばす) |
| `--dict-entry SURFACE=READING[:ACCENT]` | 一回限りの読み指定 (複数可) |
| `--no-strict-reading` | 読めない文字を警告付きで飛ばす |
| `--speed N` `--pitch-semitones N` `--pitch N` `--intonation N` | 話速 0.25–4、半音シフト −24..24、VOICEVOX 互換 pitchScale、抑揚 0–3 |
| `--volume N` / `--gain-db N` | 出力レベル |
| `--breathiness N` | 声門の張り −1..1.5 |
| `--pre-pause S` `--post-pause S` `--pause-length S` `--pause-scale N` | 前後無音、`、` の絶対長、ポーズ倍率 |
| `--no-upspeak` | 疑問文末を上げない |
| `--sample-rate HZ` `--seed N` | 8000–48000 Hz、ノイズの種 |
| `--speaker ID\|NAME` `--split sentence\|paragraph\|none` | VOICEVOX のスタイルと分割単位 |
| `--stream` `--format wav\|pcm\|ndjson` `--progress` | ストリーミング (後述) |

出力 (1 行):

```json
{"ok":true,"path":"/work/out.wav","written":true,"unchanged":false,"engine":"formant","engineVersion":"formant-2.0.0","kind":"speech","voice":"neutral","styles":{},"kana":"テ'_ストガ/サン'ゲン/シッパイ/シマ'_シタ。","chunks":1,"cached":false,"sha256":"…","requestHash":"…","bytes":108942,"sampleRate":24000,"channels":1,"frames":54449,"durationSeconds":2.269,"peak":0.4772,"rms":0.081,"limitedSamples":0,"elapsedMs":479.55,"timings":{"readMs":406.49,"planMs":3.86,"renderMs":66.94,"encodeMs":0,"totalMs":479.55},"warnings":[],"adjustments":[]}
```

`--output -` の時は WAV バイト列が標準出力、同じ JSON (`"output":"stdout"`) が標準エラーに出ます。

### ストリーミング (`--stream`)

テキストを `。！？` と改行で文に分け、文が確定するたびに合成します。次の文の計画を先読みするので途切れません。

| `--format` | 標準出力の内容 |
| --- | --- |
| `pcm` | 生の s16le モノラル PCM。サンプルレートは `--sample-rate` (既定 24000) |
| `wav` | 長さ未確定 (`0xFFFFFFFF`) ヘッダー付き WAV。パイプ再生向け |
| `ndjson` | 1 行 1 イベント (下記) |

NDJSON のイベント:

```json
{"type":"sentence","index":0,"text":"最初の文です。","kana":"サイショノ/ブ'ンデ_ス。","durationSeconds":1.144,"startSeconds":0,"warnings":[]}
{"type":"audio","sequence":0,"sentence":0,"sampleRate":24000,"encoding":"s16le","channels":1,"frames":1200,"startFrame":0,"base64":"…"}
{"type":"end","ok":true,"operation":"speak","stream":true,"format":"ndjson","output":"stdout","sentences":2,"frames":51432,"durationSeconds":2.143,"sampleRate":24000}
```

`-o FILE` と組み合わせるとファイルへ書き、終了時にヘッダーを書き戻します。`--progress` で文ごとの JSON 行を標準エラーに出します。文間のポーズは次の文の先頭に付き、`--post-pause` は最後に 1 回だけ付くので、一括合成と同じ尺になります。

## sing

```
kongyoroid sing (--lyrics KANA --melody NOTES | --mml MML [--lyrics KANA] | --input FILE|-) [options]
```

| フラグ | 内容 |
| --- | --- |
| `--lyrics KANA` | かな歌詞。有音の音符 1 つにつき 1 モーラ消費 |
| `--melody NOTES` | 空白区切り: 音名 (`C4` `F#4` `Bb3`)、MIDI 番号、`R` 休符、`~` タイ、`~G4` メリスマ、`\|` は無視 |
| `--beats LIST` | 音符ごとの拍 (`"1 1 2 0.5"`)。1 つだけなら全音符に適用。既定 1 |
| `--mml MML` | MML 譜 (`t120 o4 l8 c d e f g4 r4 e&e`)。`t` テンポ、`o` オクターブ、`< >`、`l` 既定長、`v` ベロシティ、`n60` MIDI、`r` 休符、`&` タイ/メリスマ、`[きゃ]` 歌詞、付点 |
| `-i, --input FILE\|-` | 音符リストを含むリクエスト JSON (フラグが優先) |
| `--tempo BPM` `--transpose N` | 20–400 (既定 120 か MML の値)、半音 −48..48 |
| `--vibrato-depth CENTS` `--vibrato-rate HZ` `--vibrato-delay-ms MS` `--vibrato-fade-ms MS` | ビブラート (既定 30 cent、5.5 Hz、180 ms 後から 250 ms かけて) |
| `--portamento-ms MS` | つながった音符間のピッチ移行 (既定 60、0 で階段) |
| `--scoop-cents N` `--scoop-ms MS` | フレーズ頭のしゃくり |
| `--no-consonant-compression` | 子音を短縮せず `NOTE_TOO_SHORT` で失敗 |
| `--lead-in S` `--lead-out S` | 前後の休符 (既定 0.16) |
| `--singer` `--teacher` | VOICEVOX の歌唱スタイル |

音符リスト (`--input` / `render`) の 1 音符:

| フィールド | 内容 |
| --- | --- |
| `id` | 安定した識別子 (既定 `n1`…)。計画とエラーに出る |
| `key` | MIDI 番号、音名、`null` (休符) |
| `beats` | 拍 (四分音符 = 1) |
| `lyric` | かな 1〜8 モーラ。`ー` は前の母音を伸ばす。休符は空 |
| `continuation` | `tie` (同じ高さで伸ばす) / `melisma` (高さを変えて伸ばす)。直前の有音音符に続く必要あり |
| `articulation` | `auto` (同じ母音の連続は再アタック) / `legato` / `rearticulate` |
| `velocity` / `gainDb` | 1–127 (100 が基準) / dB。どちらか一方 |
| `portamentoMs` | この音符への移行時間 |
| `vibrato` | `{depthCents, rateHz, delayMs, fadeMs}` または `false` |

出力は `speak` と同じ形式です。`plan` を使うと音符ごとの時刻を確認できます。

## render / validate / plan

```
kongyoroid render --input FILE|- [options]
kongyoroid validate (--input FILE|- | --text TEXT | --lyrics KANA --melody NOTES | --mml MML) [options]
kongyoroid plan     (--input FILE|- | --text TEXT | --lyrics KANA --melody NOTES | --mml MML) [--detail summary|phonemes|acoustics]
```

`render` は `kongyoroid schema` の JSON Schema に従うリクエストを描画します。`validate` は描画せず次を返します。

```json
{"ok":true,"operation":"validate","engine":"formant","kind":"speech","renderable":true,"estimate":{"durationSeconds":0.588,"frames":14108,"wavBytes":28260,"sampleRate":24000},"voice":"neutral","reading":{"kana":"カンジ'。","frontend":"notation","moraCount":3},"notes":null,"warnings":[],"adjustments":[],"requestHash":"…","planHash":"…","request":{…}}
```

`plan` は `plan.reading` (アクセント句と `accentSource`、`dictionaryHits`)、`plan.moras[]` (`startSeconds` / `endSeconds` / `phonemes`)、`plan.notes[]` (`startSeconds` / `vowelStartSeconds` / `endSeconds` / `sustainId` / `continuation` / `articulation`)、`plan.f0` (`min` / `max`)、`plan.frames`、`plan.wavBytes` を返します。`--detail phonemes` で音素ごとの時刻、`--detail acoustics` でキーフレーム (フォルマント周波数・帯域幅・音源レベル) まで出ます。

## batch

```
kongyoroid batch --input FILE|- --output-dir DIR [--force] [--concurrency N] [--stop-on-error]
```

入力は 1 行 1 ジョブの JSONL (`{"id":"name","request":{...}}`、`kongyoroid schema --kind batch`)。行が届き次第処理し (標準入力なら長寿命セッションとして使える)、完了順に 1 行ずつ結果を出します。失敗した行があっても続行し、終了コードは最悪の結果です。

```json
{"ok":true,"id":"a","line":1,"path":"/work/out/a.wav","written":true,"unchanged":false,"engine":"formant",…}
{"ok":false,"id":"b","line":2,"error":{"code":"NOTE_TOO_SHORT",…}}
```

## reading

```
kongyoroid reading (--text TEXT | --input FILE|-) [--kana NOTATION] [--dict-entry …] [--no-strict-reading] [--engine voicevox --speaker ID]
```

```json
{"ok":true,"operation":"reading","text":"kongyoroidはLLM向けです","engine":"formant","frontend":"jpreprocess","kana":"コンギョロイドワ/エルエルエ'ムムケデ_ス。","speaker":null,"warnings":[],
 "dictionaryHits":[{"surface":"kongyoroid","reading":"コンギョロイド","accent":0,"source":"dictionary","applied":true},{"surface":"LLM","reading":"エルエルエム","accent":5,"source":"lexicon","applied":true}],
 "sentences":[{"text":"kongyoroidはLLM向けです","kana":"…","start":0,"end":18}],
 "phrases":[{"text":"コンギョロイドワ","accent":0,"accentSource":"dictionary","boundary":"phrase","pause":false,"interrogative":false,"moras":[{"text":"コ","consonant":"k","vowel":"o",…}]},…]}
```

`accentSource` は `frontend` (jpreprocess)、`dictionary` (ローカル辞書)、`lexicon` (内蔵レキシコン)、`user` (かな記法のアクセント)、`rule` (規則) のいずれかです。

## dict

```
kongyoroid dict <list|add|update|delete|check> [--scope local|voicevox] [--dictionary FILE] [--dry-run]
```

| 操作 | 主なフラグ |
| --- | --- |
| `add` / `update` | `--surface` `--reading` (`--pronunciation`) `--accent N` (0 = 平板、省略でフロントエンド任せ) `--match word\|anywhere` `--priority 0–10` `--id` |
| `delete` | `--id` |
| `check` | `--text` を辞書付きで読んで `kana` と `hits` を表示 |
| `list` | エントリ一覧 (`entries[]`) と `digest` |

ローカル辞書ファイルは `{"entries":[{"surface":"端","reading":"ハシ","accent":0,"match":"anywhere","priority":3}]}` (`kongyoroid schema --kind dictionary`)。既定パスは `KONGYOROID_DICTIONARY` か `./kongyoroid-dictionary.json`。同じ表記・同じ読みの `add` は `unchanged: true` で no-op です。`--scope voicevox` は VOICEVOX ENGINE のユーザー辞書を操作します (`--word-type PROPER_NOUN|COMMON_NOUN|VERB|ADJECTIVE|SUFFIX`)。

## voices / doctor / capabilities / schema

- `kongyoroid voices [--engine formant|voicevox|all] [--kind speech|song|all] [--query TEXT]`: 内蔵ボイス (`baseF0`、`f0Range`、`hash`) と、到達可能なら VOICEVOX スタイル。`--engine voicevox` 以外では VOICEVOX 不通は致命的ではありません (`voicevox.available: false`)。
- `kongyoroid doctor [--engine formant|voicevox|all|auto] [--speaker ID] [--initialize]`: フロントエンドのロード時間、短い合成の自己診断、キャッシュ、辞書、VOICEVOX の状態。検査したエンジンが使えなければ終了コード 3。
- `kongyoroid capabilities`: エンジン、ボイス、制限、コマンド、環境変数、終了コード、エラーコードの JSON。
- `kongyoroid schema [--kind request|batch|dictionary]`: JSON Schema (draft 2020-12)。

## inspect / play / cache

- `kongyoroid inspect FILE.wav [--pitch-track] [--window-ms N]`: サンプルレート、尺、ピーク、RMS、クリップ数、F0 推定 (`medianHz` / 範囲 / 有声率)。`--pitch-track` で窓ごとの F0。
- `kongyoroid play FILE.wav`: afplay / paplay / aplay / ffplay / play / PowerShell の順に試します。
- `kongyoroid cache <stats|prune|clear> [--cache-dir DIR] [--max-bytes N] [--max-entries N] [--dry-run]`: `DIR/kongyoroid-cache/` の中だけを対象にします。

## VOICEVOX を使う場合

`--speaker` / `--singer` / `--teacher` に id か名前 (`ずんだもん`、`ずんだもん/ノーマル`) を渡すと `voicevox` エンジンになります。`--engine auto` はエンドポイントの応答で切り替え、応答が無い間は 30 秒ごとに再確認します。VOICEVOX の歌唱は 1 音符 1 モーラで、タイ・メリスマ・複数モーラ・音符ごとのビブラートは内蔵エンジン専用です。
