# fix(recommender): ブートストラップの冪等化と、rank 再実行によるフィードバック消失

- 作業日時: 2026-08-08
- 対応内容:
  - ブートストラップが既存候補も対象にするようにした（冪等化）。
  - rank の再実行がユーザのフィードバックを消す問題を直した。
- 変更したファイル:
  - `apps/workers/workers/recommender/bootstrap.ts`
  - `apps/workers/workers/recommender/rank.ts`
  - `docs/briefing/devlog/2026-08-08-bootstrap-idempotent-and-feedback-loss.md`

## 1. ブートストラップが冪等でなかった

`recFeedbackEvents` を書く修正 (`2026-08-08-bootstrap-profile-fix.md`) を入れて
本番で再実行したところ、

```
[recommender][bootstrap][814] scanned 95, imported 0, 0 positives
```

**何も起きなかった。**

`onConflictDoNothing` の `returning` は新規挿入行しか返さない。候補の取り込みだけ
先に済んでいたブックマークは `importedByBookmark` に入らず、impression も
イベントも作られない。**何度回しても既存の 95 件は永久に埋まらない。**

修正前の状態を本番で直すには DB の backfill が必要だった (91 件を手で投入)。

### 対応

候補の挿入後に `bookmarkId` で既存候補を引き直し、対象に含めるようにした。
あわせて `writeBootstrapImpressions` で「既に impression がある候補」を弾く。
弾かないと、冪等化した結果として再実行のたびに正例が二重に積み上がる。

## 2. rank の再実行がフィードバックを消していた

同じ日に rank を流し直したところ、その日の `recFeedbackEvents` が
**すべて消えた** (viewed 42 / clicked 3 / dismissed 6 / liked 1 / saved 1)。

原因は `ensureBriefing` の再実行パス。

```ts
await db.delete(recImpressions).where(eq(recImpressions.briefingId, existing[0].id));
```

`recFeedbackEvents.impressionId` は `onDelete: "cascade"` なので、impression を
消すと**ユーザの操作履歴が道連れで消える**。コメントには「観測ログが壊れるので
作り直す」とあり、意図は分かるが、実際には壊すどころか消していた。

`dismissed` が消えると negative プロフィールが作れなくなるので、学習にも直接効く。
実際、消失後のプロフィールは `stable=1 / recent=1 / negative=0` になっていた。

### 対応

**フィードバックが付いている impression は残す**ようにした。反応済みのものを
残しても実害は無い。`examined` と報酬の計算は impression 単位で閉じているので、
履歴が二重に効くことはない。

## 教訓

`onDelete: cascade` を張った先を消す処理は、**何が道連れになるかを消す側で
明示的に確認する**必要がある。ここでは「impression を作り直す」という意図に
対して、実際の影響は「その日のユーザ操作の全消去」だった。

## 確認内容

- `tsc --noEmit` / `oxlint` / `oxfmt` が通ること。
- 再ブートストラップで既存候補にも impression とイベントが作られること。
- 同じ日に rank を 2 回流してもフィードバックが残ること。

## 残課題

- 本番で失われた 2026-08-08 分のフィードバックは復旧できない。
  ライブラリ 91 件の `saved` が支配的なので、プロフィールへの実害は限定的。
