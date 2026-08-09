# fix(briefing): ページ送りで一番下に留まるのを直す

- 作業日時: 2026-08-09
- 対応内容:
  - ページ送り後のスクロールを、クリックハンドラ内から `useEffect` に移す
- 変更したファイル:
  - `apps/web/components/dashboard/briefing/BriefingView.tsx`
  - `docs/briefing/devlog/2026-08-09-pagination-scroll-fix.md`
- 確認内容:
  - `pnpm typecheck` / `lint`
- 残課題: なし

## 症状

ページネーションのボタンを押すと、**表示は切り替わるがスクロール位置が一番下の
ままになる**。ボタンはリストの末尾にあるので、次のページの最後だけが見えている
状態になり、上に戻さないと読めない。

## 原因

`scrollIntoView` を**クリックハンドラの中で**呼んでいた。

```tsx
const goToPage = useCallback((next: number) => {
  setPage(next);
  listRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });  // ← ここ
}, []);
```

`setPage` の直後はまだ再レンダリング前で、DOM は旧ページのまま。そこから
smooth スクロールが走り出すが、直後に React が 10 枚のカードを丸ごと差し替える。
**ブラウザはスクロール中にコンテンツの高さが変わるとプログラムによる
スクロールを打ち切る**ので、動き出してすぐ止まり、元の位置＝一番下に留まる。

## 直し方

DOM が入れ替わったあとに動かす。`page` を依存にした `useEffect` にする。

```tsx
const isFirstRender = useRef(true);
useEffect(() => {
  if (isFirstRender.current) {   // 初回マウントでは動かさない
    isFirstRender.current = false;
    return;
  }
  listRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
}, [page]);
```

`useLayoutEffect` ではなく `useEffect` にしているのは、**描画後に走るほうが
レイアウトが確定していて安全**なため。`useLayoutEffect` は DOM 変更直後・
描画前なので、条件によっては古い座標を使いうる。

## スクローラはどこか

`SidebarLayout` を読むと、**`sm` 以上では window ではなく `<main>` が
スクローラ**になっている。

```tsx
<div className="sm:fixed sm:inset-0 sm:overflow-hidden">   // window は動かない
  <main className="flex-1 ... sm:overflow-y-auto">          // ← これがスクローラ
```

スマホ（`sm` 未満）では `sm:` が効かないので window がスクロールする。
`scrollIntoView` は直近のスクロール可能な祖先を動かすので、両方これで足りる。
`scroll-mt-4` を付けてあるので上に 1rem の余白が残る。
