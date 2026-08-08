import type { AdapterAccount } from "@auth/core/adapters";
import { createId } from "@paralleldrive/cuid2";
import { relations, sql, SQL } from "drizzle-orm";
import {
  AnySQLiteColumn,
  blob,
  foreignKey,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";

import type { ZApiKeyScope } from "@karakeep/shared/types/apiKeys";
import { API_KEY_FULL_ACCESS_SCOPE } from "@karakeep/shared/types/apiKeys";
import { BookmarkTypes } from "@karakeep/shared/types/bookmarks";

function createdAtField() {
  return integer("createdAt", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date());
}

function createdAtMsField() {
  return integer("createdAt", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date());
}

function modifiedAtField() {
  return integer("modifiedAt", { mode: "timestamp" })
    .$defaultFn(() => new Date())
    .$onUpdate(() => new Date());
}

function modifiedAtMsField() {
  return integer("modifiedAt", { mode: "timestamp_ms" })
    .$defaultFn(() => new Date())
    .$onUpdate(() => new Date());
}

export const users = sqliteTable("user", {
  id: text("id")
    .notNull()
    .primaryKey()
    .$defaultFn(() => createId()),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("emailVerified", { mode: "timestamp_ms" }),
  image: text("image"),
  password: text("password"),
  salt: text("salt").notNull().default(""),
  role: text("role", { enum: ["admin", "user"] }).default("user"),

  // Admin Only Settings
  bookmarkQuota: integer("bookmarkQuota"),
  storageQuota: integer("storageQuota"),
  browserCrawlingEnabled: integer("browserCrawlingEnabled", {
    mode: "boolean",
  }),
  // Admin-granted plan label (e.g. a collaborator name). While set, Stripe
  // sync doesn't downgrade the user's entitlements; it's cleared when the
  // user gets an active Stripe subscription.
  manualTierName: text("manualTierName"),

  // User Settings
  bookmarkClickAction: text("bookmarkClickAction", {
    enum: ["open_original_link", "expand_bookmark_preview", "open_reader_view"],
  })
    .notNull()
    .default("open_original_link"),
  archiveDisplayBehaviour: text("archiveDisplayBehaviour", {
    enum: ["show", "hide"],
  })
    .notNull()
    .default("show"),
  timezone: text("timezone").default("UTC"),

  // Backup Settings
  backupsEnabled: integer("backupsEnabled", { mode: "boolean" })
    .notNull()
    .default(false),
  backupsFrequency: text("backupsFrequency", {
    enum: ["daily", "weekly"],
  })
    .notNull()
    .default("weekly"),
  backupsRetentionDays: integer("backupsRetentionDays").notNull().default(30),

  // Reader view settings (nullable = opt-in, null means use client default)
  readerFontSize: integer("readerFontSize"),
  readerLineHeight: real("readerLineHeight"),
  readerFontFamily: text("readerFontFamily", {
    enum: ["serif", "sans", "mono"],
  }),

  // AI Settings (nullable = opt-in, null means use server default)
  autoTaggingEnabled: integer("autoTaggingEnabled", { mode: "boolean" }),
  autoSummarizationEnabled: integer("autoSummarizationEnabled", {
    mode: "boolean",
  }),
  tagStyle: text("tagStyle", {
    enum: [
      "lowercase-hyphens",
      "lowercase-spaces",
      "lowercase-underscores",
      "titlecase-spaces",
      "titlecase-hyphens",
      "camelCase",
      "as-generated",
    ],
  }).default("titlecase-spaces"),
  curatedTagIds: text("curatedTagIds", { mode: "json" }).$type<string[]>(),
  inferredTagLang: text("inferredTagLang"),
});

export const accounts = sqliteTable(
  "account",
  {
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").$type<AdapterAccount["type"]>().notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("providerAccountId").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (account) => [
    primaryKey({
      columns: [account.provider, account.providerAccountId],
    }),
  ],
);

export const sessions = sqliteTable("session", {
  sessionToken: text("sessionToken")
    .notNull()
    .primaryKey()
    .$defaultFn(() => createId()),
  userId: text("userId")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: integer("expires", { mode: "timestamp_ms" }).notNull(),
});

export const verificationTokens = sqliteTable(
  "verificationToken",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: integer("expires", { mode: "timestamp_ms" }).notNull(),
  },
  (vt) => [primaryKey({ columns: [vt.identifier, vt.token] })],
);

export const passwordResetTokens = sqliteTable(
  "passwordResetToken",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    expires: integer("expires", { mode: "timestamp_ms" }).notNull(),
    createdAt: createdAtField(),
  },
  (prt) => [index("passwordResetTokens_userId_idx").on(prt.userId)],
);

export const apiKeys = sqliteTable(
  "apiKey",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    name: text("name").notNull(),
    createdAt: createdAtField(),
    lastUsedAt: integer("lastUsedAt", { mode: "timestamp" }),
    keyId: text("keyId").notNull().unique(),
    keyHash: text("keyHash").notNull(),
    scopes: text("scopes", { mode: "json" })
      .$type<ZApiKeyScope[]>()
      .notNull()
      .$defaultFn(() => [API_KEY_FULL_ACCESS_SCOPE]),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (ak) => [unique().on(ak.name, ak.userId)],
);

export const bookmarks = sqliteTable(
  "bookmarks",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    createdAt: createdAtField(),
    modifiedAt: modifiedAtField(),
    title: text("title"),
    archived: integer("archived", { mode: "boolean" }).notNull().default(false),
    favourited: integer("favourited", { mode: "boolean" })
      .notNull()
      .default(false),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    taggingStatus: text("taggingStatus", {
      enum: ["pending", "failure", "success"],
    }).default("pending"),
    summarizationStatus: text("summarizationStatus", {
      enum: ["pending", "failure", "success"],
    }).default("pending"),
    embeddingStatus: text("embeddingStatus", {
      enum: ["pending", "failure", "success"],
    }).default("pending"),
    summary: text("summary"),
    note: text("note"),
    type: text("type", {
      enum: [BookmarkTypes.LINK, BookmarkTypes.TEXT, BookmarkTypes.ASSET],
    }).notNull(),
    source: text("source", {
      enum: [
        "api",
        "web",
        "extension",
        "cli",
        "mobile",
        "singlefile",
        "rss",
        "import",
      ],
    }),
  },
  (b) => [
    index("bookmarks_createdAt_idx").on(b.createdAt),
    // Composite indexes for optimized pagination queries
    index("bookmarks_userId_createdAt_id_idx").on(b.userId, b.createdAt, b.id),
    index("bookmarks_userId_archived_createdAt_id_idx").on(
      b.userId,
      b.archived,
      b.createdAt,
      b.id,
    ),
    index("bookmarks_userId_favourited_createdAt_id_idx").on(
      b.userId,
      b.favourited,
      b.createdAt,
      b.id,
    ),
  ],
);

