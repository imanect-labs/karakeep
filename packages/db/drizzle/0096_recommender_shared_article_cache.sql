CREATE TABLE `recArticleCache` (
	`urlHash` text PRIMARY KEY NOT NULL,
	`canonicalUrl` text NOT NULL,
	`titleJa` text,
	`summaryJa` text,
	`digestModelId` text,
	`digestedAt` integer,
	`embedding` blob,
	`embeddingModelId` text,
	`embeddingDimensions` integer,
	`embeddedAt` integer,
	`lastUsedAt` integer,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `recArticleCache_lastUsedAt_idx` ON `recArticleCache` (`lastUsedAt`);