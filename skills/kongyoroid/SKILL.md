---
name: kongyoroid
description: >-
  npm の @kongyo2/kongyoroid の内蔵 formant エンジンで、日本語の読み上げ・ナレーション・通知音声・歌唱の WAV を作る。
  日本語のテキスト読み上げ、音声合成、TTS、ナレーション音声、ボイス通知、しゃべらせる、歌わせる、歌唱合成、
  かな・アクセント・読み方の確認、MML や楽譜からの歌声、WAV の生成を頼まれたら、
  ユーザーが kongyoroid と名指ししていなくても必ずこのスキルを使う。
  CLI (speak / sing / render / validate / plan / reading / batch / inspect / dict / cache) と
  ESM ライブラリ (Kongyoroid クラス) の導入・実装・レビュー・修正、固有名詞や数詞の読み間違いの調整、
  ストリーミング再生の実装にも使う。
  Japanese text-to-speech, singing synthesis, narration WAV, kana reading and pitch-accent checking with kongyoroid.
  音声認識・文字起こし、日本語以外の音声合成には使わない。
license: MIT
compatibility: >-
  Node.js 22.18 以上 (ESM)。npm の @kongyo2/kongyoroid のみを使う。内蔵 formant エンジン専用で、
  外部サービス・GPU・実行時のネットワークは不要。
---

# kongyoroid で日本語音声をつくる

`@kongyo2/kongyoroid` の**内蔵 formant エンジン**で、原稿・譜面の意図を保ったまま WAV を作る。

このエンジンは**決定的**で、同じリクエスト・同じ `seed`・同じバージョンからは常にビット単位で同じ WAV が出る。つまり品質を上げる方法は「何度も鳴らして当たりを待つ」ことではない。**読み・音符・時刻を JSON で先に確認し、直してから 1 回描画する**のが最短かつ唯一の道になる。`validate` と `plan` は音声を書かないので、これらを飛ばす理由はない。

## 最初に押さえること: `ok: true` は「正しく読めた」ではない

フロントエンド (jpreprocess + NAIST-JDic) は**読めなかった部分を黙って落とす**か、**もっともらしい別の読みを返す**ことがある。どちらも警告なしで `ok: true` になる。

| 入力 | 実際の読み | 起きたこと |
| --- | --- | --- |
| `二文目。` | `ニア'ヤメ。` | 誤読 |
| `3件` | `サン'ゲン` | 助数詞の取り違え。3 で終わる数すべてで起きる |
| `12件` | `ジュー/ニ'ケン` | 複合数詞が 2 句に割れ、数がひと続きに聞こえない |
| `完了しました🎉` | `カンリョー/シマ'_シタ。` | 絵文字が消える |
| `简体` | `タイ。` | 簡体字専用の字が消える |
| `user@example.com` | `ユーエスイーアール、アットマ'ーク、…` | 1 文字ずつ読む |

だから**必ず `reading` か `plan` の `kana` を原稿と突き合わせる**。固有名詞・数値と助数詞・同音異義語・英単語・記号を優先して見る。数値は値ごとに読みが変わるので、**実行時に値が変わる原稿では読みの検査もパイプラインに組み込む** — 1 度直した `kana` は次の値で壊れる。

直し方は `dictionary` か `kana`。ただし辞書は句の切れ方も変えるし、隣接する語を両方登録すると語が二重に読まれることがあるので、**足したあとに `kana` 全体を読み直す**。詳細は [speech.md](references/speech.md)。

一方 `彁` やハングル・キリル文字のように「フロントエンドが確実に落とす」と判定できた文字は `UNREADABLE_TEXT` で終了コード 2 になる。これを黙らせるために文字を削ったり `strictReading: false` にしたりしないこと。読みを与えるのが正しい直し方。

## 導入

```sh
npm install --save-exact @kongyo2/kongyoroid
npx kongyoroid doctor --engine formant
```

- `doctor` の `ok: true`、`formant.frontend.available: true`、`formant.synthesis.ok: true` を確認する。ここが通れば以降ネットワークは要らない。
- 既存プロジェクトでは lockfile の版を尊重し、無断で上げない。版を確かめるには `npx kongyoroid --version` と `npx kongyoroid capabilities`。
- 日本語フロントエンドは WebAssembly で約 20 MB あり、**プロセスごとに初回 0.6〜1.2 秒**かかる。以降は同一プロセス内で再利用される。多数の音声を作るなら CLI を何度も起動せず `batch` かライブラリを使う (→ [library.md](references/library.md))。
- 導入済みの版に対する正確な仕様は `node_modules/@kongyo2/kongyoroid/` の `docs/cli.md`、`examples/builtin/*.json`、`dist/*.d.ts` にある。**フラグや JSON フィールドを推測しない**。`kongyoroid <command> --help` と `kongyoroid schema --kind request` が一次情報。

## 作業の流れ