export const bookmarkLinks = sqliteTable(
  "bookmarkLinks",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId())
      .references(() => bookmarks.id, { onDelete: "cascade" }),
    url: text("url").notNull(),

    // Crawled info
    title: text("title"),
    description: text("description"),
    author: text("author"),
    publisher: text("publisher"),
    datePublished: integer("datePublished", { mode: "timestamp" }),
    dateModified: integer("dateModified", { mode: "timestamp" }),
    imageUrl: text("imageUrl"),
    favicon: text("favicon"),
    htmlContent: text("htmlContent"),
    contentAssetId: text("contentAssetId"),
    crawledAt: integer("crawledAt", { mode: "timestamp" }),
    crawlStatus: text("crawlStatus", {
      enum: ["pending", "failure", "success"],
    }).default("pending"),
    crawlStatusCode: integer("crawlStatusCode").default(200),
    // When the pre-crawl probe last extracted and stored this link's metadata.
    // Lets crawl retries skip re-fetching it.
    probeMetadataAt: integer("probeMetadataAt", { mode: "timestamp" }),
    // Structure-preserving LLM translation of the readable HTML content
    // (imanect-labs fork). translationStatus is null when translation was never
    // attempted (disabled / non-source-language), otherwise pending/failure/success.
    translatedContent: text("translatedContent"),
    translationStatus: text("translationStatus", {
      enum: ["pending", "failure", "success"],
    }),
    // Chunk-level progress. The worker persists the partial translation after
    // every chunk, so the reader can render what's done so far and show how far
    // along the job is. Both are null until a job starts chunking.
    translationTotalChunks: integer("translationTotalChunks"),
    translationDoneChunks: integer("translationDoneChunks"),
    // How many characters of the source HTML the done chunks cover. Lets the
    // reader splice the untranslated remainder onto the partial translation so
    // the article never looks truncated mid-run.
    translationSourceOffset: integer("translationSourceOffset"),
  },
  (bl) => [index("bookmarkLinks_url_idx").on(bl.url)],
);

export const enum AssetTypes {
  LINK_BANNER_IMAGE = "linkBannerImage",
  LINK_SCREENSHOT = "linkScreenshot",
  LINK_PDF = "linkPdf",
  ASSET_SCREENSHOT = "assetScreenshot",
  LINK_FULL_PAGE_ARCHIVE = "linkFullPageArchive",
  LINK_PRECRAWLED_ARCHIVE = "linkPrecrawledArchive",
  LINK_VIDEO = "linkVideo",
  LINK_HTML_CONTENT = "linkHtmlContent",
  BOOKMARK_ASSET = "bookmarkAsset",
  USER_UPLOADED = "userUploaded",
  AVATAR = "avatar",
  BACKUP = "backup",
  UNKNOWN = "unknown",
}

export const assets = sqliteTable(
  "assets",
  {
    // Asset ids don't have a default function as they are generated by the caller
    id: text("id").notNull().primaryKey(),
    assetType: text("assetType", {
      enum: [
        AssetTypes.LINK_BANNER_IMAGE,
        AssetTypes.LINK_SCREENSHOT,
        AssetTypes.LINK_PDF,
        AssetTypes.ASSET_SCREENSHOT,
        AssetTypes.LINK_FULL_PAGE_ARCHIVE,
        AssetTypes.LINK_PRECRAWLED_ARCHIVE,
        AssetTypes.LINK_VIDEO,
        AssetTypes.LINK_HTML_CONTENT,
        AssetTypes.BOOKMARK_ASSET,
        AssetTypes.USER_UPLOADED,
        AssetTypes.AVATAR,
        AssetTypes.BACKUP,
        AssetTypes.UNKNOWN,
      ],
    }).notNull(),
    size: integer("size").notNull().default(0),
    contentType: text("contentType"),
    fileName: text("fileName"),
    bookmarkId: text("bookmarkId").references(() => bookmarks.id, {
      onDelete: "cascade",
    }),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },

  (tb) => [
    index("assets_bookmarkId_idx").on(tb.bookmarkId),
    index("assets_assetType_idx").on(tb.assetType),
    index("assets_userId_idx").on(tb.userId),
  ],
);

export const highlights = sqliteTable(
  "highlights",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    bookmarkId: text("bookmarkId")
      .notNull()
      .references(() => bookmarks.id, {
        onDelete: "cascade",
      }),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    startOffset: integer("startOffset").notNull(),
    endOffset: integer("endOffset").notNull(),
    color: text("color", {
      enum: ["red", "green", "blue", "yellow"],
    })
      .default("yellow")
      .notNull(),
    text: text("text"),
    note: text("note"),
    createdAt: createdAtField(),
  },
  (tb) => [
    index("highlights_bookmarkId_idx").on(tb.bookmarkId),
    index("highlights_userId_idx").on(tb.userId),
  ],
);

export const userReadingProgress = sqliteTable(
  "userReadingProgress",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    bookmarkId: text("bookmarkId")
      .notNull()
      .references(() => bookmarks.id, {
        onDelete: "cascade",
      }),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    readingProgressOffset: integer("readingProgressOffset").notNull(),
    readingProgressAnchor: text("readingProgressAnchor"),
    readingProgressPercent: integer("readingProgressPercent"),
    modifiedAt: modifiedAtField(),
  },
  (tb) => [
    unique().on(tb.bookmarkId, tb.userId),
    index("userReadingProgress_bookmarkId_idx").on(tb.bookmarkId),
    index("userReadingProgress_userId_idx").on(tb.userId),
  ],
);

export const bookmarkTexts = sqliteTable("bookmarkTexts", {
  id: text("id")
    .notNull()
    .primaryKey()
    .$defaultFn(() => createId())
    .references(() => bookmarks.id, { onDelete: "cascade" }),
  text: text("text"),
  sourceUrl: text("sourceUrl"),
});

export const bookmarkAssets = sqliteTable("bookmarkAssets", {
  id: text("id")
    .notNull()
    .primaryKey()
    .$defaultFn(() => createId())
    .references(() => bookmarks.id, { onDelete: "cascade" }),
  assetType: text("assetType", { enum: ["image", "pdf"] }).notNull(),
  assetId: text("assetId").notNull(),
  content: text("content"),
  metadata: text("metadata"),
  fileName: text("fileName"),
  sourceUrl: text("sourceUrl"),
});

export const bookmarkTags = sqliteTable(
  "bookmarkTags",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    name: text("name").notNull(),
    normalizedName: text("normalizedName").generatedAlwaysAs(
      (): SQL =>
        // This function needs to be in sync with the tagNormalizer function in tagging.ts
        sql`lower(replace(replace(replace(${bookmarkTags.name}, ' ', ''), '-', ''), '_', ''))`,
      {
        mode: "virtual",
      },
    ),
    createdAt: createdAtField(),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (bt) => [
    unique().on(bt.userId, bt.name),
    unique("bookmarkTags_userId_id_idx").on(bt.userId, bt.id),
    index("bookmarkTags_name_idx").on(bt.name),
    index("bookmarkTags_normalizedName_idx").on(bt.normalizedName),
  ],
);

