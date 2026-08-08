# feat(recommender): 推薦と提示 — プロフィール・枠の混合・rankWorker・Briefing ページ

- 作業日時: 2026-08-07
- 対応フェーズ: Phase 1 統合実装 / D. 推薦と提示

**ここまでで毎朝 Briefing が出る。**

## 対応内容

### `profile.ts` — 4 種のプロフィール

重心は L2 正規化して返す。**件数でスコアの絶対値が動くと、しきい値が日ごとに
意味を変えてしまう**ため。正例が 1 件も無い初日は null を返し、スコアリング側で
0 として扱う。

`profileHash` は §12 の「その時点のプロフィールのハッシュ」。履歴を持たずに
同一性だけ判定できればよい。浮動小数の下位ビットで揺れないよう、有効数字を
落としてから混ぜる。

### `model/heuristic.ts` — `heuristic-v1`

ログが貯まるまでの数か月はこれが本番の推薦器になる。「そこそこ妥当」では
足りず、段階的有効化の判断ゲート（exploit 枠が random 枠を上回るか）を
通る必要がある。

判断が入ったところ:

- 否定プロフィールとの近さは**減点のみ**。負の相関を加点にしない
  （「嫌いなものと逆」であることに意味は無い）
- 日付の無い候補の鮮度は最下位ではなく中庸（0.5）。最下位にすると、日付を
  出さないフィードの記事が永久に出ない
- 重複ペナルティは対数。2 回目と 3 回目の差は大きいが、20 回目と 21 回目の
  差は小さい

### `arms.ts` — 枠の混合

**枠の順序が意味を持つ。`trial` を最初に取る。** 最後に回すと、多様性制約で
席が埋まったあとに試用記事が入る余地が無くなり、ソース探索が静かに死ぬ。
`exploit` は候補が最も多いので最後でも困らない。

スロット配分は**探索側を切り上げ**、余りを exploit で吸収する。floor で
削られると 20 件中 10% の `uncertain` が 2 件のはずが 1 件になる。

`uncertain` はスコア上位 30% に絞ってから不確実性順（FR-R-03c）。絞らないと
「有望ではないが単に特徴が外れ値なだけの記事」が毎回選ばれる。

### `rankWorker`

- `exploit` / `adjacent` / `trial` は温度つき softmax の非復元抽出。
  **propensity を実値で残す**
- 提示されなかった上位 100 件も `shown=false` で記録
- 特徴量スナップショット・profileHash・提示時点のドメイン状態と事後を記録。
  いずれも後から復元できない
- 同じ日に再実行されたら既存 impression を消してから作り直す

### `bootstrap`

既存ブックマークを `origin='bootstrap'` / `status='promoted'` で候補プールへ。
正例には `source='bootstrap'` の impression を付ける。**提示されていないので
`examined` の分母にもペア生成にも入らない**。プロフィール構築専用。

### tRPC ルータと Briefing ページ

`/dashboard/briefing` を 1 ページ追加。カード一覧・4 操作・選定理由・
「今日の新しい発見」・「興味の現在地」・過去日の遡り。

- 「保存」は `api.bookmarks.createBookmark` をそのまま呼ぶ（FR-U-04）。
  crawl・要約・タグ付け・翻訳が通常どおり走る
- 「興味なし」は 1 クリック。理由入力は付けていない（FR-U-05）
- `viewed` は IntersectionObserver（50% 以上・1 秒以上）で送り、100ms 束ねて
  1 リクエストにする
- 観測率をパネルに常時出す。**すべての完了条件と中止基準の基準値**なので、
  60% を割ったら精度より先に運用を直す合図になる

## 見つけた不具合 2 件

### 1. ブートストラップした既存ブックマークが埋め込まれない

`embedWorker` の未処理候補クエリが `status='active'` で絞っていた。
ブートストラップ候補は `promoted` で入るので 1 件も拾われず、**新規性の
特徴量（1 − 既存ブックマークとの最大コサイン）が永久に 0**になっていた。
エラーは出ず、スコアが少し鈍るだけなので気づきにくい。

### 2. 試用の提示カウントがドメイン単位だった

FR-D-13 は「最大 6 記事」だが、`trialImpressionCount` をドメインごとに
+1 していた。同じ日に 2 件出た分が数えられず、**試用がいつまでも終わらない**。
記事数で数えるよう修正。

## 変更したファイル

- `packages/recommender/src/{profile,arms}.ts`、`src/model/heuristic.ts`（新規）
- `apps/workers/workers/recommender/{rank,profiles,bootstrap}.ts`（新規）
- `apps/workers/workers/recommender/{embed,index}.ts`
- `packages/trpc/routers/recommender.ts`（新規）、`_app.ts`
- `packages/shared/types/apiKeys.ts`（`recommender` スコープ）
- `apps/web/app/dashboard/briefing/page.tsx`（新規）
- `apps/web/components/dashboard/briefing/*`（新規 3 コンポーネント）
- `apps/web/app/dashboard/layout.tsx`、i18n（en / ja）

## 確認内容

- `pnpm --filter @karakeep/recommender test` — 274 件 pass
- `typecheck` / `lint` / `format` — 7 パッケージすべて pass
- **疎通確認（bootstrap → embed → rank）**
  - 既存ブックマーク 4 件を取り込み、埋め込みまで到達
  - 候補 24 件が重複排除で 13 件になり、5 クラスタに分かれる
  - 枠が `trial` 2 / `uncertain` 2 / `random` 1 / `exploit` 1 で混ざる
  - propensity が枠ごとに異なる実値で入る（trial 0.032、uncertain 0.100、
    random 0.025、exploit 0.550）
  - 多様性制約（同一ドメイン最大 2 件）が効いて 6 件で打ち止めになる
  - `lastSelectedAt` が選ばれたドメインだけ進み、`trialImpressionCount` が
    記事数で増える

## 残課題

- `train` / `reward_join` は未実装（E で対応）
- `examined` の確定と観測状態の日次確定は E
- クラスタラベルの LLM 生成は未実装（UI ではクラスタ id で代替表示）
- `adjacent` 枠は候補が少ないと 0 件になる。実データで枠が埋まるか要観察
