CREATE TABLE `recBriefings` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`briefingDate` text NOT NULL,
	`slot` text DEFAULT 'morning' NOT NULL,
	`status` text DEFAULT 'generating' NOT NULL,
	`modelVersion` text,
	`itemCount` integer DEFAULT 0 NOT NULL,
	`generatedAt` integer,
	`observationState` text DEFAULT 'unobserved' NOT NULL,
	`openedAt` integer,
	`deepestViewedRank` integer,
	`observationFinalizedAt` integer,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `recBriefings_userId_date_idx` ON `recBriefings` (`userId`,`briefingDate`);--> statement-breakpoint
CREATE UNIQUE INDEX `recBriefings_userId_date_slot_unique` ON `recBriefings` (`userId`,`briefingDate`,`slot`);--> statement-breakpoint
CREATE TABLE `recCandidates` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`sourceId` text,
	`domainId` text,
	`origin` text DEFAULT 'collected' NOT NULL,
	`url` text NOT NULL,
	`canonicalUrl` text NOT NULL,
	`urlHash` text NOT NULL,
	`titleHash` text,
	`title` text,
	`summary` text,
	`contentExcerpt` text,
	`author` text,
	`publishedAt` integer,
	`fetchedAt` integer,
	`lang` text,
	`embedding` blob,
	`embeddingModelId` text,
	`embeddingStatus` text DEFAULT 'pending' NOT NULL,
	`clusterId` text,
	`duplicateOfId` text,
	`status` text DEFAULT 'active' NOT NULL,
	`bookmarkId` text,
	`expiresAt` integer,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sourceId`) REFERENCES `recSources`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`domainId`) REFERENCES `recDomains`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`duplicateOfId`) REFERENCES `recCandidates`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`bookmarkId`) REFERENCES `bookmarks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `recCandidates_userId_status_idx` ON `recCandidates` (`userId`,`status`);--> statement-breakpoint
CREATE INDEX `recCandidates_userId_embeddingStatus_idx` ON `recCandidates` (`userId`,`embeddingStatus`);--> statement-breakpoint
CREATE INDEX `recCandidates_domainId_idx` ON `recCandidates` (`domainId`);--> statement-breakpoint
CREATE INDEX `recCandidates_clusterId_idx` ON `recCandidates` (`clusterId`);--> statement-breakpoint
CREATE INDEX `recCandidates_expiresAt_idx` ON `recCandidates` (`expiresAt`);--> statement-breakpoint
CREATE INDEX `recCandidates_bookmarkId_idx` ON `recCandidates` (`bookmarkId`);--> statement-breakpoint
CREATE UNIQUE INDEX `recCandidates_userId_urlHash_unique` ON `recCandidates` (`userId`,`urlHash`);--> statement-breakpoint
CREATE TABLE `recClusters` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`label` text,
	`centroid` blob NOT NULL,
	`size` integer DEFAULT 0 NOT NULL,
	`preferenceScore` real DEFAULT 0.2 NOT NULL,
	`positiveCount` integer DEFAULT 0 NOT NULL,
	`negativeCount` integer DEFAULT 0 NOT NULL,
	`recentImpressionCount` integer DEFAULT 0 NOT NULL,
	`computedAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `recClusters_userId_idx` ON `recClusters` (`userId`);--> statement-breakpoint
CREATE TABLE `recDomainDiscoveries` (
	`id` text PRIMARY KEY NOT NULL,
	`domainId` text NOT NULL,
	`channel` text NOT NULL,
	`evidenceRef` text,
	`evidenceLabel` text,
	`weight` real DEFAULT 1 NOT NULL,
	`discoveredAt` integer NOT NULL,
	FOREIGN KEY (`domainId`) REFERENCES `recDomains`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `recDomainDiscoveries_domainId_idx` ON `recDomainDiscoveries` (`domainId`);--> statement-breakpoint
CREATE INDEX `recDomainDiscoveries_channel_idx` ON `recDomainDiscoveries` (`channel`);--> statement-breakpoint
CREATE TABLE `recDomains` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`domain` text NOT NULL,
	`status` text DEFAULT 'discovered' NOT NULL,
	`feedUrl` text,
	`scrapable` integer DEFAULT false NOT NULL,
	`title` text,
	`description` text,
	`faviconUrl` text,
	`qualityClass` text DEFAULT 'unknown' NOT NULL,
	`qualityCheckedAt` integer,
	`blockedReason` text,
	`centroid` blob,
	`centroidUpdatedAt` integer,
	`examinedCount` integer DEFAULT 0 NOT NULL,
	`positiveCount` integer DEFAULT 0 NOT NULL,
	`betaAlpha` real DEFAULT 1 NOT NULL,
	`betaBeta` real DEFAULT 4 NOT NULL,
	`trialStartedAt` integer,
	`trialImpressionCount` integer DEFAULT 0 NOT NULL,
	`promotedAt` integer,
	`demotedAt` integer,
	`manualDecision` text,
	`lastSelectedAt` integer,
	`fetchTier` text DEFAULT 'every3days' NOT NULL,
	`lastCrawledAt` integer,
	`firstSeenAt` integer,
	`lastArticleAt` integer,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `recDomains_userId_status_idx` ON `recDomains` (`userId`,`status`);--> statement-breakpoint
CREATE INDEX `recDomains_lastSelectedAt_idx` ON `recDomains` (`lastSelectedAt`);--> statement-breakpoint
CREATE UNIQUE INDEX `recDomains_userId_domain_unique` ON `recDomains` (`userId`,`domain`);--> statement-breakpoint
CREATE TABLE `recFeedbackEvents` (
	`id` text PRIMARY KEY NOT NULL,
	`impressionId` text NOT NULL,
	`userId` text NOT NULL,
	`eventType` text NOT NULL,
	`value` real,
	`reason` text,
	`occurredAt` integer NOT NULL,
	`meta` text,
	FOREIGN KEY (`impressionId`) REFERENCES `recImpressions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `recFeedbackEvents_impressionId_idx` ON `recFeedbackEvents` (`impressionId`);--> statement-breakpoint
