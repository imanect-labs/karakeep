# fix(recommender): ブートストラップがプロフィールに届いていなかった

- 作業日時: 2026-08-08
- 対応内容:
  - ブートストラップが `recFeedbackEvents` を書くようにした。
  - ブックマークしたこと自体を正例として扱うようにした。
- 変更したファイル:
  - `apps/workers/workers/recommender/bootstrap.ts`
  - `docs/briefing/devlog/2026-08-08-bootstrap-profile-fix.md`

## 症状

本番投入初日、「推薦に興味のある記事が全然ない」という指摘。

実データを見ると原因は明白だった。

```
favourited = 0    highlights = 0    reading>=60% = 3
recProfiles: stable / recent / negative = すべて NULL
```

**プロフィールのベクトルが 3 本とも null。** つまり `exploit` アーム
(枠の 55%) が、参照すべき興味を 1 つも持たないまま動いていた。
残りも adjacent (プロフィール依存) が 20% あるので、実質 75% の枠が
機能していなかった。

## 原因

2 段構えで壊れていた。

### 1. ブートストラップが `recFeedbackEvents` を書いていない

プロフィールの重心は `recFeedbackEvents` を起点に組み立てられる。

```ts
// profiles.ts の loadSamples
.from(recFeedbackEvents)
.innerJoin(recImpressions, ...)
.innerJoin(recCandidates, ...)
```

ところが `writeBootstrapImpressions` は `recImpressions` に
`rewardValue: 1` の行を作るだけで、**イベントを 1 件も書いていなかった**。
起点が無いので、ライブラリ 95 件はプロフィールに一切入らない。

`bootstrap.ts` 自身のコメントに「コールドスタートの解消がこの機能の最大の
利点」と書いてあるのに、その主目的が成立していなかった。

### 2. 正例の定義が狭すぎる

正例はお気に入り・ハイライト・読了 60% 以上のみ。この 3 つを使わない
ユーザでは **95 件中 3 件**しか拾えない。仮に 1 を直しても 3 件では
プロフィールとして使い物にならない。

**ブックマークしたこと自体が意図的な正例**であり、実際 `DEFAULT_REWARD_WEIGHTS`
でも `saved` は **1.2 と全イベント中で最大**。設計は保存を最強の信号と
みなしているのに、ブートストラップだけがそれを捨てていた。

## 対応

`writeBootstrapImpressions` を書き直した。

- 取り込んだ**全ブックマーク**に impression を作る (以前は正例 3 件のみ)。
- **`recFeedbackEvents` に `saved` を書く**。これでライブラリがプロフィールに入る。
- お気に入り・ハイライト・読了は種別を保って追加のイベントも書く。
  以前は Set だったので種別が消えていた (実際は読了なのに `favourited` として
  記録すると報酬の重みが変わる)。Map に変えて種別を持ち回る。
- `occurredAt` はブックマークの作成時刻を使う。`now` にすると全件が同時刻の
  扱いになり、recent プロフィールの半減期 (7 日) が意味を失う。
- `rewardValue` は `saved` の重みを基準にし、強い正例はその分を上乗せする。

## 効果の見込み

プロフィールの材料が **3 件 → 95 件**になる。全 95 件が 30 日以内なので、
180 日のプロフィール窓にすべて入る。

## 確認内容

- `tsc --noEmit` / `oxlint` / `oxfmt` が通ること。
- 再ブートストラップ後に `recProfiles` の stable/recent/negative が
  null でなくなること。
- 再 rank 後の Briefing の内容が改善すること。

## 残課題

- 既存の impression には `onConflictDoNothing` が効くので、再実行しても
  重複はしないが、**既に入っている 3 件ぶんの impression は残る**。
  実運用では候補が重複しないよう `recCandidates` 側で弾かれる。
- 正例が増えることで negative プロフィールとの分離がどう変わるかは、
  数日運用して観測率とあわせて見る必要がある。
