# 失敗と警告への対処

失敗はすべて構造化されている。**分岐は `error.code` と `error.repairOptions[].action` で行う** — `message` は人間向けで版によって変わる。

## 目次

- [エラー構造](#エラー構造)
- [エラーコード別の対処](#エラーコード別の対処)
- [repairOptions のアクション](#repairoptions-のアクション)
- [警告と自動調整](#警告と自動調整)
- [黙って壊れる場合](#黙って壊れる場合)
- [よくある取り違え](#よくある取り違え)
- [切り分けの手順](#切り分けの手順)

## エラー構造

```json
{"ok":false,"error":{
  "code":"UNREADABLE_TEXT",
  "message":"Unreadable text \"彁\": the frontend has no reading for it and would drop it silently.",
  "retryable":false,
  "path":"$.text",
  "hint":"Give the reading in kana, add a dictionary entry with surface and reading, or remove the characters.",
  "detail":{"unreadable":[{"surface":"彁","sourceSpan":{"start":0,"end":1,"unit":"unicode-code-point"}}]},
  "repairOptions":[
    {"action":"provide-kana","description":"…","path":"$.kana"},
    {"action":"add-dictionary-entry","description":"…","path":"$.dictionary"},
    {"action":"remove-characters","description":"…","path":"$.text"}],
  "sourceSpan":{"start":0,"end":1,"unit":"unicode-code-point"},
  "surface":"彁"}}
```

| フィールド | 使い方 |
| --- | --- |
| `code` | 分岐の主キー。16 種 (下表) |
| `path` | 場所。リクエストは `$.notes[1].beats`、CLI フラグは `$flags.speed`、標準入力は `$.input` |
| `retryable` / `retryAfterMs` | そのまま再送して直る可能性。formant のエラーはほぼ `false` |
| `repairOptions[]` | 機械可読な修正案。`action` と対象 `path` |
| `sourceSpan` / `surface` | 元テキスト内の位置 (Unicode コードポイント、`end` は排他的) と該当文字列 |
| `detail` | コード固有の構造化情報 (`availableMs` / `requiredMs` / `noteId`、`unreadable[]`、`alignment` など) |

ライブラリでは `asKongyoroidError(err)` で同じ形が取れる (`.code` `.path` `.repairOptions` `.toJSON()`)。終了コードは `exitCodeOf(err)`。

## エラーコード別の対処

| code | 終了 | 意味と直し方 |
| --- | --- | --- |
| `INVALID_INPUT` | 2 | 構造・型・範囲の違反。`path` が場所を指す。未知プロパティなら `hint` に許可された全プロパティ名が並ぶ |
| `UNSUPPORTED_TEXT` | 2 | エンジンが扱えないテキスト |
| `UNREADABLE_TEXT` | 2 | フロントエンドに読みがなく、黙って落とされる文字。`kana` を与えるか辞書に登録する。**文字を削って黙らせない** |
| `NOTE_TOO_SHORT` | 2 | 母音 30 ms 未満、または子音が入りきらない。拍を増やす / テンポを下げる / モーラを隣へ移す / タイに置き換える |
| `PITCH_OUT_OF_RANGE` | 2 | 30–2500 Hz (かつサンプルレートの 20 %) を外れた。`transpose` を下げるか `sampleRate` を上げる |
| `FRONTEND_UNAVAILABLE` | 3 | 日本語フロントエンド (`kanji2koe-openjtalk`) がロードできない。`npm ls kanji2koe-openjtalk` と `kongyoroid doctor --engine formant` を見る。再インストールで直ることが多い |
| `IO_ERROR` | 4 | 既存ファイルと内容が違う、入力が読めない、書き込み権限がない。**別名で書くのが既定**。`--force` は依頼されたときだけ |
| `PLAYER_UNAVAILABLE` | 4 | `--play` でシステムプレイヤーが見つからない。ヘッドレス環境では `--play` を付けずに書き出す |
| `ABORTED` | 130 | SIGINT / `AbortSignal` |
| `INTERNAL` | 1 | バグ。`error.detail` と再現手順を添えて報告する |

### 実測したメッセージ

```
INVALID_INPUT   Unknown property.                                   path: $.speedd
                hint: Allowed properties: kind, schemaVersion, engine, voice, sampleRate, …
INVALID_INPUT   Expected a finite number in [0.25, 4].              path: $.speed
INVALID_INPUT   Expected a finite number in [-60, 12].              path: $.gainDb
INVALID_INPUT   Expected a finite number in [8000, 48000].          path: $.sampleRate
INVALID_INPUT   Expected a finite number in [0.015625, 64].         path: $.notes[0].beats
INVALID_INPUT   Expected a string of 1–20000 characters.            path: $.text
INVALID_INPUT   Give either volume or gainDb, not both.             path: $.gainDb
INVALID_INPUT   Give either velocity or gainDb, not both.           path: $.notes[1]
INVALID_INPUT   Lyric "あいうえおかきくけ" has 9 moras; a note holds at most 8.
INVALID_INPUT   The lyrics have 2 more moras than the melody has pitched notes.
INVALID_INPUT   A tie or melisma must directly follow a pitched note; it cannot cross a rest.
INVALID_INPUT   Unrecognized reading "wo" in phrase "ハローworld".   path: $.kana[0]
NOTE_TOO_SHORT  Note n1 (カ) leaves only 6 ms for 1 vowel(s); at least 30 ms are needed.
NOTE_TOO_SHORT  Note n2 (シュ) is too short for its consonant: 65 ms available, 95 ms needed.
PITCH_OUT_OF_RANGE  The score spans 8372.0–8518.4 Hz; the engine synthesizes 30–2500 Hz at 24000 Hz.
IO_ERROR        Refusing to overwrite /work/a.wav: it exists with different content.
```

## repairOptions のアクション

| action | 対応 |
| --- | --- |
| `provide-kana` | `kana` に発音全体を書く |
| `add-dictionary-entry` | `dictionary` に `{surface, reading, accent?}` を足す |
| `remove-characters` | 読めない文字を消すか書き換える。**内容を変えるのでユーザーの意図を確認する** |
| `increase-duration` | 拍を増やすかテンポを下げる |
| `allow-consonant-compression` | `consonantCompression: true` にする |
| `use-vowel-continuation` | モーラを隣の音符へ移すか、タイ / メリスマで前の母音を伸ばす |
| `lower-pitch` | `transpose` か最高音を下げる |
| `raise-sample-rate` | `sampleRate` を上げる |
| `clamp-pitch` | ピッチを範囲内に丸める |
| `shorten-input` / `split-input` | 入力を短くする / 分割する |
| `use-force` | `--force` (ライブラリは `force: true`) で置換する |

## 警告と自動調整

成功 JSON にも `warnings[]` (`severity`: `warning` / `advice`) と `adjustments[]` (エンジンが自動で変えたこと) が入る。**`ok: true` を見ただけで閉じない**。

| code | 種別 | 意味と判断 |
| --- | --- | --- |
| `ASCII_WORD_UNKNOWN` | advice | レキシコンに無い 5 文字以上の英単語。文字ごとに読まれる。読ませたい語なら辞書に登録する |
| `URL_READ_LITERALLY` | advice | URL を記号ごと読み下した。ナレーションではたいてい短い説明に置き換えたほうがよい |
| `HEURISTIC_READING` | advice | フロントエンド無しでかなを機械的に読んだ |
| `UNREADABLE_TEXT_SKIPPED` | warning | `strictReading: false` で読み飛ばした文字。原稿の欠落なので放置しない |
| `F0_OUTSIDE_VOICE_RANGE` | warning | ボイスの得意音域外。声質が崩れる。`transpose` かボイス変更 |
| `CONSONANT_HEAVILY_COMPRESSED` | warning | 子音を 45 % 未満まで短縮した。歌詞が聞き取れなくなる |
| `CONSONANT_COMPRESSED` | adjustment | 子音を短縮した。`before` / `after` (秒) と `noteId` が付く |
| `CONSONANT_TAKEN_FROM_NOTE` | adjustment | 子音が前の音符の中に食い込んだ |

`--diagnostics compact` を付けると 1 行ずつ出る (`speak` 系は標準エラー、`validate` は標準出力):

```
<request>:1:1: advice kongyoroid(ASCII_WORD_UNKNOWN): The word "kongyoroidsynth" is not in the built-in lexicon; the frontend may spell it letter by letter. help: Add a dictionary entry with its katakana reading, or write the reading in kana.
```

## 黙って壊れる場合

**エラーも警告も出ないのに間違っている**ケース。ここは自動検出できないので、必ず `kana` を目で突き合わせる。実測例:

| 入力 | 実際の読み | 対処 |
| --- | --- | --- |
| `二文目。` | `ニア'ヤメ。` | `--dict-entry 二文目=ニブンメ:2` → `ニブ'ンメ。` |
| `テストが3件失敗` | `…/サン'ゲン/…` | 助数詞。サンケン にしたければ辞書か `kana` |
| `完了しました🎉` | `カンリョー/シマ'_シタ。` | 絵文字は消える。原稿から外すか、意図どおりか確認する |
| `简体` | `タイ。` | 簡体字専用の字が消える。日本語の字形に直す |
| `user@example.com` | `ユーエスイーアール、アットマ'ーク、…` | 警告も出ない。読ませたくないなら短い説明に置き換える |
| `https://example.com/a?b=1` | `…、クエ'_スチョン？ビ'ー/イコール'イチ。` | `?` が疑問文扱いになり文末が上がる |

対処は [speech.md](speech.md#読みを直す-3-つの手段) の 3 手段 (語単位の辞書 / 辞書ファイル / 文全体の `kana`)。

## よくある取り違え

| 症状 | 原因 | 直し方 |
| --- | --- | --- |
| `--text` が「引数が曖昧」と言われる | 値が `-` で始まる (`- **完了**` など) | `--text="- **完了**"` の形で渡す |
| `plan` の `--detail` を指定したのに `phonemes` が出ない | ライブラリで `agent.plan(req, "phonemes")` と書いた。文字列は無視される | `agent.plan(req, { detail: "phonemes" })` |
| `agent.inspect("out.wav")` が `TypeError` になる | 引数はパスではなく `Uint8Array`、しかも同期関数 | `agent.inspect(new Uint8Array(await readFile("out.wav")))` |
| 出力が書かれない (`written: false`) | 同一内容の no-op | `unchanged: true` なら成功。意図どおり |
| `IO_ERROR` で止まる | 既存ファイルと内容が違う | 別名で書く。置換を依頼されたときだけ `--force` |
| 文の切れ目が意図と違う | 文分割は `。！？` と改行が決める。空行は段落として長いポーズになる | `reading` の `sentences[]` で確認し、改行を消すか `、` に置き換える |
| 1 回あたり 0.7 秒前後かかる | CLI 起動ごとにフロントエンドをロードしている | `batch --input -` かライブラリでプロセスを使い回す |
| 更新後も古い音声が返る気がする | キャッシュキーに版と辞書ダイジェストが入るので起こらない | 切り分けたいなら `--no-cache` |
| 音が割れる | リミッターが働いている | `limitedSamples` を見て `gainDb` を下げる (範囲 −60..12) |
| 生成のたびに音が変わる | 起きない。同じリクエスト・同じ `seed`・同じ版なら `sha256` は同一 | 変わったなら `requestHash` を比べて差分を探す |

## 切り分けの手順

1. **エンジンを確かめる。** 出力 JSON の `"engine"` が `formant`、`engineVersion` が `formant-…` になっているか。
2. **入力を確かめる。** `validate` の `request` に既定値まで展開された正規化リクエストが出る。効いていると思った設定が本当に入っているか見る。環境変数 (`KONGYOROID_*`) が混ざっていないかも確認する。
3. **読みを確かめる。** `reading` / `plan` の `kana` と `phrases[].accentSource`、`dictionaryHits[].applied`。
4. **時刻を確かめる。** 歌唱なら `plan.notes[]` の `vowelStartSeconds` と `sustainId`。読み上げなら `plan.moras[]`。
5. **出力を確かめる。** `inspect` の `finite` / `clipped` / `durationSeconds` / `pitch`。
6. **環境を確かめる。** `kongyoroid doctor --engine formant` と `kongyoroid capabilities`、`node -v` (22.18 以上)。

再現手順を残すときは `requestHash` と `planHash` と `sha256`、`kongyoroid --version` の出力を添える。この 4 つがあれば同じ音が再現できる。