export const tagsOnBookmarks = sqliteTable(
  "tagsOnBookmarks",
  {
    bookmarkId: text("bookmarkId")
      .notNull()
      .references(() => bookmarks.id, { onDelete: "cascade" }),
    tagId: text("tagId")
      .notNull()
      .references(() => bookmarkTags.id, { onDelete: "cascade" }),

    attachedAt: integer("attachedAt", { mode: "timestamp" }).$defaultFn(
      () => new Date(),
    ),
    attachedBy: text("attachedBy", { enum: ["ai", "human"] }).notNull(),
  },
  (tb) => [
    primaryKey({ columns: [tb.bookmarkId, tb.tagId] }),
    // Composite index for tag-first queries (when filtering by tagId)
    index("tagsOnBookmarks_tagId_bookmarkId_idx").on(tb.tagId, tb.bookmarkId),
  ],
);

export const bookmarkLists = sqliteTable(
  "bookmarkLists",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    name: text("name").notNull(),
    description: text("description"),
    icon: text("icon").notNull(),
    createdAt: createdAtField(),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type", { enum: ["manual", "smart"] }).notNull(),
    // Only applicable for smart lists
    query: text("query"),
    parentId: text("parentId").references(
      (): AnySQLiteColumn => bookmarkLists.id,
      { onDelete: "set null" },
    ),
    // Whoever have access to this token can read the content of this list
    rssToken: text("rssToken"),
    public: integer("public", { mode: "boolean" }).notNull().default(false),
  },
  (bl) => [
    index("bookmarkLists_userId_idx").on(bl.userId),
    unique("bookmarkLists_userId_id_idx").on(bl.userId, bl.id),
  ],
);

export const bookmarksInLists = sqliteTable(
  "bookmarksInLists",
  {
    bookmarkId: text("bookmarkId")
      .notNull()
      .references(() => bookmarks.id, { onDelete: "cascade" }),
    listId: text("listId")
      .notNull()
      .references(() => bookmarkLists.id, { onDelete: "cascade" }),
    addedAt: integer("addedAt", { mode: "timestamp" }).$defaultFn(
      () => new Date(),
    ),
    // Tie the list's existence to the user's membership
    // of this list.
    listMembershipId: text("listMembershipId").references(
      () => listCollaborators.id,
      {
        onDelete: "cascade",
      },
    ),
  },
  (tb) => [
    primaryKey({ columns: [tb.bookmarkId, tb.listId] }),
    // Composite index for list-first queries (when filtering by listId)
    index("bookmarksInLists_listId_bookmarkId_idx").on(
      tb.listId,
      tb.bookmarkId,
    ),
  ],
);

export const listCollaborators = sqliteTable(
  "listCollaborators",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    listId: text("listId")
      .notNull()
      .references(() => bookmarkLists.id, { onDelete: "cascade" }),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["viewer", "editor"] }).notNull(),
    addedAt: createdAtField(),
    addedBy: text("addedBy").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (lc) => [
    unique().on(lc.listId, lc.userId),
    index("listCollaborators_listId_idx").on(lc.listId),
    index("listCollaborators_userId_idx").on(lc.userId),
  ],
);

export const listInvitations = sqliteTable(
  "listInvitations",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    listId: text("listId")
      .notNull()
      .references(() => bookmarkLists.id, { onDelete: "cascade" }),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["viewer", "editor"] }).notNull(),
    status: text("status", { enum: ["pending", "declined"] })
      .notNull()
      .default("pending"),
    invitedAt: integer("invitedAt", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    invitedEmail: text("invitedEmail"),
    invitedBy: text("invitedBy").references(() => users.id, {
      onDelete: "set null",
    }),
  },
  (li) => [
    unique().on(li.listId, li.userId),
    index("listInvitations_listId_idx").on(li.listId),
    index("listInvitations_userId_idx").on(li.userId),
    index("listInvitations_status_idx").on(li.status),
  ],
);

export const customPrompts = sqliteTable(
  "customPrompts",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    text: text("text").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull(),
    appliesTo: text("appliesTo", {
      enum: ["all_tagging", "text", "images", "summary"],
    }).notNull(),
    createdAt: createdAtField(),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (bl) => [index("customPrompts_userId_idx").on(bl.userId)],
);

export const chatSessions = sqliteTable(
  "chatSessions",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    title: text("title").notNull(),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAtMsField(),
    modifiedAt: modifiedAtMsField(),
  },
  (cs) => [
    index("chatSessions_userId_idx").on(cs.userId),
    index("chatSessions_userId_modifiedAt_idx").on(cs.userId, cs.modifiedAt),
  ],
);

export const chatMessages = sqliteTable(
  "chatMessages",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    chatId: text("chatId")
      .notNull()
      .references(() => chatSessions.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["user", "assistant", "toolResult"] }).notNull(),
    content: text("content").notNull(),
    metadata: text("metadata", { mode: "json" }).$type<unknown>(),
    createdAt: createdAtMsField(),
  },
  (cm) => [
    index("chatMessages_chatId_idx").on(cm.chatId),
    index("chatMessages_chatId_createdAt_idx").on(cm.chatId, cm.createdAt),
  ],
);

export const rssFeedsTable = sqliteTable(
  "rssFeeds",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    name: text("name").notNull(),
    url: text("url").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    importTags: integer("importTags", { mode: "boolean" })
      .notNull()
      .default(false),
    createdAt: createdAtField(),
    lastFetchedAt: integer("lastFetchedAt", { mode: "timestamp" }),
    lastSuccessfulFetchAt: integer("lastSuccessfulFetchAt", {
      mode: "timestamp",
    }),
    lastFetchedStatus: text("lastFetchedStatus", {
      enum: ["pending", "failure", "success"],
    }).default("pending"),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (bl) => [index("rssFeeds_userId_idx").on(bl.userId)],
);

export const webhooksTable = sqliteTable(
  "webhooks",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    createdAt: createdAtField(),
    url: text("url").notNull(),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    events: text("events", { mode: "json" })
      .notNull()
      .$type<("created" | "edited" | "crawled" | "ai tagged" | "deleted")[]>(),
    token: text("token"),
  },
  (bl) => [index("webhooks_userId_idx").on(bl.userId)],
);

export const rssFeedImportsTable = sqliteTable(
  "rssFeedImports",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    createdAt: createdAtField(),
    entryId: text("entryId").notNull(),
    rssFeedId: text("rssFeedId")
      .notNull()
      .references(() => rssFeedsTable.id, { onDelete: "cascade" }),
    bookmarkId: text("bookmarkId").references(() => bookmarks.id, {
      onDelete: "set null",
    }),
  },
  (bl) => [
    index("rssFeedImports_feedIdIdx_idx").on(bl.rssFeedId),
    index("rssFeedImports_entryIdIdx_idx").on(bl.entryId),
    unique().on(bl.rssFeedId, bl.entryId),
    index("rssFeedImports_bookmarkId_idx").on(bl.bookmarkId),
    // Composite index for RSS feed filter queries (when filtering by rssFeedId)
    index("rssFeedImports_rssFeedId_bookmarkId_idx").on(
      bl.rssFeedId,
      bl.bookmarkId,
    ),
  ],
);

