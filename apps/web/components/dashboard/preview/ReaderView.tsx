import { useState } from "react";
import { FullPageSpinner } from "@/components/ui/full-page-spinner";
import { toast } from "@/components/ui/sonner";
import { cn } from "@/lib/utils";
import { useTranslation } from "@/lib/i18n/client";
import { useQuery } from "@tanstack/react-query";
import { FileX, Languages } from "lucide-react";

import BookmarkHTMLHighlighter from "@karakeep/shared-react/components/BookmarkHtmlHighlighter";
import ScrollProgressTracker from "@karakeep/shared-react/components/ScrollProgressTracker";
import {
  useCreateHighlight,
  useDeleteHighlight,
  useUpdateHighlight,
} from "@karakeep/shared-react/hooks/highlights";
import { useReadingProgress } from "@karakeep/shared-react/hooks/reading-progress";
import { useTRPC } from "@karakeep/shared-react/trpc";
import { BookmarkTypes } from "@karakeep/shared/types/bookmarks";

import ReadingProgressBanner from "./ReadingProgressBanner";

export default function ReaderView({
  bookmarkId,
  className,
  style,
  readOnly,
  progressBarStyle,
}: {
  bookmarkId: string;
  className?: string;
  style?: React.CSSProperties;
  readOnly: boolean;
  progressBarStyle?: React.CSSProperties;
}) {
  const { t } = useTranslation();
  const api = useTRPC();
  const { data: highlights } = useQuery(
    api.highlights.getForBookmark.queryOptions({
      bookmarkId,
    }),
  );
  const { data: linkContent, isPending: isCachedContentLoading } = useQuery(
    api.bookmarks.getBookmark.queryOptions(
      {
        bookmarkId,
        includeContent: true,
      },
      {
        select: (data) =>
          data.content.type == BookmarkTypes.LINK
            ? {
                htmlContent: data.content.htmlContent ?? null,
                translatedContent: data.content.translatedContent ?? null,
                translationStatus: data.content.translationStatus ?? null,
                translationTotalChunks:
                  data.content.translationTotalChunks ?? null,
                translationDoneChunks:
                  data.content.translationDoneChunks ?? null,
                translationSourceOffset:
                  data.content.translationSourceOffset ?? null,
              }
            : null,
        // Keep polling while a translation is still being generated. The worker
        // persists after every chunk, so each poll picks up more of the article.
        refetchInterval: (query) => {
          const d = query.state.data;
          return d?.content.type === BookmarkTypes.LINK &&
            d.content.translationStatus === "pending"
            ? 2000
            : false;
        },
      },
    ),
  );

  // null = the user hasn't picked a side yet, so follow the default below.
  const [showTranslationOverride, setShowTranslationOverride] = useState<
    boolean | null
  >(null);
  const isTranslating = linkContent?.translationStatus === "pending";
  // Partial output counts: the reader renders whatever chunks are done so far.
  const hasTranslation = !!linkContent?.translatedContent;
  // Default to the translation while it streams in and once it succeeded; a
  // failed run falls back to the original but its partial output stays reachable
  // through the toggle.
  const showTranslation =
    showTranslationOverride ??
    (isTranslating || linkContent?.translationStatus === "success");
  // While the job is running, show the translated prefix followed by the source
  // HTML the worker hasn't reached yet, so the article stays whole and flips to
  // the target language section by section as chunks land.
  const partialWithRemainder = () => {
    const translated = linkContent?.translatedContent ?? "";
    const offset = linkContent?.translationSourceOffset;
    const source = linkContent?.htmlContent ?? "";
    if (!isTranslating || offset == null || offset >= source.length) {
      return translated;
    }
    return translated + source.slice(offset);
  };
  const displayContent =
    showTranslation && hasTranslation
      ? partialWithRemainder()
      : (linkContent?.htmlContent ?? null);

  const totalChunks = linkContent?.translationTotalChunks ?? null;
  const doneChunks = linkContent?.translationDoneChunks ?? null;
  const translationPercent =
    totalChunks && totalChunks > 0 && doneChunks !== null
      ? Math.min(100, Math.round((doneChunks / totalChunks) * 100))
      : null;

  const {
    showBanner,
    bannerPercent,
    onContinue,
    onDismiss,
    restorePosition,
    readingProgressOffset,
    readingProgressAnchor,
    onSavePosition,
    onScrollPositionChange,
  } = useReadingProgress({
    bookmarkId,
  });

  const { mutate: createHighlight } = useCreateHighlight({
    onSuccess: () => {
      toast({
        description: "Highlight has been created!",
      });
    },
    onError: () => {
      toast({
        variant: "destructive",
        description: "Something went wrong",
      });
    },
  });

  const { mutate: updateHighlight } = useUpdateHighlight({
    onSuccess: () => {
      toast({
        description: "Highlight has been updated!",
      });
    },
    onError: () => {
      toast({
        variant: "destructive",
        description: "Something went wrong",
      });
    },
  });

  const { mutate: deleteHighlight } = useDeleteHighlight({
    onSuccess: () => {
      toast({
        description: "Highlight has been deleted!",
      });
    },
    onError: () => {
      toast({
        variant: "destructive",
        description: "Something went wrong",
      });
    },
  });

  const translationProgress = isTranslating ? (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Languages className="h-3.5 w-3.5 animate-pulse" />
      {translationPercent !== null
        ? t("preview.translating_progress", {
            defaultValue: "Translating… {{done}}/{{total}}",
            done: doneChunks,
            total: totalChunks,
          })
        : t("preview.translating", "Translating…")}
      {translationPercent !== null && (
        <span className="h-1 w-16 overflow-hidden rounded-full bg-muted">
          <span
            className="block h-full rounded-full bg-primary transition-all duration-500"
            style={{ width: `${translationPercent}%` }}
          />
        </span>
      )}
    </span>
  ) : null;

  const translationToggle =
    hasTranslation || isTranslating ? (
      <div className="flex items-center justify-end gap-2 px-1 pb-2">
        {translationProgress}
        {hasTranslation && (
          <div className="flex overflow-hidden rounded-md border text-xs">
            <button
              type="button"
              onClick={() => setShowTranslationOverride(false)}
              className={cn(
                "px-2 py-1",
                !showTranslation
                  ? "bg-muted font-medium text-foreground"
                  : "text-muted-foreground",
              )}
            >
              {t("preview.show_original", "Original")}
            </button>
            <button
              type="button"
              onClick={() => setShowTranslationOverride(true)}
              className={cn(
                "px-2 py-1",
                showTranslation
                  ? "bg-muted font-medium text-foreground"
                  : "text-muted-foreground",
              )}
            >
              {t("preview.show_translation", "日本語")}
            </button>
          </div>
        )}
      </div>
    ) : null;

  let content;
  if (isCachedContentLoading) {
    content = <FullPageSpinner />;
  } else if (!displayContent) {
    content = (
      <div className="flex h-full w-full items-center justify-center p-4">
        <div className="max-w-sm space-y-4 text-center">
          <div className="flex justify-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted">
              <FileX className="h-8 w-8 text-muted-foreground" />
            </div>
          </div>
          <div className="space-y-2">
            <h3 className="text-lg font-medium text-foreground">
              {t("preview.fetch_error_title")}
            </h3>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {t("preview.fetch_error_description")}
            </p>
          </div>
        </div>
      </div>
    );
  } else {
    content = (
      <div className="flex h-full flex-col">
        {translationToggle}
        <ScrollProgressTracker
          onSavePosition={onSavePosition}
          onScrollPositionChange={onScrollPositionChange}
          restorePosition={restorePosition}
          readingProgressOffset={readingProgressOffset}
          readingProgressAnchor={readingProgressAnchor}
          showProgressBar
          progressBarStyle={progressBarStyle}
        >
          {showBanner && (
            <ReadingProgressBanner
              percent={bannerPercent}
              onContinue={onContinue}
              onDismiss={onDismiss}
            />
          )}
          <BookmarkHTMLHighlighter
            className={className}
            style={style}
            htmlContent={displayContent || ""}
            highlights={highlights?.highlights ?? []}
            readOnly={readOnly || (showTranslation && hasTranslation)}
            onDeleteHighlight={(h) =>
              deleteHighlight({
                highlightId: h.id,
              })
            }
            onUpdateHighlight={(h) =>
              updateHighlight({
                highlightId: h.id,
                color: h.color,
                note: h.note,
              })
            }
            onHighlight={(h) =>
              createHighlight({
                startOffset: h.startOffset,
                endOffset: h.endOffset,
                color: h.color,
                bookmarkId,
                text: h.text,
                note: h.note ?? null,
              })
            }
          />
        </ScrollProgressTracker>
      </div>
    );
  }
  return content;
}
