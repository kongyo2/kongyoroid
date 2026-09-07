# 歌唱 — 譜面・モーラ配分・持続音

歌唱 (`kind: "song"`) の作り込み。歌唱は読み上げより失敗の形が具体的で、ほぼすべて `validate` と `plan` の段階で見つかる。**描画する前に `plan.notes[]` の時刻を読むこと**が品質の分かれ目になる。

## 目次

- [譜面の 3 形式](#譜面の-3-形式)
- [モーラと音符の対応](#モーラと音符の対応)
- [タイ・メリスマ・再アタック](#タイメリスマ再アタック)
- [子音の借用と圧縮](#子音の借用と圧縮)
- [音符ごとのパラメータ](#音符ごとのパラメータ)
- [曲全体のパラメータ](#曲全体のパラメータ)
- [音域](#音域)
- [MML](#mml)
- [plan.notes を読む](#plannotes-を読む)
- [レビューの手順](#レビューの手順)

## 譜面の 3 形式

`notes` は 3 つのうちどれかを取る。`validate` の `request.form` に `list` / `compact` / `mml` として出る。

### 1. 音符リスト — もっとも細かい制御

```json
{ "kind": "song", "engine": "formant", "voice": "male", "tempo": 90, "transpose": -2,
  "notes": [
    { "key": null, "beats": 0.5 },
    { "id": "sa", "key": "E4", "beats": 1, "lyric": "さ" },
    { "id": "ku", "key": "E4", "beats": 1, "lyric": "く", "velocity": 110 },
    { "id": "ra", "key": "F4", "beats": 2, "lyric": "ら" },
    { "id": "ra-hold", "key": "F4", "beats": 2, "continuation": "tie", "vibrato": { "depthCents": 45 } },
    { "id": "ra-up", "key": "G4", "beats": 1, "continuation": "melisma" },
    { "key": "C4", "beats": 2, "lyric": "きら" }
  ] }
```

音符ごとのビブラート、ベロシティ、ポルタメント、アーティキュレーションを指定できるのはこの形式だけ。`id` を付けるとエラーと `plan` に同じ名前で出るので、長い曲では付ける価値がある (既定は `n1`, `n2`, …)。

### 2. コンパクト譜 — 歌詞 + 音名 + 拍

```json
{ "kind": "song", "tempo": 100,
  "notes": { "lyrics": "きらきらひかる", "melody": "C4 C4 G4 G4 A4 A4 G4 R", "beats": "1 1 1 1 1 1 1 1" } }
```

`melody` の要素: 音名 (`C4` `F#4` `Bb3`)、MIDI 番号 (`60`)、`R` 休符、`~` タイ、`~G4` メリスマ、`|` (小節線・無視される)。`beats` は空白区切りで、1 つだけなら全音符に適用され、省略すると全部 1。

### 3. MML

```json
{ "kind": "song", "notes": { "mml": "t132 o4 l8 e e r e r c e4 g4 r4 <g4 r4", "lyrics": "ららららららら" } }
```

`lyrics` を省くと全音符が `ラ` になる。渡す場合は**有音の音符と同じモーラ数**にする (この例は有音 7 音 = `ら` 7 つ)。数が合わないと `INVALID_INPUT` (`The MML has 6 or more pitched notes but the lyrics have only 5 moras (note 8).`) になる。

## モーラと音符の対応

`lyrics` は**有音の音符 1 つにつき 1 モーラ**を消費する。休符 (`R`) と継続 (`~`) は消費しない。拗音は 1 モーラ (`キャ` = 1)、促音 `ッ` と撥音 `ン` は 1 モーラ。

数が合わないと `INVALID_INPUT` になり、`detail.alignment` にどこまで割り当てられたかが入る:

```json
{"code":"INVALID_INPUT","message":"The lyrics have 2 more moras than the melody has pitched notes.",
 "path":"$.notes.lyrics",
 "detail":{"alignment":{"moras":["キ","ラ","キ","ラ"],"pitchedNotes":2,
   "assigned":[{"note":0,"mora":0,"text":"キ"},{"note":1,"mora":1,"text":"ラ"}],
   "leftoverMoras":["キ","ラ"],"unfilledNotes":[]}},
 "repairOptions":[{"action":"shorten-input","description":"Remove the leftover moras: キラ.","path":"$.notes.lyrics"}]}
```

`leftoverMoras` / `unfilledNotes` を見れば、歌詞と旋律のどちらがどれだけ長いか分かる。

音符リストなら 1 音符に**最大 8 モーラ**まで載せられる (`"lyric": "きらぼし"`)。9 以上は `INVALID_INPUT` (`Lyric "…" has 9 moras; a note holds at most 8.`)。

歌詞中の `ー` は継続として扱われる。`あー` を `C4 D4` に載せると 2 番目の音符は `lyric: "ー"`, `continuation: "melisma"` になり、母音を再アタックせず高さだけ変える。

## タイ・メリスマ・再アタック

| 指定 | `plan` に出る形 | 意味 |
| --- | --- | --- |
| `~` / `continuation: "tie"` | `articulation: "continue"`、`sustainId` 据え置き | 同じ高さで母音を伸ばす |
| `~G4` / `continuation: "melisma"` | `articulation: "continue"`、`sustainId` 据え置き | 高さを変えて母音を伸ばす |
| `articulation: "auto"` (既定) | 同じ母音が続くと `rearticulate`、`sustainId` が増える | 短い減衰と再アタックを入れる |
| `articulation: "legato"` | `onset` のまま `sustainId` 据え置き | 1 本の持続音としてつなぐ |
| `articulation: "rearticulate"` | 常に `rearticulate` | 明示的に切り直す |

**`sustainId` が同じ音符は 1 本の持続音**として鳴る。「あー」と伸ばしたいのに `sustainId` が増えているなら、意図せず切れている。逆に「ああ」と 2 回言わせたいのに `sustainId` が同じなら、`legato` が効きすぎている。

`C4` の `あ` に `C4` の `あ` を続けた場合:

| `articulation` | 2 音目の `articulation` / `sustainId` |
| --- | --- |
| `auto` (既定) | `rearticulate` / 2 |
| `legato` | `onset` / 1 |
| `rearticulate` | `rearticulate` / 2 |

タイ・メリスマは**直前の有音音符に直接続く**必要がある。休符を跨ぐと `INVALID_INPUT`:

```
A tie or melisma must directly follow a pitched note; it cannot cross a rest.
hint: After a rest, start a new note with a lyric (for example the vowel of the previous mora).
```

つながった音符間のピッチ移行は `portamentoMs` (既定 60 ms、`0` で階段状)。

## 子音の借用と圧縮

母音を拍頭に乗せるため、子音は**前の休符や前の音符の末尾から借りる** (最大 40 %)。tempo 120 で `あ` → `きゃ` と並べた場合:

```json
{"id":"n1","lyric":"ア","startSeconds":0.16,"endSeconds":0.55,"vowelStartSeconds":0.16}
{"id":"n2","lyric":"キャ","startSeconds":0.55,"endSeconds":1.16,"vowelStartSeconds":0.66}
```

`n2` の拍頭は 0.66 秒だが、子音 `ky` のために 0.55 秒から始まり、`n1` はそのぶん短くなっている。**`startSeconds` は子音を含む開始時刻、`vowelStartSeconds` が拍頭**。タイミングを検証するときは `vowelStartSeconds` を見る。

借りても足りないときは子音を短縮し、`adjustments[]` に記録する:

```json
{"code":"CONSONANT_COMPRESSED","message":"Note n2: consonant shortened from 95 ms to 65 ms.",
 "noteId":"n2","path":"$.notes[1]","before":0.095,"after":0.0655}
```

45 % を下回るまで縮めると `CONSONANT_HEAVILY_COMPRESSED` の警告が出る。子音が潰れると歌詞が聞き取れなくなるので、**警告が出たらテンポを下げるか拍を増やす**。`consonantCompression: false` (`--no-consonant-compression`) にすると短縮せず `NOTE_TOO_SHORT` で失敗する — 品質を機械的に守りたいときはこちらが使える。

母音が 30 ms を切る音符は常に `NOTE_TOO_SHORT` になる。

## 音符ごとのパラメータ

| フィールド | 内容 |
| --- | --- |
| `id` | 安定した識別子 (既定 `n1`…)。`plan` とエラーに出る |
| `key` | MIDI 番号、音名 (`C4` `F#4` `Bb3`)、`null` (休符) |
| `beats` | 拍 (四分音符 = 1)。0.015625–64 |
| `lyric` | かな 1〜8 モーラ。`ー` は前の母音を伸ばす。休符は空 |
| `continuation` | `tie` / `melisma`。直前の有音音符に続く必要あり |
| `articulation` | `auto` (既定) / `legato` / `rearticulate` |
| `velocity` / `gainDb` | 1–127 (100 が基準) / dB。**排他** |
| `portamentoMs` | この音符への移行時間 |
| `vibrato` | `{depthCents, rateHz, delayMs, fadeMs}` または `false` (この音符だけ無効) |

## 曲全体のパラメータ

| フィールド (CLI フラグ) | 既定 | 範囲 | 内容 |
| --- | --- | --- | --- |
| `tempo` (`--tempo`) | 120 (MML に `t` があればその値) | 20–400 | BPM |
| `transpose` (`--transpose`) | 0 | −48..48 | 半音 |
| `voice` (`--voice`) | `neutral` | 7 種 | 読み上げと同じ内蔵ボイス |
| `vibrato` / `vibratoDepth` `vibratoRate` | 30 cent / 5.5 Hz | — | 既定は 180 ms 後から 250 ms かけて立ち上がる。depth 0 で無効 |
| `portamentoMs` (`--portamento-ms`) | 60 | ms | 0 で階段状 |
| `scoopCents` `scoopMs` | 0 / 80 | — | フレーズ頭のしゃくり |
| `consonantCompression` | true | — | false で子音短縮せず失敗させる |
| `leadIn` / `leadOut` | 0.16 / 0.16 | 秒 | 前後の休符 |
| `volume` / `gainDb` | 1 / — | 0–3 / −60..12 | **排他** |
| `breathiness` | 0 | −1..1.5 | 声門の張り |
| `sampleRate` / `seed` | 24000 / 1 | — | 出力レート / ノイズの種 |

ビブラートは持続母音ごとに掛かる。速いパッセージでは `delayMs` (既定 180) に届かず掛からないので、揺れが欲しければ `delayMs` を下げる。逆に短い音符が揺れて濁るなら音符ごとに `"vibrato": false` を置く。

## 音域

エンジンの合成範囲は **30–2500 Hz** かつサンプルレートの 20 % まで。外れると `PITCH_OUT_OF_RANGE` (終了コード 2):

```
The score spans 8372.0–8518.4 Hz; the engine synthesizes 30–2500 Hz at 24000 Hz.
repairOptions: lower-pitch ($.transpose) / raise-sample-rate ($.sampleRate)
```

ボイスごとの得意音域 (`f0Range`) を外れると `F0_OUTSIDE_VOICE_RANGE` の**警告**が出る。描画自体は通るが声質が崩れるので、`transpose` するかボイスを替える:

```
The score spans 1047–1047 Hz; voice deep is tuned for 45–600 Hz.
```

ボイスの `f0Range` は [speech.md](speech.md#内蔵ボイス) と `kongyoroid voices --engine formant`。

音高の精度は高い。持続した C4 (理論値 261.63 Hz) を `inspect` すると `medianHz: 261.4` — 約 1.5 セント差。

## MML

`t` テンポ、`o` オクターブ、`<` `>` オクターブ増減、`l` 既定音長、`v` ベロシティ、`n60` MIDI 番号、`r` 休符、`&` タイ / メリスマ、`.` 付点、`[きゃ]` その音符の歌詞。

```
t120 o4 l8 v110 c4. d n67 r4 e&e [きゃ]f
```

`c4.` = 付点四分音符 (0.75 秒 @120)、`n67` = MIDI 67 (G4)、`r4` = 四分休符、`e&e` = タイ (2 音目が `lyric: "ー"`, `continuation: "tie"`)、`[きゃ]f` = その音符の歌詞が `キャ`。`lyrics` を別に渡すと `[]` の無い音符に順に配られる。

MML は「旋律が先にあって歌詞は後」という作り方に向く。歌詞を音符ごとに細かく制御したいなら音符リストのほうが読みやすい。

## plan.notes を読む

```sh
kongyoroid plan --engine formant --input song.json | jq '.plan.notes'
kongyoroid plan --engine formant --input song.json | jq '.plan.f0'
```

各要素:

| キー | 意味 |
| --- | --- |
| `id` / `index` | 識別子と 0 始まりの位置 |
| `key` / `hz` | MIDI 番号 (休符は `null`) と実周波数 (`transpose` 適用後) |
| `lyric` | 実際に載ったかな。継続は `ー`、休符は空文字 |
| `startSeconds` | **子音を含む**開始時刻 |
| `vowelStartSeconds` | 母音の開始 = 拍頭。リズムの検証はこちら |
| `endSeconds` | 終了時刻 |
| `continuation` | `none` / `tie` / `melisma` |
| `articulation` | `onset` / `continue` / `rearticulate` |
| `sustainId` | 同じ値の音符は 1 本の持続音 |

## レビューの手順

1. `validate` で `renderable: true`、`notes` (音符数)、`estimate.durationSeconds` を確認する。
2. `adjustments[]` に `CONSONANT_COMPRESSED` があれば、どの音符でどれだけ縮んだか見る。歌詞が潰れる位置ならテンポか拍を直す。
3. `warnings[]` の `F0_OUTSIDE_VOICE_RANGE` は声質に直結する。`transpose` かボイス変更で解消する。
4. `plan.notes[]` で `vowelStartSeconds` が意図した拍に乗っているか、休符が入るべき場所に入っているか、伸ばしたい箇所の `sustainId` が同じかを確認する。
5. 描画して `inspect`。`pitch.medianHz` が狙いの音高帯にあるか、`clipped: 0` か、`voicedRatio` が極端に低くない (= 無声化しすぎていない) かを見る。
6. 聴ける環境なら子音の頭、持続母音の伸び、フレーズの継ぎ目を試聴する。聴けないなら「数値検査済み・聴感未確認」と明記する。
