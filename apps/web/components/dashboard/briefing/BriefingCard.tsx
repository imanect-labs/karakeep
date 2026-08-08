"use client";

import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  Bookmark,
  ExternalLink,
  FlaskConical,
  Heart,
  X as XIcon,
} from "lucide-react";

export interface BriefingItem {
  impressionId: string;
  candidateId: string;
  rank: number | null;
  arm: string | null;
  url: string;
  title: string | null;
  summary: string | null;
  titleJa: string | null;
  summaryJa: string | null;
  domain: string | null;
  domainStatus: string | null;
  isTrialDomain: boolean;
  publishedAt: Date | null;
  score: number | null;
  reason: string;
  clusterLabel: string | null;
  bookmarkId: string | null;
  events: string[];
}

/** 探索枠であることを明示する（FR-U-02 / FR-U-09）。 */
const ARM_LABELS: Record<string, string> = {
  exploit: "",
  adjacent: "隣接トピックの探索",
  uncertain: "反応が読めないので試している",
  trial: "試用中の情報源",
  random: "無作為に選ばれた",
};

export default function BriefingCard({
  item,
  onOpen,
  onSave,
  onLike,
  onDismiss,
  onViewed,
  busy,
}: {
  item: BriefingItem;
  onOpen: () => void;
  onSave: () => void;
  onLike: () => void;
  onDismiss: () => void;
  onViewed: () => void;
  busy: boolean;
}) {
  const ref = useRef<HTMLElement>(null);
  const reported = useRef(false);

  // FR-U-08: 50% 以上・1 秒以上入ったら viewed。この 2 条件が examined の
  // 判定の土台になっていて、ここが緩いと「見ていない記事」が比較対象に
  // 混ざって偽の負例になる。
  useEffect(() => {
    const element = ref.current;
    if (!element || reported.current) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          timer ??= setTimeout(() => {
            if (!reported.current) {
              reported.current = true;
              onViewed();
            }
            observer.disconnect();
          }, 1000);
        } else if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      },
      { threshold: 0.5 },
    );
    observer.observe(element);
    return () => {
      if (timer) {
        clearTimeout(timer);
      }
      observer.disconnect();
    };
  }, [onViewed]);

  const saved = item.events.includes("saved") || !!item.bookmarkId;
  const liked = item.events.includes("liked");
  const dismissed = item.events.includes("dismissed");
  const armLabel = item.arm ? ARM_LABELS[item.arm] : "";

  // 訳題があればそれを主表示にし、原題を小さく下に添える。ダイジェストが
  // まだ無い・失敗した記事は原題だけになる（原題の重複は出さない）。
  const original = item.title ?? item.url;
  const headline = item.titleJa ?? original;
  const subtitle = item.titleJa && item.titleJa !== original ? original : null;
  const summary = item.summaryJa ?? item.summary;

  return (
    <article
      ref={ref}
      className={cn(
        "flex flex-col gap-3 rounded-md border bg-background p-4 transition-opacity",
        dismissed && "opacity-40",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        {/*
          min-w-0 が無いと flex の子は既定で内容幅より縮まないので、長い
          タイトルや (title が null のときの) URL が画面外へはみ出す。
          スマホで「見づらい」の最大の原因はこれ。break-words と対で要る。
        */}
        <div className="flex min-w-0 flex-col gap-1">
          <a
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={onOpen}
            className="break-words text-lg font-medium hover:underline"
          >
            {headline}
          </a>
          {subtitle && (
            <p className="break-words text-xs text-muted-foreground/80">
              {subtitle}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground sm:text-xs">
            {item.domain && <span className="break-all">{item.domain}</span>}
            {item.publishedAt && (
              <span>{new Date(item.publishedAt).toLocaleDateString()}</span>
            )}
            {item.clusterLabel && (
              <span className="rounded bg-muted px-1.5 py-0.5">
                {item.clusterLabel}
              </span>
            )}
            {item.isTrialDomain && (
              <span className="flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                <FlaskConical className="size-3" />
                試用中の情報源
              </span>
            )}
          </div>
        </div>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          #{item.rank}
        </span>
      </div>

      {/*
        日本語要約は 120 字以内で作らせているので 4 行あれば大抵収まる
        （原文の summary に落ちたときだけ途中で切れる）。
      */}
      {summary && (
        <p className="line-clamp-4 break-words text-[0.9375rem] text-muted-foreground sm:text-sm">
          {summary}
        </p>
      )}

      <p className="break-words text-sm italic text-muted-foreground sm:text-xs">
        {item.reason}
        {armLabel && `（${armLabel}）`}
      </p>

      {/*
        スマホでは 4 つのボタンが中途半端に折り返して押しにくいので 2 列に
        並べ、タップ領域を 44px 確保する (sm の h-9 = 36px は指には小さい)。
      */}
      <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
        <Button
          variant="outline"
          size="sm"
          asChild
          onClick={onOpen}
          className="h-11 gap-1 sm:h-9"
        >
          <a href={item.url} target="_blank" rel="noopener noreferrer">
            <ExternalLink className="size-4" />
            開く
          </a>
        </Button>
        <Button
          variant={saved ? "default" : "outline"}
          size="sm"
          disabled={busy || saved}
          onClick={onSave}
          className="h-11 gap-1 sm:h-9"
        >
          <Bookmark className="size-4" />
          {saved ? "保存済み" : "保存"}
        </Button>
        <Button
          variant={liked ? "default" : "outline"}
          size="sm"
          disabled={busy}
          onClick={onLike}
          className="h-11 gap-1 sm:h-9"
        >
          <Heart className="size-4" />
          いいね
        </Button>
        {/*
          FR-U-05: 「興味なし」は 1 クリックで完了させる。理由の選択は任意。
          明示的な負例はこれしか取れないので、押すコストを最小にする。
        */}
        <Button
          variant="ghost"
          size="sm"
          disabled={busy || dismissed}
          onClick={onDismiss}
          className="h-11 gap-1 text-muted-foreground sm:h-9"
        >
          <XIcon className="size-4" />
          {dismissed ? "興味なしにした" : "興味なし"}
        </Button>
      </div>
    </article>
  );
}