読み確認 → 検証 → 計画 → 描画 → 検査。前の 3 つは音声を書かないので、失敗しても副作用がない。

```sh
K=./node_modules/.bin/kongyoroid

# 1. 読みを見る (テキスト読み上げのとき)
$K reading --text "リリースは2026年9月7日、テストは3件失敗しました。"

# 2. 構造と意味を検証し、尺・ハッシュを得る
$K validate --engine formant --input request.json

# 3. 時刻表を見る (歌唱、または語尾・間が問題のとき)
$K plan --engine formant --input request.json

# 4. 描画
$K render --engine formant --input request.json --output out.wav

# 5. 出力を数値で検査
$K inspect out.wav
```

短い一発ものならリクエスト JSON を作らず `speak` / `sing` で足りる。ただし**分岐する設定や辞書が絡むなら JSON を書く**ほうが、差分が追え、`--dry-run` で同じ入力を検証でき、後から再現できる。

```sh
$K speak --text "ビルドが完了しました。" --voice soft -o done.wav
$K sing --lyrics "きらきらぼしー" --melody "C4 C4 G4 G4 A4 A4 G4 ~ R" \
        --beats "1 1 1 1 1 1 1 1 2" --tempo 100 -o twinkle.wav
```

`speak` / `sing` / `render` に `--dry-run` を付けると `validate` と同じ結果だけを返し、何も書かない。

## 守ること

**エンジンとパラメータを JSON に書き切る。** リクエストに `"engine": "formant"`、CLI に `--engine formant` を書く。既定値は環境変数 (`KONGYOROID_ENGINE` `KONGYOROID_VOICE` `KONGYOROID_DICTIONARY` `KONGYOROID_CACHE_DIR`) で動くので、再現性が要るなら値をリクエスト側に持たせる。何が実際に効いているかは `validate` の `request` (既定値まで展開された正規化リクエスト) で確認できる。

**上書きは事故を防ぐ側に倒す。** 同じ内容の再描画は `written: false, unchanged: true` で成功する no-op。内容が違うと `IO_ERROR` (終了コード 4) で止まる。ここで反射的に `--force` を足さない。**別名で書くのが既定**で、`--force` はユーザーがその置換を頼んだときだけ。

**失敗はコードで分岐する。** メッセージは人向けで変わり得る。`error.code`、`error.path` (`$.notes[1].beats` のような JSON Pointer 風)、`error.repairOptions[].action` (`provide-kana`、`increase-duration` など) が機械可読な契約。終了コードは 0 成功 / 1 内部 / 2 入力 / 3 エンジン / 4 入出力 / 130 中断。対処は [troubleshooting.md](references/troubleshooting.md)。

**`warnings[]` と `adjustments[]` を読む。** `warnings` は読みや音域への助言、`adjustments` はエンジンが勝手に変えたこと (子音の短縮など)。どちらも `ok: true` の中に入るので、成功を見ただけで閉じない。

**変更したら検証をやり直す。** 設定を 1 つ変えれば `planHash` も出音も変わる。長い制作物では、問題のある短い抜粋で設定を詰めてから全体を描画するほうが速い。

## 仕上げ

- `inspect` で `finite: true`、`clipped: 0`、意図した `durationSeconds` と `sampleRate`、`peak` が無音でないことを確認する。歌唱なら `pitch.medianHz` が狙いの音高帯にあるかも見る。
- `limitedSamples` が大きい (リミッターが働いた) なら `gainDb` を下げて描画し直す。`gainDb` の範囲は −60〜12 で、`volume` とは排他。RMS を知覚音量や LUFS の代用にしない。
- 聴ける環境なら冒頭・末尾、直した語、文境界、歌の子音と持続母音を試聴する。**聴けないなら「数値検査済み・聴感未確認」と明記する**。formant は声道と音源をモデル化した合成音声で、数値が揃っても人間らしさは保証されない。
- 納品は WAV を主に、再現に必要なリクエスト JSON・辞書・採用した設定を添える。作った音声、残っている読みの不安や警告、試聴したかどうかを短く伝える。

## 必要になったときだけ読む

| 知りたいこと | 参照先 |
| --- | --- |
| コマンドとフラグ、出力 JSON の各フィールド | [references/cli.md](references/cli.md) |
| 読み・アクセント・かな記法・辞書・話速や抑揚などの韻律 | [references/speech.md](references/speech.md) |
| 譜面の 3 形式、モーラ配分、タイ / メリスマ、音域、ビブラート | [references/singing.md](references/singing.md) |
| ESM ライブラリ、ストリーミング、バッチ、キャッシュ | [references/library.md](references/library.md) |
| エラーコードごとの原因と直し方、警告一覧、既知の落とし穴 | [references/troubleshooting.md](references/troubleshooting.md) |

公式 CLI と公式 API をそのまま使う。作業用のコマンドが要るなら、作業ディレクトリ側に使い捨てで書く。
