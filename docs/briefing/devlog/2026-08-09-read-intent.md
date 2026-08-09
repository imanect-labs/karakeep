# feat(briefing): 「訳して読む」を「保存」から分ける

- 作業日時: 2026-08-09
- 対応内容:
  - カードに「訳して読む」を追加。ブックマークは作るが `saved` を送らず、
    中立の `read_intent` を記録する
  - 観測窓を過ぎても何も起きなかった `read_intent` を `read_abandoned`
    （弱い負例）に確定させる
  - 要件に FR-U-14 を追加
- 変更したファイル:
  - `packages/recommender/src/reward.ts` / `reward.test.ts`
  - `packages/db/schema.ts`
  - `packages/trpc/routers/recommender.ts`
  - `apps/workers/workers/recommender/feedback.ts`
  - `apps/workers/workers/recommender/profiles.ts`
  - `apps/web/components/dashboard/briefing/BriefingCard.tsx`
  - `apps/web/components/dashboard/briefing/BriefingView.tsx`
  - `docs/briefing/requirements.md`
- 確認内容:
  - vitest 30 件（`reward.test.ts`。うち新規 8 件）
  - `pnpm typecheck`（recommender / workers / trpc / db / web / shared-server）

## 何が問題だったか

日本語で読みたいだけの記事にも「保存」を押すしかなく、**それが全イベント中で
最も重い正例になっていた**。

| 経路 | 内容 |
|---|---|
| 即時イベント | `recordEvent({eventType: "saved"})` |
| 重み | `saved` は 1.2 で最大（他の正例は 1.0） |
| 遅延報酬 | impression に `bookmarkId` が付き、7 日間 `read_full` 等を追う |

読むために押しただけの記事に 1.2 が付き続けると、興味の重心が実態から離れる。

### bootstrap は関係なかった

当初「ライブラリを全件走査する bootstrap も `saved` を書くので、そちらも
塞がないといけない」と考えたが、**誤りだった**。bootstrap の再取得は
`origin='bootstrap'` で絞っており（`bootstrap.ts` の「既に候補として入って
いるブックマークも拾い直す」ブロック）、Briefing 由来の候補は
`origin='collected'` なので拾われない。初回 insert も URL 一意制約で
conflict して何も返さない。よって専用タグによる除外は不要。

## 直し方

**ブックマークを作るところまでは同じ。** 翻訳はブックマーク単位のワーカー
（`runTranslation(bookmarkId, …)`）なので、ブックマークを作らずに全文を訳す
経路が無い。分けたのは**記録するイベントだけ**。

```
「保存」      → createBookmark → recordEvent("saved")        重み 1.2 の正例
「訳して読む」 → createBookmark → recordEvent("read_intent")  重み 0 の中立
```

遅延報酬（③）はそのまま両方に効く。訳して読んだだけなら `read_full` は
立たず、最後まで読んだりハイライトしたら立つ ── 「実際に良かったか」を
後から測る仕組みは元からあった。**押した瞬間に正例が確定してしまう点だけ**が
問題だったので、そこだけ直した。

## 弱い負例

`read_intent` を押したのに観測窓（7 日）を過ぎても engagement が 1 つも
付かなかったら、`read_abandoned` を派生させる。重み **-0.4**
（`dismissed` は -1.0）。

### 保守的に判定する

負例は偽陽性のコストが高い。興味の重心が実態からずれ、以後その方向の記事が
出なくなる。しかも本人には見えない。なので:

- **`read_partial` があるものは対象外。** 途中まで読んだのは engagement で
  あって空振りではない
- `dismissed` 済みも対象外。明示的な負例が既にある
- 判定は `isAbandonedRead()` に切り出して `reward.ts` に置いた
  （`finalizeObservation` / `isStrongPositive` と同じ場所）。テストもここ

### 順序が意味を持つ

`runRewardJoin` の中で **`joinDelayedRewards` の後・`finalizeRewards` の前**に
呼ぶ。前に置くと読了イベントが書かれる前に空振りと判定してしまい、後ろに
置くと `read_abandoned` が報酬計算に入らない。

### クラスタの負例には入れない

`refreshCounters` のクラスタ負例は `dismissed` だけのまま。クラスタの
カウントは整数で重みを付けられないので、足すと推測にすぎない空振りが
明示的な「興味なし」と同じ重さになる。弱い負例として扱いたい場所は、
重みを掛けられる `profiles.ts` のほう（0.5 で加算）。

## UI

ボタンが 5 つになった。スマホの 2 列グリッドでは「興味なし」を
`col-span-2` にして最終行いっぱいに置く。

「保存済み」の判定を `bookmarkId` の有無から `saved` イベントの有無に
変えた。**「訳して読む」でもブックマークは作られる**ので、`bookmarkId` を
保存の証拠にすると訳しただけの記事が「保存済み」と表示されてしまう。

## 残課題

- 「訳して読む」で取り込んだ記事もライブラリ（Inbox）に出る。アーカイブ状態で
  作れば隠せるが、「読んで良かったからアーカイブした」と区別が付かなくなるので
  今回は入れていない
- `read_abandoned` が実際にどれだけ出るかは運用してみないと分からない。
  出過ぎるようなら重み -0.4 か窓の長さを見直す