export const backupsTable = sqliteTable(
  "backups",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    assetId: text("assetId").references(() => assets.id, {
      onDelete: "cascade",
    }),
    createdAt: createdAtField(),
    size: integer("size").notNull(),
    bookmarkCount: integer("bookmarkCount").notNull(),
    status: text("status", {
      enum: ["pending", "success", "failure"],
    })
      .notNull()
      .default("pending"),
    errorMessage: text("errorMessage"),
  },
  (b) => [
    index("backups_userId_idx").on(b.userId),
    index("backups_createdAt_idx").on(b.createdAt),
  ],
);

export const config = sqliteTable("config", {
  key: text("key").notNull().primaryKey(),
  value: text("value").notNull(),
});

export const ruleEngineRulesTable = sqliteTable(
  "ruleEngineRules",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    name: text("name").notNull(),
    description: text("description"),
    event: text("event").notNull(),
    condition: text("condition").notNull(),

    // References
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tagId: text("tagId"),
  },
  (rl) => [
    index("ruleEngine_userId_idx").on(rl.userId),

    // Ensures correct ownership
    foreignKey({
      columns: [rl.userId, rl.tagId],
      foreignColumns: [bookmarkTags.userId, bookmarkTags.id],
      name: "ruleEngineRules_userId_tagId_fk",
    }).onDelete("cascade"),
  ],
);

export const ruleEngineActionsTable = sqliteTable(
  "ruleEngineActions",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    ruleId: text("ruleId")
      .notNull()
      .references(() => ruleEngineRulesTable.id, { onDelete: "cascade" }),
    action: text("action").notNull(),

    // References
    listId: text("listId"),
    tagId: text("tagId"),
  },
  (rl) => [
    index("ruleEngineActions_userId_idx").on(rl.userId),
    index("ruleEngineActions_ruleId_idx").on(rl.ruleId),
    // Ensures correct ownership
    foreignKey({
      columns: [rl.userId, rl.tagId],
      foreignColumns: [bookmarkTags.userId, bookmarkTags.id],
      name: "ruleEngineActions_userId_tagId_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [rl.userId, rl.listId],
      foreignColumns: [bookmarkLists.userId, bookmarkLists.id],
      name: "ruleEngineActions_userId_listId_fk",
    }).onDelete("cascade"),
  ],
);

export const invites = sqliteTable("invites", {
  id: text("id")
    .notNull()
    .primaryKey()
    .$defaultFn(() => createId()),
  email: text("email").notNull(),
  token: text("token").notNull().unique(),
  createdAt: createdAtField(),
  usedAt: integer("usedAt", { mode: "timestamp" }),
  invitedBy: text("invitedBy")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
});

export const subscriptions = sqliteTable(
  "subscriptions",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" })
      .unique(),
    stripeCustomerId: text("stripeCustomerId").notNull(),
    stripeSubscriptionId: text("stripeSubscriptionId"),
    status: text("status", {
      enum: [
        "active",
        "canceled",
        "past_due",
        "unpaid",
        "incomplete",
        "trialing",
        "incomplete_expired",
        "paused",
      ],
    }).notNull(),
    tier: text("tier", {
      enum: ["free", "paid"],
    })
      .notNull()
      .default("free"),
    priceId: text("priceId"),
    cancelAtPeriodEnd: integer("cancelAtPeriodEnd", {
      mode: "boolean",
    }).default(false),
    startDate: integer("startDate", { mode: "timestamp" }),
    endDate: integer("endDate", { mode: "timestamp" }),
    createdAt: createdAtField(),
    modifiedAt: modifiedAtField(),
  },
  (s) => [
    index("subscriptions_userId_idx").on(s.userId),
    index("subscriptions_stripeCustomerId_idx").on(s.stripeCustomerId),
  ],
);

export const importSessions = sqliteTable(
  "importSessions",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    name: text("name").notNull(),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    message: text("message"),
    rootListId: text("rootListId").references(() => bookmarkLists.id, {
      onDelete: "set null",
    }),
    status: text("status", {
      enum: [
        "staging",
        "pending",
        "running",
        "paused",
        "completed",
        "failed",
        "archived",
      ],
    })
      .notNull()
      .default("staging"),
    lastProcessedAt: integer("lastProcessedAt", { mode: "timestamp" }),
    completedAt: integer("completedAt", { mode: "timestamp" }),
    totalBookmarks: integer("totalBookmarks").notNull().default(0),
    completedBookmarks: integer("completedBookmarks").notNull().default(0),
    failedBookmarks: integer("failedBookmarks").notNull().default(0),
    pendingBookmarks: integer("pendingBookmarks").notNull().default(0),
    processingBookmarks: integer("processingBookmarks").notNull().default(0),
    createdAt: createdAtField(),
    modifiedAt: modifiedAtField(),
  },
  (is) => [
    index("importSessions_userId_idx").on(is.userId),
    index("importSessions_status_idx").on(is.status),
    index("importSessions_status_completedAt_idx").on(
      is.status,
      is.completedAt,
    ),
  ],
);

export const importSessionBookmarks = sqliteTable(
  "importSessionBookmarks",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    importSessionId: text("importSessionId")
      .notNull()
      .references(() => importSessions.id, { onDelete: "cascade" }),
    bookmarkId: text("bookmarkId")
      .notNull()
      .references(() => bookmarks.id, { onDelete: "cascade" }),
    createdAt: createdAtField(),
  },
  (isb) => [
    index("importSessionBookmarks_bookmarkId_idx").on(isb.bookmarkId),
    unique().on(isb.importSessionId, isb.bookmarkId),
  ],
);

export const importStagingBookmarks = sqliteTable(
  "importStagingBookmarks",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    importSessionId: text("importSessionId")
      .notNull()
      .references(() => importSessions.id, { onDelete: "cascade" }),

    // Bookmark data to create
    type: text("type", { enum: ["link", "text", "asset"] }).notNull(),
    url: text("url"),
    title: text("title"),
    content: text("content"),
    note: text("note"),
    tags: text("tags", { mode: "json" }).$type<string[]>(),
    listIds: text("listIds", { mode: "json" }).$type<string[]>(),
    sourceAddedAt: integer("sourceAddedAt", { mode: "timestamp" }),
    archived: integer("archived", { mode: "boolean" }),

    // Processing state
    status: text("status", {
      enum: ["pending", "processing", "completed", "failed"],
    })
      .notNull()
      .default("pending"),
    processingStartedAt: integer("processingStartedAt", {
      mode: "timestamp",
    }),

    // Result (for observability)
    result: text("result", {
      enum: ["accepted", "rejected", "skipped_duplicate"],
    }),
    resultReason: text("resultReason"),
    resultBookmarkId: text("resultBookmarkId").references(() => bookmarks.id, {
      onDelete: "set null",
    }),

    createdAt: createdAtField(),
    completedAt: integer("completedAt", { mode: "timestamp" }),
  },
  (isb) => [
    index("importStaging_session_status_idx").on(
      isb.importSessionId,
      isb.status,
    ),
    index("importStaging_completedAt_idx").on(isb.completedAt),
    index("importStaging_resultBookmarkId_idx").on(isb.resultBookmarkId),
    index("importStaging_status_idx").on(isb.status),
    index("importStaging_status_processingStartedAt_idx").on(
      isb.status,
      isb.processingStartedAt,
    ),
  ],
);

// Relations

