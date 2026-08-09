"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Compass, Sparkles } from "lucide-react";

import { paginate } from "@/lib/pagination";

import { useCreateBookmarkWithPostHook } from "@karakeep/shared-react/hooks/bookmarks";
import { useTRPC } from "@karakeep/shared-react/trpc";
import { BookmarkTypes } from "@karakeep/shared/types/bookmarks";

import type { BriefingItem } from "./BriefingCard";
import BriefingCard from "./BriefingCard";
import DiscoveryBlock from "./DiscoveryBlock";
import InterestPanel from "./InterestPanel";

/**
 * 1 ページに出す件数。1 日 30 件を一度に並べると縦に長すぎて、どこまで
 * 読んだか分からなくなる。
 *
 * 学習側への影響は無い。`finalizeObservation` は「最深到達ランクまでを
 * examined とみなす」前置き方式なので、ページを送って読み進めた分だけ
 * 正しく examined になる。むしろ 30 枚を一気にスクロールで流すより、
 * 実際に読んだ深さが素直に出る。
 */
const PAGE_SIZE = 10;

export default function BriefingView() {
  const api = useTRPC();
  const queryClient = useQueryClient();
  const [date, setDate] = useState<string | undefined>(undefined);
  const [page, setPage] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const briefing = useQuery(api.recommender.getBriefing.queryOptions({ date }));
  const dates = useQuery(
    api.recommender.listBriefingDates.queryOptions({ limit: 14 }),
  );

  const briefingId = briefing.data?.id ?? null;
  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries(
      api.recommender.getBriefing.pathFilter(),
    );
  }, [api, queryClient]);

  const recordEvent = useMutation(
    api.recommender.recordEvent.mutationOptions({ onSuccess: invalidate }),
  );
  const markOpened = useMutation(api.recommender.markOpened.mutationOptions());
  const markViewed = useMutation(api.recommender.markViewed.mutationOptions());
  const { mutateAsync: createBookmark } = useCreateBookmarkWithPostHook();

  // FR-U-11: 開いた時点で opened を送る。これが無い Briefing は
  // `unobserved` のままで、学習にも指標にも一切入らない。
  const openedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!briefingId || openedFor.current === briefingId) {
      return;
    }
    openedFor.current = briefingId;
    markOpened.mutate({ briefingId });
    // markOpened は毎回作り直されるので依存に入れない。
    // oxlint-disable-next-line exhaustive-deps
  }, [briefingId]);

  // viewed はカードごとに飛ぶので、100ms ぶん束ねてから 1 回で送る。
  // 20 枚を一気にスクロールしたときに 20 リクエスト出すのは無駄。
  const pending = useRef<Set<string>>(new Set());
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reportViewed = useCallback(
    (impressionId: string) => {
      if (!briefingId) {
        return;
      }
      pending.current.add(impressionId);
      flushTimer.current ??= setTimeout(() => {
        const ids = [...pending.current];
        pending.current.clear();
        flushTimer.current = null;
        if (ids.length > 0) {
          markViewed.mutate({ briefingId, impressionIds: ids });
        }
      }, 100);
    },
    // oxlint-disable-next-line exhaustive-deps
    [briefingId],
  );

  const items = useMemo(
    () => (briefing.data?.items ?? []) as BriefingItem[],
    [briefing.data],
  );

  // 日付を切り替えたら 1 ページ目に戻す。
  useEffect(() => {
    setPage(0);
  }, [date]);

  const {
    pageCount,
    currentPage,
    pageStart,
    items: visibleItems,
  } = paginate(items, PAGE_SIZE, page);

  // ページを送ったら先頭へ。送った先の途中から始まると、読み飛ばしたのか
  // 分からなくなる。
  //
  // **クリックハンドラの中で scrollIntoView を呼んではいけない。** そこで
  // 呼ぶとまだ旧レイアウトのままで、smooth スクロールが走っている最中に
  // React が 10 枚のカードを差し替える。ブラウザはスクロール先の高さが
  // 変わるとアニメーションを打ち切るので、**一番下に留まったままになる**
  // (実際にそうなっていた)。DOM が入れ替わったあとに動かす必要がある。
  //
  // sm 以上ではスクローラは window ではなく <main> (SidebarLayout の
  // sm:overflow-y-auto)。scrollIntoView は直近のスクロール可能な祖先を
  // 動かすので、スマホ (window スクロール) と両方これで足りる。
  const isFirstRender = useRef(true);
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    listRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [page]);

  /**
   * FR-U-04: 既存のブックマーク作成フローをそのまま呼ぶ。crawl・要約・
   * タグ付け・翻訳が通常どおり走る。
   *
   * 記録するイベントだけを呼び分ける。ブックマークを作るところまでは
   * 「保存」も「訳して読む」も同じ — 翻訳はブックマーク単位のワーカーなので、
   * ブックマークを作らずに全文を訳す経路が無い。
   */
  const takeIntoLibrary = useCallback(
    async (item: BriefingItem, eventType: "saved" | "read_intent") => {
      const bookmark = await createBookmark({
        type: BookmarkTypes.LINK,
        url: item.url,
      });
      await recordEvent.mutateAsync({
        impressionId: item.impressionId,
        eventType,
        bookmarkId: bookmark.id,
      });
    },
    [createBookmark, recordEvent],
  );

  if (briefing.isPending) {
    return <p className="text-muted-foreground">読み込んでいます…</p>;
  }

  const data = briefing.data;
  const isEmpty = !data?.id || items.length === 0;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-2">
          <Sparkles className="size-5 shrink-0" />
          <h1 className="text-xl sm:text-2xl">今日の Briefing</h1>
          {data?.briefingDate && (
            <span className="shrink-0 text-sm text-muted-foreground">
              {data.briefingDate}
            </span>
          )}
          {items.length > 0 && (
            <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
              {pageCount > 1
                ? `${pageStart + 1}–${pageStart + visibleItems.length} / ${items.length} 件`
                : `${items.length} 件`}
            </span>
          )}
        </div>
        {/* 日付が 14 個並ぶと折り返して縦に伸びるので、スマホでは横スクロール。 */}
        {(dates.data?.length ?? 0) > 1 && (
          <div className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0">
            {dates.data?.map((d) => (
              <Button
                key={d.briefingDate}
                size="sm"
                className="h-9 shrink-0"
                variant={
                  d.briefingDate === data?.briefingDate ? "default" : "ghost"
                }
                onClick={() => setDate(d.briefingDate)}
              >
                {d.briefingDate.slice(5)}
              </Button>
            ))}
          </div>
        )}
      </header>

      {isEmpty ? (
        // NFR-09: 候補が 1 件も無い日も空の Briefing を出して、その旨を伝える。
        // 黙って何も出さないと、壊れているのか候補が無いのか区別できない。
        <div className="rounded-md border bg-background p-6 text-center text-muted-foreground">
          <Compass className="mx-auto mb-2 size-6" />
          <p>まだ Briefing がありません。</p>
          <p className="mt-1 text-sm">
            収集元を登録し、夜間の収集ジョブが 1 度走ると表示されます。
          </p>
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div
            ref={listRef}
            className="flex min-w-0 scroll-mt-4 flex-col gap-3"
          >
            {visibleItems.map((item) => (
              <BriefingCard
                key={item.impressionId}
                item={item}
                busy={recordEvent.isPending}
                onViewed={() => reportViewed(item.impressionId)}
                onOpen={() =>
                  recordEvent.mutate({
                    impressionId: item.impressionId,
                    eventType: "clicked",
                  })
                }
                onSave={() => void takeIntoLibrary(item, "saved")}
                onReadTranslated={() =>
                  void takeIntoLibrary(item, "read_intent")
                }
                onLike={() =>
                  recordEvent.mutate({
                    impressionId: item.impressionId,
                    eventType: "liked",
                  })
                }
                onDismiss={() =>
                  recordEvent.mutate({
                    impressionId: item.impressionId,
                    eventType: "dismissed",
                  })
                }
              />
            ))}

            {pageCount > 1 && (
              <nav
                aria-label="Briefing のページ"
                className="flex items-center justify-between gap-2 pt-1"
              >
                <Button
                  variant="outline"
                  size="sm"
                  className="h-11 gap-1 sm:h-9"
                  disabled={currentPage === 0}
                  onClick={() => setPage(currentPage - 1)}
                >
                  <ChevronLeft className="size-4" />
                  {/* 幅の狭い端末ではラベルを短くする。番号ボタンと並ぶと 375px に収まらない。 */}
                  <span className="hidden sm:inline">前の {PAGE_SIZE} 件</span>
                  <span className="sm:hidden">前へ</span>
                </Button>
                {/* ページ数は 3 個程度なので番号を全部出す。 */}
                <div className="flex gap-1">
                  {Array.from({ length: pageCount }, (_, i) => (
                    <Button
                      key={i}
                      size="sm"
                      variant={i === currentPage ? "default" : "ghost"}
                      aria-current={i === currentPage ? "page" : undefined}
                      className="h-11 w-11 p-0 tabular-nums sm:h-9 sm:w-9"
                      onClick={() => setPage(i)}
                    >
                      {i + 1}
                    </Button>
                  ))}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-11 gap-1 sm:h-9"
                  disabled={currentPage === pageCount - 1}
                  onClick={() => setPage(currentPage + 1)}
                >
                  <span className="hidden sm:inline">次の {PAGE_SIZE} 件</span>
                  <span className="sm:hidden">次へ</span>
                  <ChevronRight className="size-4" />
                </Button>
              </nav>
            )}
          </div>

          {/*
            件数を増やすとサイドバーがカードの遥か下に埋もれる。スマホでは
            折りたたみにして先頭に出し、開いたときだけ場所を取るようにする。
            lg 以上は今までどおり右の常設カラム。
          */}
          <aside className="order-first lg:order-none">
            <details className="rounded-md border bg-background lg:hidden">
              <summary className="cursor-pointer list-none p-3 text-sm font-medium">
                発見と興味の現在地
              </summary>
              <div className="flex flex-col gap-4 border-t p-3">
                <DiscoveryBlock />
                <InterestPanel />
              </div>
            </details>
            <div className="hidden flex-col gap-4 lg:flex">
              <DiscoveryBlock />
              <InterestPanel />
            </div>
          </aside>
        </div>
      )}
    </div>
  );
}
