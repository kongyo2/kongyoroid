# CLI リファレンス (内蔵 formant エンジン)

導入済みの版の完全な仕様は `node_modules/@kongyo2/kongyoroid/docs/cli.md` と `kongyoroid <command> --help`。

## 目次

- [共通の約束](#共通の約束)
- [speak](#speak--読み上げ)
- [sing](#sing--歌唱)
- [render](#render--json-リクエストを描画)
- [validate](#validate--描画せずに検証)
- [plan](#plan--読みと時刻表)
- [reading](#reading--読みだけを見る)
- [batch](#batch--jsonl-を並列描画)
- [inspect](#inspect--wav-を検査)
- [dict](#dict--ローカル辞書)
- [voices--doctor--capabilities--schema](#voices--doctor--capabilities--schema)
- [cache--play](#cache--play)
- [制限](#制限)

## 共通の約束

すべてのコマンドは**標準出力に 1 行 1 JSON**を書く。失敗時は標準エラーに `{"ok":false,"error":{…}}` を書いて 0 以外で終了する。`--output -` で音声を標準出力へ流すときだけ、成功 JSON も標準エラーに出る (`"output":"stdout"` が付く)。

| 終了コード | 意味 | 典型例 |
| --- | --- | --- |
| 0 | 成功 | |
| 1 | 内部エラー | バグ。`error.detail` を添えて報告 |
| 2 | 入力エラー | 不正な JSON、未知のプロパティ、範囲外、読めない文字、短すぎる音符、音域外 |
| 3 | エンジン利用不可 | フロントエンドのロード失敗 |
| 4 | 入出力エラー | 既存ファイルの上書き拒否、入力が読めない |
| 130 | 中断 | SIGINT |

共通フラグ:

| フラグ | 内容 |
| --- | --- |
| `--engine formant` | 常に明示する。既定も `formant` だが `KONGYOROID_ENGINE` で変わる |
| `--voice ID` | `neutral` `female` `male` `child` `soft` `bright` `deep` |
| `--dictionary FILE` | ローカル辞書 JSON (既定 `KONGYOROID_DICTIONARY` か `./kongyoroid-dictionary.json`) |
| `--cache-dir DIR` / `--no-cache` | ディスクキャッシュを `DIR/kongyoroid-cache/` に置く / 無効化 |
| `--concurrency N` | `batch` の並列数 |

出力系フラグ (`speak` `sing` `render`):

| フラグ | 内容 |
| --- | --- |
| `-o, --output FILE\|-` | WAV の出力先。既定 `kongyoroid-<kind>-<hash>.wav`。`-` で標準出力 |
| `--force` | 既存ファイルを置き換える。**依頼された置換のときだけ** |
| `--play` | 書き出し後にシステムプレイヤーで再生 |
| `--plan-out FILE\|-` | 合成計画も JSON で書く (`--detail phonemes` 相当の内容) |
| `--dry-run` | 検証と計画だけ。出力は `validate` と同じ |
| `--diagnostics json\|compact` | 警告を JSON 内に入れる (既定) / 1 行ずつ標準エラーに出す |

`--diagnostics compact` の形式は `場所: 重要度 kongyoroid(コード): メッセージ help: 助言`:

```
<request>:1:1: advice kongyoroid(ASCII_WORD_UNKNOWN): The word "kongyoroidsynth" is not in the built-in lexicon; the frontend may spell it letter by letter. help: Add a dictionary entry with its katakana reading, or write the reading in kana.
```

環境変数 `KONGYOROID_ENGINE` `KONGYOROID_VOICE` `KONGYOROID_DICTIONARY` `KONGYOROID_CACHE_DIR` は既定値を動かす。再現性が要るならリクエスト JSON にすべて書き切る。

## speak — 読み上げ

```
kongyoroid speak (--text TEXT | --input FILE|-) [options]
```

| フラグ | 内容 |
| --- | --- |
| `-t, --text TEXT` | 読み上げるテキスト。**先頭が `-` の文字列は `--text=…` の形で渡す** |
| `-i, --input FILE\|-` | ファイル / 標準入力から読む |
| `--kana NOTATION` | かな記法で発音を指定 (テキスト解析を飛ばす) |
| `--dict-entry SURFACE=READING[:ACCENT]` | 一回限りの読み指定。繰り返し可 |
| `--no-strict-reading` | 読めない文字を警告付きで飛ばす |
| `--speed N` | 0.25–4 (既定 1)。子音・母音・ポーズを一様に伸縮 |
| `--pitch-semitones N` | 基本ピッチの半音シフト −24..24 |
| `--intonation N` | 抑揚の幅 0–3 (既定 1)。0 でほぼ平坦 |
| `--volume N` / `--gain-db N` | 出力レベル (線形 0–3 / dB −60..12)。**排他** |
| `--breathiness N` | 声門の張り −1..1.5。正で息っぽく |
| `--pre-pause S` `--post-pause S` | 前後の無音 (既定 0.1 秒ずつ) |
| `--pause-length S` `--pause-scale N` | `、` の絶対長 / 全ポーズの倍率 |
| `--no-upspeak` | 疑問文末を上げない |
| `--sample-rate HZ` `--seed N` | 8000–48000 (既定 24000) / ノイズの種 (既定 1) |
| `--stream` `--format wav\|pcm\|ndjson` `--progress` | ストリーミング (下記) |

成功 JSON の主なフィールド:

```json
{"ok":true,"path":"/work/out.wav","written":true,"unchanged":false,
 "engine":"formant","engineVersion":"formant-2.0.0","kind":"speech","voice":"neutral",
 "kana":"テ'_ストガ/サン'ゲン/シッパイ/シマ'_シタ。","chunks":1,"cached":false,
 "sha256":"…","requestHash":"…","bytes":108942,"sampleRate":24000,"channels":1,
 "frames":54449,"durationSeconds":2.269,"peak":0.4772,"rms":0.081,"limitedSamples":0,
 "elapsedMs":759.98,"timings":{"readMs":656.35,"planMs":6.24,"renderMs":93.15,"encodeMs":0,"totalMs":759.98},
 "warnings":[],"adjustments":[]}
```

| フィールド | 意味 |
| --- | --- |
| `written` / `unchanged` | 実際に書いたか / 同一内容の no-op だったか |
| `kana` | **実際に読まれた読み。原稿と突き合わせる最重要フィールド** |
| `sha256` / `requestHash` | 出力 WAV のハッシュ / 正規化リクエストのハッシュ。差分追跡に使う |
| `cached` | ディスク/メモリキャッシュから返したか |
| `peak` / `rms` / `limitedSamples` | 0–1 のピーク / RMS / リミッターが働いたサンプル数 |
| `timings.readMs` | 日本語フロントエンドのロード + 解析。初回のみ 0.6〜1.2 秒かかる |
| `warnings[]` | `severity` が `warning` / `advice` の助言 |
| `adjustments[]` | エンジンが自動で変えたこと (子音短縮など) |

### ストリーミング (`--stream`)

`。！？` と改行で文に分け、文が確定するたびに合成する。次の文を先読みするので途切れない。文間ポーズは次の文の先頭に付き、`--post-pause` は最後に 1 回だけなので、一括合成と同じ尺になる。

| `--format` | 標準出力 |
| --- | --- |
| `pcm` | 生の s16le モノラル PCM |
| `wav` | 長さ未確定 (`0xFFFFFFFF`) ヘッダー付き WAV。パイプ再生向け |
| `ndjson` | 1 行 1 イベント |

```sh
llm-agent run | kongyoroid speak --input - --stream --output - --format pcm \
  | aplay -f S16_LE -r 24000 -c 1
```

NDJSON のイベント (実測):

```json
{"type":"sentence","index":0,"text":"一つ目の文です。","kana":"_ヒトツ'メノ/ブ'ンデ_ス。","durationSeconds":1.289,"startSeconds":0,"warnings":[]}
{"type":"audio","sequence":0,"sentence":0,"sampleRate":24000,"encoding":"s16le","channels":1,"frames":1200,"startFrame":0,"base64":"…"}
{"type":"end","ok":true,"operation":"speak","stream":true,"format":"ndjson","output":"stdout","sentences":2,"frames":51432,"durationSeconds":2.143,"sampleRate":24000}
```

`-o FILE` と併用するとファイルに書き、終了時にヘッダーを書き戻す。`--progress` で文ごとの `sentence` イベントを標準エラーに出す。

## sing — 歌唱

```
kongyoroid sing (--lyrics KANA --melody NOTES | --mml MML [--lyrics KANA] | --input FILE|-) [options]
```

| フラグ | 内容 |
| --- | --- |
| `--lyrics KANA` | かな歌詞。有音の音符 1 つにつき 1 モーラ消費 |
| `--melody NOTES` | 空白区切り。音名 (`C4` `F#4` `Bb3`)、MIDI 番号、`R` 休符、`~` タイ、`~G4` メリスマ、`\|` は無視 |
| `--beats LIST` | 音符ごとの拍 (`"1 1 2 0.5"`)。1 つだけなら全音符に適用。既定 1。範囲 0.015625–64 |
| `--mml MML` | MML 譜 (`t120 o4 l8 c d e f g4 r4 e&e`) |
| `-i, --input FILE\|-` | 音符リストを含むリクエスト JSON。フラグが優先 |
| `--tempo BPM` | 20–400 (既定 120、MML に `t` があればその値) |
| `--transpose N` | 半音 −48..48 |
| `--vibrato-depth CENTS` `--vibrato-rate HZ` `--vibrato-delay-ms MS` `--vibrato-fade-ms MS` | 既定 30 cent / 5.5 Hz / 180 ms 後から 250 ms かけて。depth 0 で無効 |
| `--portamento-ms MS` | つながった音符間のピッチ移行 (既定 60、0 で階段状) |
| `--scoop-cents N` `--scoop-ms MS` | フレーズ頭のしゃくり |
| `--no-consonant-compression` | 子音を短縮せず `NOTE_TOO_SHORT` で失敗させる |
| `--lead-in S` `--lead-out S` | 前後の休符 (既定 0.16 秒) |

出力 JSON は `speak` と同じ形 (テキストがないので `kana` は付かない)。詳細は [singing.md](singing.md)。

## render — JSON リクエストを描画

```
kongyoroid render --input FILE|- [options]
```

`kongyoroid schema --kind request` の JSON Schema に従うリクエストを描画する。`--engine` `--voice` `--dictionary` などのフラグはリクエストの値を上書きする。

```sh
echo '{"kind":"speech","engine":"formant","text":"読み上げのテスト"}' \
  | kongyoroid render --input - -o test.wav
kongyoroid render --input song.json --plan-out song.plan.json -o song.wav
```

## validate — 描画せずに検証

```
kongyoroid validate (--input FILE|- | --text TEXT | --lyrics KANA --melody NOTES | --mml MML) [options]
```

構造と意味 (読める文字か、音符が短すぎないか、音域内か) を検査し、推定尺・ハッシュ・警告を返す。描画できないと終了コード 2。

```json
{"ok":true,"operation":"validate","engine":"formant","kind":"speech","renderable":true,
 "estimate":{"durationSeconds":0.585,"frames":14033,"wavBytes":28110,"sampleRate":24000},
 "voice":"neutral","reading":{"kana":"カンジ。","frontend":"jpreprocess","moraCount":3},
 "notes":null,"warnings":[],"adjustments":[],"requestHash":"…","planHash":"…","request":{…}}
```

`request` には**既定値まで展開された正規化リクエスト**が入る。何が実際に効いているかはここで確認できる。`notes` は歌唱のとき音符数。

## plan — 読みと時刻表

```
kongyoroid plan (--input FILE|- | --text TEXT | --lyrics KANA --melody NOTES | --mml MML) [--detail summary|phonemes|acoustics]
```

`plan` (既定 `summary`) の内容:

| キー | 内容 |
| --- | --- |
| `planVersion` `engineVersion` `voice` `voiceHash` `sampleRate` `seed` | 再現に必要な識別子 |
| `frames` `durationSeconds` `wavBytes` | 出力の見積もり |
| `f0` | `{min, max}` の F0 レンジ (Hz) |
| `planHash` | 合成計画のハッシュ |
| `reading` | `frontend` / `kana` / `moraCount` / `phrases[]` / `dictionaryHits[]` |
| `reading.phrases[]` | `index` `text` `kana` `accent` `accentSource` `boundary` `startSeconds` `endSeconds` |
| `moras[]` | `index` `text` `startSeconds` `endSeconds` `phonemes[]` |
| `notes[]` | 歌唱のみ。下記 |
| `warnings[]` `adjustments[]` | 助言と自動調整 |

`notes[]` の各要素 (実測):

```json
{"id":"n2","index":1,"key":64,"hz":329.63,"lyric":"ー","startSeconds":0.66,"endSeconds":1.16,
 "vowelStartSeconds":0.66,"continuation":"melisma","articulation":"continue","sustainId":1}
```

`--detail phonemes` は `phonemes[]` (`id` `phoneme` `startSeconds` `endSeconds` `voiced` `mora` `note` `articulation`) と `pitchPoints[]` (`seconds` / `hz`) を足す。`--detail acoustics` はさらに各 `phonemes[]` に `keyframes[]` (フォルマント周波数 `f1`–`f5`、帯域幅 `b1`–`b5`、音源レベル `av` `ah` `af`、`rd`、鼻音・摩擦パラメータ) を足す。

## reading — 読みだけを見る

```
kongyoroid reading (--text TEXT | --input FILE|-) [--kana NOTATION] [--dict-entry …] [--no-strict-reading]
```

合成せずに読みだけを返す。原稿レビューはこれが最速。

```json
{"ok":true,"operation":"reading","text":"kongyoroidはLLM向けです","engine":"formant",
 "frontend":"jpreprocess","kana":"コンギョロイドワ/エルエルエ'ムムケデ_ス。","warnings":[],
 "dictionaryHits":[{"surface":"kongyoroid","reading":"コンギョロイド","accent":0,"source":"dictionary","applied":true}],
 "sentences":[{"text":"…","kana":"…","start":0,"end":18}],
 "phrases":[{"text":"コンギョロイドワ","accent":0,"accentSource":"dictionary","boundary":"phrase",
             "pause":false,"interrogative":false,
             "moras":[{"text":"コ","consonant":"k","vowel":"o","consonantLength":null,"vowelLength":0,"pitch":0}]}]}
```

`frontend` は `jpreprocess` (テキスト解析) か `notation` (`--kana` を渡したとき)。`accentSource` は `frontend` / `dictionary` / `lexicon` / `user` / `rule`。

## batch — JSONL を並列描画

```
kongyoroid batch --input FILE|- --output-dir DIR [--force] [--concurrency N] [--stop-on-error]
```

1 行 1 ジョブの JSONL (`{"id":"name","request":{…}}`) を、行が届き次第処理する。標準入力なら**長寿命セッション**として使えるので、フロントエンドのロード (0.6〜1.2 秒) を 1 回で済ませられる。結果は**完了順**に 1 行ずつ出る。失敗した行があっても続行し、終了コードは最悪の結果になる。

```sh
printf '%s\n' \
  '{"id":"a","request":{"kind":"speech","engine":"formant","text":"一件目"}}' \
  '{"id":"b","request":{"kind":"song","engine":"formant","notes":{"lyrics":"ら","melody":"C4"}}}' \
  | kongyoroid batch -i - --output-dir out --concurrency 4
```

```json
{"ok":true,"id":"a","line":1,"path":"/work/out/a.wav","written":true,…}
{"ok":false,"id":"c","line":3,"error":{"code":"UNREADABLE_TEXT",…}}
```

## inspect — WAV を検査

```
kongyoroid inspect FILE.wav [--pitch-track] [--window-ms N]
```

```json
{"ok":true,"operation":"inspect","path":"/work/out.wav",
 "info":{"sampleRate":24000,"channels":1,"frames":32542,"bitsPerSample":16,"format":"pcm","durationSeconds":1.3559},
 "bytes":65128,"sha256":"…","peak":0.5667,"rms":0.1414,"dc":0,"clipped":0,"finite":true,
 "pitch":{"medianHz":238,"minHz":187.1,"maxHz":257.2,"voicedRatio":0.667}}
```

`finite: true` と `clipped: 0` は最低条件。`--pitch-track` で窓ごとの `{seconds, hz, clarity}` が付く。歌唱の音高確認に使える (実測: 持続した C4 は `medianHz` 261.4、理論値 261.63 に対し約 1.5 セント)。

## dict — ローカル辞書

```
kongyoroid dict <list|add|update|delete|check> [--dictionary FILE] [--dry-run]
```

| 操作 | 主なフラグ |
| --- | --- |
| `add` / `update` | `--surface` `--reading` `--accent N` (0 = 平板、省略でフロントエンド任せ) `--match word\|anywhere` `--priority 0–10` `--id` |
| `delete` | `--id` |
| `check` | `--text` を辞書付きで読んで `kana` と `hits` を出す |
| `list` | `entries[]` と `digest` |

ファイル形式は `{"entries":[{"surface":"端","reading":"ハシ","accent":0,"match":"anywhere","priority":3}]}` (`kongyoroid schema --kind dictionary`)。同じ表記・同じ読みの `add` は `unchanged: true` の no-op。既定パスは `KONGYOROID_DICTIONARY` か `./kongyoroid-dictionary.json`。

## voices / doctor / capabilities / schema

- `kongyoroid voices --engine formant` — 内蔵ボイスの `baseF0`、`f0Range`、`description`、`hash`。
- `kongyoroid doctor --engine formant` — フロントエンドのロード時間、短い合成の自己診断、キャッシュ、辞書。使えなければ終了コード 3。
- `kongyoroid capabilities` — 対応機能・制限・コマンド・環境変数・終了コード・エラーコードの JSON。**版ごとの一次情報**。
- `kongyoroid schema --kind request|batch|dictionary` — JSON Schema (draft 2020-12)。

## cache / play

- `kongyoroid cache <stats|prune|clear> [--cache-dir DIR] [--max-bytes N] [--max-entries N] [--dry-run]` — `DIR/kongyoroid-cache/` の中だけを対象にする。無関係なファイルには触らない。
- `kongyoroid play FILE.wav` — afplay / paplay / aplay / ffplay / play / PowerShell の順に試す。無ければ `PLAYER_UNAVAILABLE` (終了コード 4)。

キャッシュキーはエンジン・パッケージ版・エンジン版・フロントエンド版・辞書ダイジェスト・正規化リクエストから作るので、更新後に古い音声が返ることはない。実測でキャッシュヒット時は 760 ms → 4.6 ms。

## 制限

| 項目 | 値 |
| --- | --- |
| `text` / `kana` | 20,000 文字 |
| 音符 | 4,096 個 / 1 音符の拍 0.015625–64 |
| 1 音符の歌詞 | 8 モーラ |
| formant の 1 リクエスト | 1,800 秒 |
| 入力ファイル | 8 MiB |
| バッチ行数 / 並列度 | 10,000 / 16 |
| 辞書エントリ | 20,000 |
| ストリームの 1 文 | 2,000 文字 |