export const userRelations = relations(users, ({ many, one }) => ({
  tags: many(bookmarkTags),
  bookmarks: many(bookmarks),
  webhooks: many(webhooksTable),
  rules: many(ruleEngineRulesTable),
  chatSessions: many(chatSessions),
  invites: many(invites),
  subscription: one(subscriptions),
  importSessions: many(importSessions),
  listCollaborations: many(listCollaborators),
  backups: many(backupsTable),
  listInvitations: many(listInvitations),
}));

export const bookmarkRelations = relations(bookmarks, ({ many, one }) => ({
  user: one(users, {
    fields: [bookmarks.userId],
    references: [users.id],
  }),
  link: one(bookmarkLinks, {
    fields: [bookmarks.id],
    references: [bookmarkLinks.id],
  }),
  text: one(bookmarkTexts, {
    fields: [bookmarks.id],
    references: [bookmarkTexts.id],
  }),
  asset: one(bookmarkAssets, {
    fields: [bookmarks.id],
    references: [bookmarkAssets.id],
  }),
  tagsOnBookmarks: many(tagsOnBookmarks),
  bookmarksInLists: many(bookmarksInLists),
  assets: many(assets),
  rssFeeds: many(rssFeedImportsTable),
  importSessionBookmarks: many(importSessionBookmarks),
}));

export const assetRelations = relations(assets, ({ one }) => ({
  bookmark: one(bookmarks, {
    fields: [assets.bookmarkId],
    references: [bookmarks.id],
  }),
}));

export const bookmarkTagsRelations = relations(
  bookmarkTags,
  ({ many, one }) => ({
    user: one(users, {
      fields: [bookmarkTags.userId],
      references: [users.id],
    }),
    tagsOnBookmarks: many(tagsOnBookmarks),
  }),
);

export const tagsOnBookmarksRelations = relations(
  tagsOnBookmarks,
  ({ one }) => ({
    tag: one(bookmarkTags, {
      fields: [tagsOnBookmarks.tagId],
      references: [bookmarkTags.id],
    }),
    bookmark: one(bookmarks, {
      fields: [tagsOnBookmarks.bookmarkId],
      references: [bookmarks.id],
    }),
  }),
);

export const apiKeyRelations = relations(apiKeys, ({ one }) => ({
  user: one(users, {
    fields: [apiKeys.userId],
    references: [users.id],
  }),
}));

export const bookmarkListsRelations = relations(
  bookmarkLists,
  ({ one, many }) => ({
    bookmarksInLists: many(bookmarksInLists),
    collaborators: many(listCollaborators),
    invitations: many(listInvitations),
    user: one(users, {
      fields: [bookmarkLists.userId],
      references: [users.id],
    }),
    parent: one(bookmarkLists, {
      fields: [bookmarkLists.parentId],
      references: [bookmarkLists.id],
    }),
  }),
);

export const bookmarksInListsRelations = relations(
  bookmarksInLists,
  ({ one }) => ({
    bookmark: one(bookmarks, {
      fields: [bookmarksInLists.bookmarkId],
      references: [bookmarks.id],
    }),
    list: one(bookmarkLists, {
      fields: [bookmarksInLists.listId],
      references: [bookmarkLists.id],
    }),
  }),
);

export const listCollaboratorsRelations = relations(
  listCollaborators,
  ({ one }) => ({
    list: one(bookmarkLists, {
      fields: [listCollaborators.listId],
      references: [bookmarkLists.id],
    }),
    user: one(users, {
      fields: [listCollaborators.userId],
      references: [users.id],
    }),
    addedByUser: one(users, {
      fields: [listCollaborators.addedBy],
      references: [users.id],
    }),
  }),
);

export const listInvitationsRelations = relations(
  listInvitations,
  ({ one }) => ({
    list: one(bookmarkLists, {
      fields: [listInvitations.listId],
      references: [bookmarkLists.id],
    }),
    user: one(users, {
      fields: [listInvitations.userId],
      references: [users.id],
    }),
    invitedByUser: one(users, {
      fields: [listInvitations.invitedBy],
      references: [users.id],
    }),
  }),
);

export const webhooksRelations = relations(webhooksTable, ({ one }) => ({
  user: one(users, {
    fields: [webhooksTable.userId],
    references: [users.id],
  }),
}));

export const ruleEngineRulesRelations = relations(
  ruleEngineRulesTable,
  ({ one, many }) => ({
    user: one(users, {
      fields: [ruleEngineRulesTable.userId],
      references: [users.id],
    }),
    actions: many(ruleEngineActionsTable),
  }),
);

export const ruleEngineActionsTableRelations = relations(
  ruleEngineActionsTable,
  ({ one }) => ({
    rule: one(ruleEngineRulesTable, {
      fields: [ruleEngineActionsTable.ruleId],
      references: [ruleEngineRulesTable.id],
    }),
  }),
);

export const rssFeedImportsTableRelations = relations(
  rssFeedImportsTable,
  ({ one }) => ({
    rssFeed: one(rssFeedsTable, {
      fields: [rssFeedImportsTable.rssFeedId],
      references: [rssFeedsTable.id],
    }),
    bookmark: one(bookmarks, {
      fields: [rssFeedImportsTable.bookmarkId],
      references: [bookmarks.id],
    }),
  }),
);

export const invitesRelations = relations(invites, ({ one }) => ({
  invitedBy: one(users, {
    fields: [invites.invitedBy],
    references: [users.id],
  }),
}));

export const subscriptionsRelations = relations(subscriptions, ({ one }) => ({
  user: one(users, {
    fields: [subscriptions.userId],
    references: [users.id],
  }),
}));

export const passwordResetTokensRelations = relations(
  passwordResetTokens,
  ({ one }) => ({
    user: one(users, {
      fields: [passwordResetTokens.userId],
      references: [users.id],
    }),
  }),
);

export const chatSessionsRelations = relations(
  chatSessions,
  ({ one, many }) => ({
    user: one(users, {
      fields: [chatSessions.userId],
      references: [users.id],
    }),
    messages: many(chatMessages),
  }),
);

export const chatMessagesRelations = relations(chatMessages, ({ one }) => ({
  chat: one(chatSessions, {
    fields: [chatMessages.chatId],
    references: [chatSessions.id],
  }),
}));

export const importSessionsRelations = relations(
  importSessions,
  ({ one, many }) => ({
    user: one(users, {
      fields: [importSessions.userId],
      references: [users.id],
    }),
    bookmarks: many(importSessionBookmarks),
  }),
);

export const importSessionBookmarksRelations = relations(
  importSessionBookmarks,
  ({ one }) => ({
    importSession: one(importSessions, {
      fields: [importSessionBookmarks.importSessionId],
      references: [importSessions.id],
    }),
    bookmark: one(bookmarks, {
      fields: [importSessionBookmarks.bookmarkId],
      references: [bookmarks.id],
    }),
  }),
);

export const backupsRelations = relations(backupsTable, ({ one }) => ({
  user: one(users, {
    fields: [backupsTable.userId],
    references: [users.id],
  }),
  asset: one(assets, {
    fields: [backupsTable.assetId],
    references: [assets.id],
  }),
}));