CREATE INDEX `recFeedbackEvents_userId_occurredAt_idx` ON `recFeedbackEvents` (`userId`,`occurredAt`);--> statement-breakpoint
CREATE UNIQUE INDEX `recFeedbackEvents_impression_type_at_unique` ON `recFeedbackEvents` (`impressionId`,`eventType`,`occurredAt`);--> statement-breakpoint
CREATE TABLE `recImpressions` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`briefingId` text,
	`candidateId` text NOT NULL,
	`domainId` text,
	`source` text DEFAULT 'briefing' NOT NULL,
	`rank` integer,
	`arm` text,
	`shown` integer DEFAULT false NOT NULL,
	`examined` integer DEFAULT false NOT NULL,
	`score` real,
	`uncertainty` real,
	`propensity` real,
	`modelVersion` text,
	`features` text,
	`featureSchemaVersion` text,
	`profileHash` text,
	`domainStatusAtImpression` text,
	`domainAlpha` real,
	`domainBeta` real,
	`shownAt` integer,
	`rewardFinalized` integer DEFAULT false NOT NULL,
	`rewardValue` real,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`briefingId`) REFERENCES `recBriefings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`candidateId`) REFERENCES `recCandidates`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`domainId`) REFERENCES `recDomains`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `recImpressions_userId_createdAt_idx` ON `recImpressions` (`userId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `recImpressions_briefingId_rank_idx` ON `recImpressions` (`briefingId`,`rank`);--> statement-breakpoint
CREATE INDEX `recImpressions_candidateId_idx` ON `recImpressions` (`candidateId`);--> statement-breakpoint
CREATE INDEX `recImpressions_domainId_idx` ON `recImpressions` (`domainId`);--> statement-breakpoint
CREATE INDEX `recImpressions_rewardFinalized_idx` ON `recImpressions` (`rewardFinalized`);--> statement-breakpoint
CREATE UNIQUE INDEX `recImpressions_briefingId_candidateId_unique` ON `recImpressions` (`briefingId`,`candidateId`);--> statement-breakpoint
CREATE TABLE `recModels` (
	`version` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`kind` text NOT NULL,
	`params` text,
	`featureSchema` text,
	`featureSchemaVersion` text,
	`trainedAt` integer,
	`trainSampleCount` integer DEFAULT 0 NOT NULL,
	`positiveCount` integer DEFAULT 0 NOT NULL,
	`metrics` text,
	`status` text DEFAULT 'shadow' NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `recModels_userId_status_idx` ON `recModels` (`userId`,`status`);--> statement-breakpoint
CREATE TABLE `recProfiles` (
	`userId` text PRIMARY KEY NOT NULL,
	`explicitTopics` text,
	`stableEmbedding` blob,
	`recentEmbedding` blob,
	`negativeEmbedding` blob,
	`embeddingModelId` text,
	`clusterPreferences` text,
	`negativeClusters` text,
	`explorationRate` real DEFAULT 0.15 NOT NULL,
	`profileHash` text,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `recSources` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`domainId` text,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`config` text,
	`profileIndependent` integer DEFAULT false NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`consecutiveFailures` integer DEFAULT 0 NOT NULL,
	`lastError` text,
	`lastFetchedAt` integer,
	`lastSuccessfulFetchAt` integer,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`domainId`) REFERENCES `recDomains`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `recSources_userId_enabled_idx` ON `recSources` (`userId`,`enabled`);--> statement-breakpoint
CREATE INDEX `recSources_domainId_idx` ON `recSources` (`domainId`);