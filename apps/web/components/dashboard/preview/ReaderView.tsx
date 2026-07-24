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
              }
            : null,
        // Keep polling while a translation is still being generated.
        refetchInterval: (query) => {
          const d = query.state.data;
          return d?.content.type === BookmarkTypes.LINK &&
            d.content.translationStatus === "pending"
            ? 3000
            : false;
        },
      },
    ),
  );

  const [showTranslation, setShowTranslation] = useState(false);
  const hasTranslation =
    !!linkContent?.translatedContent &&
    linkContent.translationStatus === "success";
  const isTranslating = linkContent?.translationStatus === "pending";
  const displayContent =
    showTranslation && hasTranslation
      ? linkContent?.translatedContent
      : (linkContent?.htmlContent ?? null);

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

  const translationToggle =
    hasTranslation || isTranslating ? (
      <div className="flex items-center justify-end gap-1 px-1 pb-2">
        {isTranslating && !hasTranslation ? (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Languages className="h-3.5 w-3.5 animate-pulse" />
            {t("preview.translating", "Translating…")}
          </span>
        ) : (
          <div className="flex overflow-hidden rounded-md border text-xs">
            <button
              type="button"
              onClick={() => setShowTranslation(false)}
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
              onClick={() => setShowTranslation(true)}
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