export const userReadingProgressRelations = relations(
  userReadingProgress,
  ({ one }) => ({
    bookmark: one(bookmarks, {
      fields: [userReadingProgress.bookmarkId],
      references: [bookmarks.id],
    }),
    user: one(users, {
      fields: [userReadingProgress.userId],
      references: [users.id],
    }),
  }),
);

// ---------------------------------------------------------------------------
// Briefing recommender (imanect-labs fork).
//
// すべて `rec` プレフィックス。fork 由来のスキーマだと一目で分かるようにし、
// upstream のマイグレーションとの衝突も避ける。設計は
// docs/briefing/requirements.md §5 を参照。
// ---------------------------------------------------------------------------

/**
 * 候補記事の供給源になりうるドメイン。ライフサイクルは
 * discovered → screened → trial → subscribed / dormant / rejected / retired。
 */
export const recDomains = sqliteTable(
  "recDomains",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    domain: text("domain").notNull(),
    status: text("status", {
      enum: [
        "discovered",
        "screened",
        "trial",
        "subscribed",
        "dormant",
        "rejected",
        "retired",
      ],
    })
      .notNull()
      .default("discovered"),

    feedUrl: text("feedUrl"),
    scrapable: integer("scrapable", { mode: "boolean" })
      .notNull()
      .default(false),
    title: text("title"),
    description: text("description"),
    faviconUrl: text("faviconUrl"),

    // 品質ゲート (FR-D-12)。LLM 判定はドメインあたり 1 回きりなので、結果を
    // ここに永続化して二度と呼ばない。
    qualityClass: text("qualityClass", {
      enum: ["primary", "analysis", "syndication", "promotional", "unknown"],
    })
      .notNull()
      .default("unknown"),
    qualityCheckedAt: integer("qualityCheckedAt", { mode: "timestamp" }),
    blockedReason: text("blockedReason"),

    // D10（ドメイン埋め込みの近傍 / Phase 3）用の記事重心。
    centroid: blob("centroid", { mode: "buffer" }),
    centroidUpdatedAt: integer("centroidUpdatedAt", { mode: "timestamp" }),

    // ソースレベルのバンディット。事前分布は Beta(1, 4)。
    examinedCount: integer("examinedCount").notNull().default(0),
    positiveCount: integer("positiveCount").notNull().default(0),
    betaAlpha: real("betaAlpha").notNull().default(1),
    betaBeta: real("betaBeta").notNull().default(4),

    trialStartedAt: integer("trialStartedAt", { mode: "timestamp" }),
    trialImpressionCount: integer("trialImpressionCount").notNull().default(0),

    promotedAt: integer("promotedAt", { mode: "timestamp" }),
    demotedAt: integer("demotedAt", { mode: "timestamp" }),
    // 人間の一発判断はモデルの試用判定より優先する (FR-D-17)。
    manualDecision: text("manualDecision", {
      enum: ["subscribe", "reject"],
    }),

    // 埋没判定 (FR-D-15b) の基準。降格条件を examined の蓄積だけに依存させると
    // 平凡なドメインが不死身になるので、「選ばれた日」を別に持つ。
    lastSelectedAt: integer("lastSelectedAt", { mode: "timestamp" }),
    // 取得頻度の 3 層化 (FR-D-16)。事後平均から日次で振り直す。
    fetchTier: text("fetchTier", { enum: ["daily", "every3days", "weekly"] })
      .notNull()
      .default("every3days"),
    lastCrawledAt: integer("lastCrawledAt", { mode: "timestamp" }),

    firstSeenAt: integer("firstSeenAt", { mode: "timestamp" }),
    lastArticleAt: integer("lastArticleAt", { mode: "timestamp" }),
    createdAt: createdAtField(),
  },
  (t) => [
    unique("recDomains_userId_domain_unique").on(t.userId, t.domain),
    index("recDomains_userId_status_idx").on(t.userId, t.status),
    index("recDomains_lastSelectedAt_idx").on(t.lastSelectedAt),
  ],
);

/**
 * 発見の証拠。同じドメインが複数チャネルから見つかったら累積する。
 * rejected になっても消さない — 再発見のたびに再審査しないため (FR-D-18)。
 */
export const recDomainDiscoveries = sqliteTable(
  "recDomainDiscoveries",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    domainId: text("domainId")
      .notNull()
      .references(() => recDomains.id, { onDelete: "cascade" }),
    channel: text("channel", {
      enum: [
        "bookmark_backfill",
        "outbound_link",
        "aggregator",
        "author",
        "blogroll",
        "smallweb_search",
        "domain_neighbor",
        "social",
        "llm_search",
      ],
    }).notNull(),
    // 元記事の bookmarkId / 検索クエリなど。UI の「発見経路の説明」に使う。
    evidenceRef: text("evidenceRef"),
    evidenceLabel: text("evidenceLabel"),
    weight: real("weight").notNull().default(1),
    discoveredAt: integer("discoveredAt", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("recDomainDiscoveries_domainId_idx").on(t.domainId),
    index("recDomainDiscoveries_channel_idx").on(t.channel),
  ],
);

/** 実際に取得しにいく口。1 ドメインに複数のソースがぶら下がりうる。 */
export const recSources = sqliteTable(
  "recSources",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    domainId: text("domainId").references(() => recDomains.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    kind: text("kind", {
      enum: ["rss", "hn", "arxiv", "github", "scrape", "custom"],
    }).notNull(),
    config: text("config", { mode: "json" }).$type<Record<string, unknown>>(),
    // 収集の 20% 以上をここから取る。フィードバックループへのハードフロア。
    profileIndependent: integer("profileIndependent", { mode: "boolean" })
      .notNull()
      .default(false),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    consecutiveFailures: integer("consecutiveFailures").notNull().default(0),
    lastError: text("lastError"),
    lastFetchedAt: integer("lastFetchedAt", { mode: "timestamp" }),
    lastSuccessfulFetchAt: integer("lastSuccessfulFetchAt", {
      mode: "timestamp",
    }),
    createdAt: createdAtField(),
  },
  (t) => [
    index("recSources_userId_enabled_idx").on(t.userId, t.enabled),
    index("recSources_domainId_idx").on(t.domainId),
  ],
);

/**
 * 候補記事。ブックマークにはしない（保存された時点で既存のフローに渡す）。
 *
 * 既存ブックマークからのブートストラップも同じテーブルに入れる
 * （`origin='bootstrap'`, `status='promoted'`, `bookmarkId` 埋め）。こうすると
 * プロフィール重心の計算が候補もブックマークも同じ 1 本のクエリで済む。
 */
export const recCandidates = sqliteTable(
  "recCandidates",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sourceId: text("sourceId").references(() => recSources.id, {
      onDelete: "set null",
    }),
    domainId: text("domainId").references(() => recDomains.id, {
      onDelete: "set null",
    }),
    origin: text("origin", { enum: ["collected", "bootstrap"] })
      .notNull()
      .default("collected"),

    url: text("url").notNull(),
    canonicalUrl: text("canonicalUrl").notNull(),
    urlHash: text("urlHash").notNull(),
    titleHash: text("titleHash"),

    title: text("title"),
    summary: text("summary"),
    contentExcerpt: text("contentExcerpt"),
    author: text("author"),
    publishedAt: integer("publishedAt", { mode: "timestamp" }),
    fetchedAt: integer("fetchedAt", { mode: "timestamp" }),
    lang: text("lang"),

    // 日本語ダイジェスト (FR-U-13)。rank で表示が確定した候補だけに生成する
    // (1 日 30 件)。candidate 側に持つのは永続キャッシュのため — 同じ記事が
    // 翌日も選ばれたとき再生成しない。
    titleJa: text("titleJa"),
    summaryJa: text("summaryJa"),
    digestStatus: text("digestStatus", {
      enum: ["pending", "success", "failure", "skipped"],
    }),
    // プロンプトやモデルを替えたら再生成できるように、生成に使ったモデルを持つ。
    digestModelId: text("digestModelId"),

    embedding: blob("embedding", { mode: "buffer" }),
    // 埋め込みモデルを差し替えたら再計算が要る。混在を検出できるように
    // 候補ごとにモデル ID を持つ (requirements.md §10)。
    embeddingModelId: text("embeddingModelId"),
    embeddingStatus: text("embeddingStatus", {
      enum: ["pending", "success", "failure"],
    })
      .notNull()
      .default("pending"),

    clusterId: text("clusterId"),
    duplicateOfId: text("duplicateOfId").references(
      (): AnySQLiteColumn => recCandidates.id,
      { onDelete: "set null" },
    ),

    status: text("status", { enum: ["active", "expired", "promoted"] })
      .notNull()
      .default("active"),
    bookmarkId: text("bookmarkId").references(() => bookmarks.id, {
      onDelete: "set null",
    }),
    expiresAt: integer("expiresAt", { mode: "timestamp" }),
    createdAt: createdAtField(),
  },
  (t) => [
    unique("recCandidates_userId_urlHash_unique").on(t.userId, t.urlHash),
    index("recCandidates_userId_status_idx").on(t.userId, t.status),
    index("recCandidates_userId_embeddingStatus_idx").on(
      t.userId,
      t.embeddingStatus,
    ),
    index("recCandidates_domainId_idx").on(t.domainId),
    index("recCandidates_clusterId_idx").on(t.clusterId),
    index("recCandidates_expiresAt_idx").on(t.expiresAt),
    index("recCandidates_bookmarkId_idx").on(t.bookmarkId),
  ],
);

/** 候補埋め込みの k-means クラスタ。潜在トピックの単位。 */
export const recClusters = sqliteTable(
  "recClusters",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    label: text("label"),
    centroid: blob("centroid", { mode: "buffer" }).notNull(),
    size: integer("size").notNull().default(0),
    // 正例率をベータ分布で平滑化した値 (FR-L-03、事前分布 α=1, β=4)。
    preferenceScore: real("preferenceScore").notNull().default(0.2),
    positiveCount: integer("positiveCount").notNull().default(0),
    negativeCount: integer("negativeCount").notNull().default(0),
    recentImpressionCount: integer("recentImpressionCount")
      .notNull()
      .default(0),
    computedAt: integer("computedAt", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("recClusters_userId_idx").on(t.userId)],
);

/** 4 種のプロフィール。1 ユーザー 1 行。 */
export const recProfiles = sqliteTable("recProfiles", {
  userId: text("userId")
    .notNull()
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  explicitTopics: text("explicitTopics", { mode: "json" }).$type<string[]>(),
  stableEmbedding: blob("stableEmbedding", { mode: "buffer" }),
  recentEmbedding: blob("recentEmbedding", { mode: "buffer" }),
  negativeEmbedding: blob("negativeEmbedding", { mode: "buffer" }),
  embeddingModelId: text("embeddingModelId"),
  clusterPreferences: text("clusterPreferences", {
    mode: "json",
  }).$type<Record<string, number>>(),
  negativeClusters: text("negativeClusters", {
    mode: "json",
  }).$type<Record<string, number>>(),
  explorationRate: real("explorationRate").notNull().default(0.15),
  // 履歴は持たず、impression 側にこのハッシュを控えて同一性だけ判定する。
  profileHash: text("profileHash"),
  updatedAt: integer("updatedAt", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

/** 1 日 1 スロット分の提示セット。 */
export const recBriefings = sqliteTable(
  "recBriefings",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // ローカル日付を YYYY-MM-DD で持つ。timestamp にすると「その日の briefing」
    // の同一性判定がタイムゾーンに引きずられる。
    briefingDate: text("briefingDate").notNull(),
    slot: text("slot", { enum: ["morning"] })
      .notNull()
      .default("morning"),
    status: text("status", { enum: ["generating", "ready", "failed"] })
      .notNull()
      .default("generating"),
    modelVersion: text("modelVersion"),
    itemCount: integer("itemCount").notNull().default(0),
    generatedAt: integer("generatedAt", { mode: "timestamp" }),

    // 観測状態 (FR-F-05)。unobserved の impression は学習にも指標にも入れない。
    observationState: text("observationState", {
      enum: ["unobserved", "partial", "observed"],
    })
      .notNull()
      .default("unobserved"),
    openedAt: integer("openedAt", { mode: "timestamp" }),
    deepestViewedRank: integer("deepestViewedRank"),
    observationFinalizedAt: integer("observationFinalizedAt", {
      mode: "timestamp",
    }),
    createdAt: createdAtField(),
  },
  (t) => [
    unique("recBriefings_userId_date_slot_unique").on(
      t.userId,
      t.briefingDate,
      t.slot,
    ),
    index("recBriefings_userId_date_idx").on(t.userId, t.briefingDate),
  ],
);

/**
 * 提示。表示されなかったが選定対象になったものも `shown=false` で残す
 * （オフポリシー評価の母集団になる / FR-R-05）。
 */
export const recImpressions = sqliteTable(
  "recImpressions",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    briefingId: text("briefingId").references(() => recBriefings.id, {
      onDelete: "cascade",
    }),
    candidateId: text("candidateId")
      .notNull()
      .references(() => recCandidates.id, { onDelete: "cascade" }),
    domainId: text("domainId").references(() => recDomains.id, {
      onDelete: "set null",
    }),
    // ブートストラップの正例は briefing を持たない。学習では正例カウントには
    // 入れるが、examined の分母とペア生成には使わない。
    source: text("source", { enum: ["briefing", "mcp", "bootstrap"] })
      .notNull()
      .default("briefing"),

    rank: integer("rank"),
    arm: text("arm", {
      enum: ["exploit", "adjacent", "uncertain", "trial", "random"],
    }),
    shown: integer("shown", { mode: "boolean" }).notNull().default(false),
    // 実際に目に入ったと確認できるか (FR-F-06)。viewed イベント、または
    // より下位の impression に viewed があること（通過証明）で true。
    examined: integer("examined", { mode: "boolean" }).notNull().default(false),

    score: real("score"),
    uncertainty: real("uncertainty"),
    // 後から復元できない唯一の値。初日から必ず入れる (§12)。
    propensity: real("propensity"),
    modelVersion: text("modelVersion"),
    // 学習は「現在のプロフィールで計算し直した特徴量」ではなく、必ずこの
    // スナップショットを使う。リーク防止のための必須要件 (FR-L-05b)。
    features: text("features", { mode: "json" }).$type<
      Record<string, number>
    >(),
    featureSchemaVersion: text("featureSchemaVersion"),
    profileHash: text("profileHash"),

    // 提示時点のドメインの状態と事後 (§12)。後から復元できない。
    domainStatusAtImpression: text("domainStatusAtImpression"),
    domainAlpha: real("domainAlpha"),
    domainBeta: real("domainBeta"),

    shownAt: integer("shownAt", { mode: "timestamp" }),
    rewardFinalized: integer("rewardFinalized", { mode: "boolean" })
      .notNull()
      .default(false),
    rewardValue: real("rewardValue"),
    createdAt: createdAtField(),
  },
  (t) => [
    unique("recImpressions_briefingId_candidateId_unique").on(
      t.briefingId,
      t.candidateId,
    ),
    index("recImpressions_userId_createdAt_idx").on(t.userId, t.createdAt),
    index("recImpressions_briefingId_rank_idx").on(t.briefingId, t.rank),
    index("recImpressions_candidateId_idx").on(t.candidateId),
    index("recImpressions_domainId_idx").on(t.domainId),
    index("recImpressions_rewardFinalized_idx").on(t.rewardFinalized),
  ],
);

/**
 * 生イベント。合成報酬は保存しない — 重みは設定で後から変える (§6.1)。
 * イベントは削除せず、取り消しも新しいイベントとして追記する。
 *
 * `no_click` というイベントは定義しない。押されなかったことは観測ではない。
 */
export const recFeedbackEvents = sqliteTable(
  "recFeedbackEvents",
  {
    id: text("id")
      .notNull()
      .primaryKey()
      .$defaultFn(() => createId()),
    impressionId: text("impressionId")
      .notNull()
      .references(() => recImpressions.id, { onDelete: "cascade" }),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    eventType: text("eventType", {
      enum: [
        "viewed",
        "clicked",
        "saved",
        "liked",
        "dismissed",
        "read_partial",
        "read_full",
        "highlighted",
        "favourited",
      ],
    }).notNull(),
    value: real("value"),
    reason: text("reason", {
      enum: ["off_topic", "already_read", "weak_source", "shallow"],
    }),
    occurredAt: integer("occurredAt", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    meta: text("meta", { mode: "json" }).$type<Record<string, unknown>>(),
  },
  (t) => [
    // 冪等性 (FR-A-04)。MCP 経由と UI 経由で同じイベントが二重に入らない。
    unique("recFeedbackEvents_impression_type_at_unique").on(
      t.impressionId,
      t.eventType,
      t.occurredAt,
    ),
    index("recFeedbackEvents_impressionId_idx").on(t.impressionId),
    index("recFeedbackEvents_userId_occurredAt_idx").on(t.userId, t.occurredAt),
  ],
);

/** 学習済みモデル。任意のバージョンにロールバックできるようにする。 */
export const recModels = sqliteTable(
  "recModels",
  {
    version: text("version").notNull().primaryKey(),
    userId: text("userId")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind", {
      enum: ["heuristic", "logreg", "bayes-logreg"],
    }).notNull(),
    params: text("params", { mode: "json" }).$type<unknown>(),
    // スキーマが変わったら旧モデルは自動で retired にする (§7)。
    featureSchema: text("featureSchema", { mode: "json" }).$type<string[]>(),
    featureSchemaVersion: text("featureSchemaVersion"),
    trainedAt: integer("trainedAt", { mode: "timestamp" }),
    trainSampleCount: integer("trainSampleCount").notNull().default(0),
    positiveCount: integer("positiveCount").notNull().default(0),
    metrics: text("metrics", { mode: "json" }).$type<Record<string, number>>(),
    status: text("status", { enum: ["shadow", "active", "retired"] })
      .notNull()
      .default("shadow"),
    createdAt: createdAtField(),
  },
  (t) => [index("recModels_userId_status_idx").on(t.userId, t.status)],
);

export const recDomainsRelations = relations(recDomains, ({ one, many }) => ({
  user: one(users, {
    fields: [recDomains.userId],
    references: [users.id],
  }),
  discoveries: many(recDomainDiscoveries),
  sources: many(recSources),
  candidates: many(recCandidates),
}));

export const recDomainDiscoveriesRelations = relations(
  recDomainDiscoveries,
  ({ one }) => ({
    domain: one(recDomains, {
      fields: [recDomainDiscoveries.domainId],
      references: [recDomains.id],
    }),
  }),
);

export const recSourcesRelations = relations(recSources, ({ one, many }) => ({
  user: one(users, {
    fields: [recSources.userId],
    references: [users.id],
  }),
  domain: one(recDomains, {
    fields: [recSources.domainId],
    references: [recDomains.id],
  }),
  candidates: many(recCandidates),
}));

export const recCandidatesRelations = relations(
  recCandidates,
  ({ one, many }) => ({
    user: one(users, {
      fields: [recCandidates.userId],
      references: [users.id],
    }),
    source: one(recSources, {
      fields: [recCandidates.sourceId],
      references: [recSources.id],
    }),
    domain: one(recDomains, {
      fields: [recCandidates.domainId],
      references: [recDomains.id],
    }),
    bookmark: one(bookmarks, {
      fields: [recCandidates.bookmarkId],
      references: [bookmarks.id],
    }),
    impressions: many(recImpressions),
  }),
);

export const recClustersRelations = relations(recClusters, ({ one }) => ({
  user: one(users, {
    fields: [recClusters.userId],
    references: [users.id],
  }),
}));

export const recProfilesRelations = relations(recProfiles, ({ one }) => ({
  user: one(users, {
    fields: [recProfiles.userId],
    references: [users.id],
  }),
}));

export const recBriefingsRelations = relations(
  recBriefings,
  ({ one, many }) => ({
    user: one(users, {
      fields: [recBriefings.userId],
      references: [users.id],
    }),
    impressions: many(recImpressions),
  }),
);

export const recImpressionsRelations = relations(
  recImpressions,
  ({ one, many }) => ({
    user: one(users, {
      fields: [recImpressions.userId],
      references: [users.id],
    }),
    briefing: one(recBriefings, {
      fields: [recImpressions.briefingId],
      references: [recBriefings.id],
    }),
    candidate: one(recCandidates, {
      fields: [recImpressions.candidateId],
      references: [recCandidates.id],
    }),
    domain: one(recDomains, {
      fields: [recImpressions.domainId],
      references: [recDomains.id],
    }),
    events: many(recFeedbackEvents),
  }),
);

export const recFeedbackEventsRelations = relations(
  recFeedbackEvents,
  ({ one }) => ({
    impression: one(recImpressions, {
      fields: [recFeedbackEvents.impressionId],
      references: [recImpressions.id],
    }),
    user: one(users, {
      fields: [recFeedbackEvents.userId],
      references: [users.id],
    }),
  }),
);

export const recModelsRelations = relations(recModels, ({ one }) => ({
  user: one(users, {
    fields: [recModels.userId],
    references: [users.id],
  }),
}));
