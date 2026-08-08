import crypto from "node:crypto";
import path from "path";
import { z } from "zod";

const stringBool = (defaultValue: string) =>
  z
    .string()
    .prefault(defaultValue)
    .refine((s) => s === "true" || s === "false")
    .transform((s) => s === "true");

const optionalStringBool = () =>
  z
    .string()
    .refine((s) => s === "true" || s === "false")
    .transform((s) => s === "true")
    .optional();

const allEnv = z.object({
  PORT: z.coerce.number().default(3000),
  WORKERS_HOST: z.string().default("127.0.0.1"),
  WORKERS_PORT: z.coerce.number().default(0),
  WORKERS_ENABLED_WORKERS: z
    .string()
    .prefault("")
    .transform((val) =>
      val
        .split(",")
        .map((w) => w.trim())
        .filter((w) => w),
    ),
  WORKERS_DISABLED_WORKERS: z
    .string()
    .prefault("")
    .transform((val) =>
      val
        .split(",")
        .map((w) => w.trim())
        .filter((w) => w),
    ),
  API_URL: z.string().url().default("http://localhost:3000"),
  NEXTAUTH_URL: z
    .string()
    .url()
    .prefault("http://localhost:3000")
    .transform((s) => s.replace(/\/+$/, "")),
  NEXTAUTH_SECRET: z.string().optional(),
  DISABLE_SIGNUPS: stringBool("false"),
  DISABLE_PASSWORD_AUTH: stringBool("false"),
  OAUTH_AUTO_REDIRECT: stringBool("false"),
  OAUTH_ALLOW_DANGEROUS_EMAIL_ACCOUNT_LINKING: stringBool("false"),
  OAUTH_WELLKNOWN_URL: z.string().url().optional(),
  OAUTH_CLIENT_SECRET: z.string().optional(),
  OAUTH_CLIENT_ID: z.string().optional(),
  OAUTH_TIMEOUT: z.coerce.number().optional().default(3500),
  OAUTH_SCOPE: z.string().default("openid email profile"),
  OAUTH_PROVIDER_NAME: z.string().default("Custom Provider"),
  TURNSTILE_SITE_KEY: z.string().optional(),
  TURNSTILE_SECRET_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().url().optional(),
  OPENAI_PROXY_URL: z.string().url().optional(),
  OPENAI_TIMEOUT_SEC: z.coerce.number().positive().optional(),
  OPENAI_SERVICE_TIER: z.enum(["auto", "default", "flex"]).optional(),
  OPENAI_REASONING_EFFORT: z
    .enum(["none", "minimal", "low", "medium", "high", "xhigh"])
    .optional(),
  OLLAMA_BASE_URL: z.string().url().optional(),
  OLLAMA_KEEP_ALIVE: z.string().optional(),
  CHAT_ENABLED: stringBool("false"),
  CHAT_MODEL: z.string().optional(),
  INFERENCE_JOB_TIMEOUT_SEC: z.coerce.number().default(30),
  INFERENCE_FETCH_TIMEOUT_SEC: z.coerce.number().default(300),
  INFERENCE_TEXT_MODEL: z.string().default("gpt-4.1-mini"),
  INFERENCE_IMAGE_MODEL: z.string().default("gpt-4o-mini"),
  EMBEDDING_ENABLE_AUTO_INDEXING: stringBool("false"),
  // Embeddings get their own provider (imanect-labs fork). Upstream sends them
  // to whatever OPENAI_BASE_URL points at, which breaks as soon as that URL is
  // a chat-completion relay with no /embeddings route. Leave these unset to
  // keep upstream's behaviour of reusing the inference provider.
  EMBEDDING_PROVIDER: z.enum(["openai", "ollama"]).optional(),
  EMBEDDING_BASE_URL: z.string().url().optional(),
  EMBEDDING_API_KEY: z.string().optional(),
  EMBEDDING_TEXT_MODEL: z.string().default("text-embedding-3-small"),
  EMBEDDING_DIMENSIONS: z.coerce.number().default(1536),
  EMBEDDING_CONTEXT_LENGTH: z.coerce.number().int().positive().default(8000),
  EMBEDDING_NUM_WORKERS: z.coerce.number().default(1),
  EMBEDDING_JOB_TIMEOUT_SEC: z.coerce.number().default(60),
  INFERENCE_CONTEXT_LENGTH: z.coerce.number().default(2048),
  INFERENCE_MAX_OUTPUT_TOKENS: z.coerce.number().default(2048),
  INFERENCE_USE_MAX_COMPLETION_TOKENS: stringBool("false"),
  INFERENCE_SUPPORTS_STRUCTURED_OUTPUT: optionalStringBool(),
  INFERENCE_OUTPUT_SCHEMA: z
    .enum(["structured", "json", "plain"])
    .default("structured"),
  INFERENCE_ENABLE_AUTO_TAGGING: stringBool("true"),
  INFERENCE_ENABLE_AUTO_SUMMARIZATION: stringBool("false"),
  // Briefing Recommender (imanect-labs fork). 既定値は ROADMAP の
  // 「段階的な有効化」前半 2 週（trial 0% / random 15%）に合わせてある。
  // trial を 10% に上げるのは config の変更だけで済ませる。
  RECOMMENDER_ENABLED: stringBool("false"),
  RECOMMENDER_CONTACT_URL: z.string().optional(),
  RECOMMENDER_NUM_WORKERS: z.coerce.number().default(1),
  RECOMMENDER_JOB_TIMEOUT_SEC: z.coerce.number().default(900),
  RECOMMENDER_DAILY_INTAKE_CAP: z.coerce.number().int().positive().default(400),
  RECOMMENDER_PER_SOURCE_FETCH_LIMIT: z.coerce
    .number()
    .int()
    .positive()
    .default(60),
  RECOMMENDER_BRIEFING_SIZE: z.coerce.number().int().positive().default(20),
  RECOMMENDER_CANDIDATE_TTL_DAYS: z.coerce
    .number()
    .int()
    .positive()
    .default(14),
  RECOMMENDER_CANDIDATE_PURGE_DAYS: z.coerce
    .number()
    .int()
    .positive()
    .default(90),
  RECOMMENDER_DOMAIN_SEATS: z.coerce.number().int().positive().default(80),
  RECOMMENDER_MAX_TRIAL_DOMAINS: z.coerce.number().int().positive().default(10),
  RECOMMENDER_ARM_EXPLOIT: z.coerce.number().default(0.55),
  RECOMMENDER_ARM_ADJACENT: z.coerce.number().default(0.2),
  RECOMMENDER_ARM_UNCERTAIN: z.coerce.number().default(0.1),
  RECOMMENDER_ARM_TRIAL: z.coerce.number().default(0),
  RECOMMENDER_ARM_RANDOM: z.coerce.number().default(0.15),
  RECOMMENDER_SOFTMAX_TEMPERATURE: z.coerce.number().positive().default(0.15),
  RECOMMENDER_EMBEDDING_DIMENSIONS: z.coerce
    .number()
    .int()
    .positive()
    .optional(),
  RECOMMENDER_EMBED_BATCH_SIZE: z.coerce.number().int().positive().default(16),
  RECOMMENDER_DISCOVER_CRON: z.string().default("30 3 * * *"),
  RECOMMENDER_COLLECT_CRON: z.string().default("0 4 * * *"),
  RECOMMENDER_RANK_CRON: z.string().default("30 5 * * *"),
  RECOMMENDER_TRAIN_CRON: z.string().default("0 3 * * *"),
  RECOMMENDER_MAINTAIN_CRON: z.string().default("0 2 * * *"),
  // 日本語ダイジェスト (rank 後の表示分だけ訳題・要約を生成する)。
  //   off      … 生成しない
  //   local    … Ollama (EMBEDDING_BASE_URL と同じサーバー) の chat API
  //   external … OPENAI_BASE_URL の chat API (inference と同じプロバイダ)
  RECOMMENDER_DIGEST_PROVIDER: z
    .enum(["off", "local", "external"])
    .default("off"),
  RECOMMENDER_DIGEST_MODEL: z.string().default("qwen3.5:4b"),
  // 記事本文が足りないときに URL を fetch して readability で抜くか。
  RECOMMENDER_DIGEST_FETCH_BODY: stringBool("true"),
  // 要約の入力に使う本文の最大文字数。長いほど品質は上がるが遅くなる。
  RECOMMENDER_DIGEST_BODY_CHARS: z.coerce
    .number()
    .int()
    .positive()
    .default(1000),
  OCR_CACHE_DIR: z.string().optional(),
  OCR_LANGS: z
    .string()
    .prefault("eng")
    .transform((val) => val.split(",")),
  OCR_CONFIDENCE_THRESHOLD: z.coerce.number().default(50),
  OCR_USE_LLM: stringBool("false"),
  CRAWLER_HEADLESS_BROWSER: stringBool("true"),
  BROWSER_WEB_URL: z.string().optional(),
  BROWSER_WEBSOCKET_URL: z.string().optional(),
  BROWSER_CONNECT_ONDEMAND: stringBool("false"),
  BROWSER_COOKIE_PATH: z.string().optional(),
  CRAWLER_JOB_TIMEOUT_SEC: z.coerce.number().default(60),
  CRAWLER_NAVIGATE_TIMEOUT_SEC: z.coerce.number().default(30),
  CRAWLER_NUM_WORKERS: z.coerce.number().default(1),
  INFERENCE_NUM_WORKERS: z.coerce.number().default(1),
  SEARCH_NUM_WORKERS: z.coerce.number().default(1),
  SEARCH_JOB_TIMEOUT_SEC: z.coerce.number().default(30),
  WEBHOOK_NUM_WORKERS: z.coerce.number().default(1),
  ASSET_PREPROCESSING_NUM_WORKERS: z.coerce.number().default(1),
  ASSET_PREPROCESSING_JOB_TIMEOUT_SEC: z.coerce.number().default(60),
  RULE_ENGINE_NUM_WORKERS: z.coerce.number().default(1),
  CRAWLER_DOWNLOAD_BANNER_IMAGE: stringBool("true"),
  CRAWLER_STORE_SCREENSHOT: stringBool("true"),
  CRAWLER_FULL_PAGE_SCREENSHOT: stringBool("false"),
  CRAWLER_STORE_PDF: stringBool("false"),
  CRAWLER_FULL_PAGE_ARCHIVE: stringBool("false"),
  CRAWLER_VIDEO_DOWNLOAD: stringBool("false"),
  CRAWLER_VIDEO_DOWNLOAD_MAX_SIZE: z.coerce.number().default(50),
  CRAWLER_VIDEO_DOWNLOAD_TIMEOUT_SEC: z.coerce.number().default(10 * 60),
  CRAWLER_ENABLE_ADBLOCKER: stringBool("true"),
  CRAWLER_YTDLP_ARGS: z
    .string()
    .prefault("")
    .transform((t) => t.split("%%").filter((a) => a)),
  CRAWLER_MONOLITH_TIMEOUT_SEC: z.coerce.number().default(5),
  CRAWLER_MONOLITH_ARGS: z
    .string()
    .prefault("")
    .transform((t) => t.split("%%").filter((a) => a)),
  CRAWLER_PARSER_MEM_LIMIT_MB: z.coerce.number().default(512),
  CRAWLER_PARSE_TIMEOUT_SEC: z.coerce.number().default(60),
  CRAWLER_SCREENSHOT_TIMEOUT_SEC: z.coerce.number().default(5),
  CRAWLER_IP_VALIDATION_DNS_RESOLVER_TIMEOUT_SEC: z.coerce.number().default(1),
  CRAWLER_DOMAIN_RATE_LIMIT_WINDOW_MS: z.coerce.number().min(1).optional(),
  CRAWLER_DOMAIN_RATE_LIMIT_MAX_REQUESTS: z.coerce.number().min(1).optional(),
  CRAWLER_PREFLIGHT_USER_AGENT: z.string().optional(),
  LOG_LEVEL: z.string().default("debug"),
  NO_COLOR: stringBool("false"),
  DEMO_MODE: stringBool("false"),
  DEMO_MODE_EMAIL: z.string().optional(),
  DEMO_MODE_PASSWORD: z.string().optional(),
  DATA_DIR: z.string().default(""),
  ASSETS_DIR: z.string().optional(),
  MAX_ASSET_SIZE_MB: z.coerce.number().default(50),
  HTML_CONTENT_SIZE_INLINE_THRESHOLD_BYTES: z.coerce.number().default(5 * 1024),
  INFERENCE_LANG: z.string().default("english"),
  // How many of the user's existing tags to offer the model so it reuses them
  // instead of inventing a variant or a translation. Most-used first; 0 disables.
  INFERENCE_EXISTING_TAGS_LIMIT: z.coerce.number().int().min(0).default(200),
  // Send `thinking: {type: "disabled"}` to the OpenAI-compatible endpoint to turn
  // off reasoning. Needed for reasoning models (e.g. DeepSeek V4 Flash via OpenCode
  // Go) that otherwise spend the whole output budget on reasoning and return empty
  // content ("Got no message content"). (imanect-labs fork)
  INFERENCE_DISABLE_THINKING: stringBool("false"),
  // Structure-preserving LLM HTML translation (imanect-labs fork).
  TRANSLATION_ENABLE_AUTO: stringBool("false"),
  TRANSLATION_TARGET_LANG: z.string().default("japanese"),
  TRANSLATION_NUM_WORKERS: z.coerce.number().default(1),
  TRANSLATION_JOB_TIMEOUT_SEC: z.coerce.number().default(120),
  // Approx input tokens per chunk sent to the LLM (output is similar in size).
  TRANSLATION_CHUNK_TOKENS: z.coerce.number().default(1200),
  // How many times a single chunk may be sent before giving up and keeping the
  // cleanest attempt. The endpoint intermittently echoes the input untranslated,
  // prepends a preamble, or rewrites code; resampling clears it. 1 disables.
  TRANSLATION_MAX_CHUNK_ATTEMPTS: z.coerce.number().int().min(1).default(3),
  // Skip translation when the content already looks like the target language
  // (avoids re-translating e.g. Japanese pages). Uses a CJK/kana ratio heuristic.
  TRANSLATION_SKIP_IF_TARGET: stringBool("true"),
  WEBHOOK_TIMEOUT_SEC: z.coerce.number().default(5),
  WEBHOOK_RETRY_TIMES: z.coerce.number().int().min(0).default(3),
  MAX_RSS_FEEDS_PER_USER: z.coerce.number().default(1000),
  MAX_WEBHOOKS_PER_USER: z.coerce.number().default(100),
  // Legal
  TERMS_OF_SERVICE_URL: z.string().url().optional(),
  PRIVACY_POLICY_URL: z.string().url().optional(),

  // Build only flag
  SERVER_VERSION: z.string().optional(),
  CHANGELOG_VERSION: z.string().optional(),
  DISABLE_NEW_RELEASE_CHECK: stringBool("false"),

  // A flag to detect if the user is running in the old separete containers setup
  USING_LEGACY_SEPARATE_CONTAINERS: stringBool("false"),

  // Prometheus metrics configuration
  PROMETHEUS_AUTH_TOKEN: z.string().optional(),

  // Email configuration
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().optional().default(587),
  SMTP_SECURE: stringBool("false"),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.string().optional(),
  EMAIL_VERIFICATION_REQUIRED: stringBool("false"),

  // Asset storage configuration
  ASSET_STORE_S3_ENDPOINT: z.string().optional(),
  ASSET_STORE_S3_REGION: z.string().optional(),
  ASSET_STORE_S3_BUCKET: z.string().optional(),
  ASSET_STORE_S3_ACCESS_KEY_ID: z.string().optional(),
  ASSET_STORE_S3_SECRET_ACCESS_KEY: z.string().optional(),
  ASSET_STORE_S3_FORCE_PATH_STYLE: stringBool("false"),

  // Rate limiting configuration
  RATE_LIMITING_ENABLED: stringBool("false"),

  // Redis configuration
  REDIS_URL: z.string().url().optional(),

  // Stripe configuration
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_PUBLISHABLE_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRICE_ID: z.string().optional(),
  STRIPE_YEARLY_PRICE_ID: z.string().optional(),

  FREE_QUOTA_BOOKMARK_LIMIT: z.coerce.number().optional(),
  FREE_QUOTA_ASSET_SIZE_BYTES: z.coerce.number().optional(),
  FREE_BROWSER_CRAWLING_ENABLED: optionalStringBool(),
  PAID_QUOTA_BOOKMARK_LIMIT: z.coerce.number().optional(),
  PAID_QUOTA_ASSET_SIZE_BYTES: z.coerce.number().optional(),
  PAID_BROWSER_CRAWLING_ENABLED: optionalStringBool(),

  // Proxy configuration
  CRAWLER_HTTP_PROXY: z
    .string()
    .transform((val) =>
      val
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p),
    )
    .optional(),
  CRAWLER_HTTPS_PROXY: z
    .string()
    .transform((val) =>
      val
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p),
    )
    .optional(),
  CRAWLER_NO_PROXY: z
    .string()
    .transform((val) =>
      val
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p),
    )
    .optional(),
  CRAWLER_ALLOWED_INTERNAL_HOSTNAMES: z
    .string()
    .transform((val) =>
      val
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p),
    )
    .optional(),

  // Database configuration
  DB_WAL_MODE: stringBool("false"),

  // OpenTelemetry tracing configuration
  OTEL_TRACING_ENABLED: stringBool("false"),
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: z.string().url().optional(),
  OTEL_SERVICE_NAME: z.string().default("karakeep"),
  OTEL_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(1.0),

  // Event logging configuration
  EVENT_LOGS_ENABLED: stringBool("false"),
  OTEL_EVENT_LOGS_EXPORT_ENABLED: stringBool("false"),
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: z.string().url().optional(),
});

const serverConfigSchema = allEnv.transform((val, ctx) => {
  const obj = {
    port: val.PORT,
    workers: {
      host: val.WORKERS_HOST,
      port: val.WORKERS_PORT,
      enabledWorkers: val.WORKERS_ENABLED_WORKERS,
      disabledWorkers: val.WORKERS_DISABLED_WORKERS,
    },
    apiUrl: val.API_URL,
    publicUrl: val.NEXTAUTH_URL,
    publicApiUrl: `${val.NEXTAUTH_URL}/api`,
    signingSecret: () => {
      if (!val.NEXTAUTH_SECRET) {
        throw new Error("NEXTAUTH_SECRET is not set");
      }
      return val.NEXTAUTH_SECRET;
    },
    auth: {
      disableSignups: val.DISABLE_SIGNUPS,
      disablePasswordAuth: val.DISABLE_PASSWORD_AUTH,
      emailVerificationRequired: val.EMAIL_VERIFICATION_REQUIRED,
      oauth: {
        autoRedirect: val.OAUTH_AUTO_REDIRECT,
        allowDangerousEmailAccountLinking:
          val.OAUTH_ALLOW_DANGEROUS_EMAIL_ACCOUNT_LINKING,
        wellKnownUrl: val.OAUTH_WELLKNOWN_URL,
        clientSecret: val.OAUTH_CLIENT_SECRET,
        clientId: val.OAUTH_CLIENT_ID,
        scope: val.OAUTH_SCOPE,
        name: val.OAUTH_PROVIDER_NAME,
        timeout: val.OAUTH_TIMEOUT,
      },
      turnstile: {
        enabled: val.TURNSTILE_SITE_KEY !== undefined,
        siteKey: val.TURNSTILE_SITE_KEY,
        secretKey: val.TURNSTILE_SECRET_KEY,
      },
    },
    email: {
      smtp: val.SMTP_HOST
        ? {
            host: val.SMTP_HOST,
            port: val.SMTP_PORT,
            secure: val.SMTP_SECURE,
            user: val.SMTP_USER,
            password: val.SMTP_PASSWORD,
            from: val.SMTP_FROM,
          }
        : undefined,
    },
    inference: {
      isConfigured: !!val.OPENAI_API_KEY || !!val.OLLAMA_BASE_URL,
      numWorkers: val.INFERENCE_NUM_WORKERS,
      jobTimeoutSec: val.INFERENCE_JOB_TIMEOUT_SEC,
      fetchTimeoutSec: val.INFERENCE_FETCH_TIMEOUT_SEC,
      openAIApiKey: val.OPENAI_API_KEY,
      openAIBaseUrl: val.OPENAI_BASE_URL,
      openAIProxyUrl: val.OPENAI_PROXY_URL,
      openAITimeoutSec: val.OPENAI_TIMEOUT_SEC,
      openAIServiceTier: val.OPENAI_SERVICE_TIER,
      openAIReasoningEffort: val.OPENAI_REASONING_EFFORT,
      ollamaBaseUrl: val.OLLAMA_BASE_URL,
      ollamaKeepAlive: val.OLLAMA_KEEP_ALIVE,
      chatModel: val.CHAT_MODEL ?? val.INFERENCE_TEXT_MODEL,
      textModel: val.INFERENCE_TEXT_MODEL,
      imageModel: val.INFERENCE_IMAGE_MODEL,
      inferredTagLang: val.INFERENCE_LANG,
      existingTagsLimit: val.INFERENCE_EXISTING_TAGS_LIMIT,
      contextLength: val.INFERENCE_CONTEXT_LENGTH,
      maxOutputTokens: val.INFERENCE_MAX_OUTPUT_TOKENS,
      useMaxCompletionTokens: val.INFERENCE_USE_MAX_COMPLETION_TOKENS,
      disableThinking: val.INFERENCE_DISABLE_THINKING,
      outputSchema:
        val.INFERENCE_SUPPORTS_STRUCTURED_OUTPUT !== undefined
          ? val.INFERENCE_SUPPORTS_STRUCTURED_OUTPUT
            ? ("structured" as const)
            : ("plain" as const)
          : val.INFERENCE_OUTPUT_SCHEMA,
      enableAutoTagging: val.INFERENCE_ENABLE_AUTO_TAGGING,
      enableAutoSummarization: val.INFERENCE_ENABLE_AUTO_SUMMARIZATION,
    },
    translation: {
      enableAuto: val.TRANSLATION_ENABLE_AUTO,
      targetLang: val.TRANSLATION_TARGET_LANG,
      numWorkers: val.TRANSLATION_NUM_WORKERS,
      jobTimeoutSec: val.TRANSLATION_JOB_TIMEOUT_SEC,
      chunkTokens: val.TRANSLATION_CHUNK_TOKENS,
      maxChunkAttempts: val.TRANSLATION_MAX_CHUNK_ATTEMPTS,
      skipIfTarget: val.TRANSLATION_SKIP_IF_TARGET,
    },
    chat: {
      enabled: val.CHAT_ENABLED,
    },
    embedding: {
      enableAutoIndexing: val.EMBEDDING_ENABLE_AUTO_INDEXING,
      provider: val.EMBEDDING_PROVIDER,
      baseUrl: val.EMBEDDING_BASE_URL,
      apiKey: val.EMBEDDING_API_KEY,
      textModel: val.EMBEDDING_TEXT_MODEL,
      dimensions: val.EMBEDDING_DIMENSIONS,
      contextLength: val.EMBEDDING_CONTEXT_LENGTH,
      numWorkers: val.EMBEDDING_NUM_WORKERS,
      jobTimeoutSec: val.EMBEDDING_JOB_TIMEOUT_SEC,
    },
    recommender: {
      enabled: val.RECOMMENDER_ENABLED,
      contactUrl: val.RECOMMENDER_CONTACT_URL,
      numWorkers: val.RECOMMENDER_NUM_WORKERS,
      jobTimeoutSec: val.RECOMMENDER_JOB_TIMEOUT_SEC,
      dailyIntakeCap: val.RECOMMENDER_DAILY_INTAKE_CAP,
      perSourceFetchLimit: val.RECOMMENDER_PER_SOURCE_FETCH_LIMIT,
      briefingSize: val.RECOMMENDER_BRIEFING_SIZE,
      candidateTtlDays: val.RECOMMENDER_CANDIDATE_TTL_DAYS,
      candidatePurgeDays: val.RECOMMENDER_CANDIDATE_PURGE_DAYS,
      domainSeats: val.RECOMMENDER_DOMAIN_SEATS,
      maxTrialDomains: val.RECOMMENDER_MAX_TRIAL_DOMAINS,
      arms: {
        exploit: val.RECOMMENDER_ARM_EXPLOIT,
        adjacent: val.RECOMMENDER_ARM_ADJACENT,
        uncertain: val.RECOMMENDER_ARM_UNCERTAIN,
        trial: val.RECOMMENDER_ARM_TRIAL,
        random: val.RECOMMENDER_ARM_RANDOM,
      },
      softmaxTemperature: val.RECOMMENDER_SOFTMAX_TEMPERATURE,
      embeddingDimensions: val.RECOMMENDER_EMBEDDING_DIMENSIONS,
      embedBatchSize: val.RECOMMENDER_EMBED_BATCH_SIZE,
      cron: {
        discover: val.RECOMMENDER_DISCOVER_CRON,
        collect: val.RECOMMENDER_COLLECT_CRON,
        rank: val.RECOMMENDER_RANK_CRON,
        train: val.RECOMMENDER_TRAIN_CRON,
        maintain: val.RECOMMENDER_MAINTAIN_CRON,
      },
      digest: {
        provider: val.RECOMMENDER_DIGEST_PROVIDER,
        model: val.RECOMMENDER_DIGEST_MODEL,
        fetchBody: val.RECOMMENDER_DIGEST_FETCH_BODY,
        bodyChars: val.RECOMMENDER_DIGEST_BODY_CHARS,
      },
    },
    crawler: {
      numWorkers: val.CRAWLER_NUM_WORKERS,
      headlessBrowser: val.CRAWLER_HEADLESS_BROWSER,
      browserWebUrl: val.BROWSER_WEB_URL,
      browserWebSocketUrl: val.BROWSER_WEBSOCKET_URL,
      browserConnectOnDemand: val.BROWSER_CONNECT_ONDEMAND,
      browserCookiePath: val.BROWSER_COOKIE_PATH,
      jobTimeoutSec: val.CRAWLER_JOB_TIMEOUT_SEC,
      navigateTimeoutSec: val.CRAWLER_NAVIGATE_TIMEOUT_SEC,
      downloadBannerImage: val.CRAWLER_DOWNLOAD_BANNER_IMAGE,
      storeScreenshot: val.CRAWLER_STORE_SCREENSHOT,
      fullPageScreenshot: val.CRAWLER_FULL_PAGE_SCREENSHOT,
      storePdf: val.CRAWLER_STORE_PDF,
      fullPageArchive: val.CRAWLER_FULL_PAGE_ARCHIVE,
      downloadVideo: val.CRAWLER_VIDEO_DOWNLOAD,
      maxVideoDownloadSize: val.CRAWLER_VIDEO_DOWNLOAD_MAX_SIZE,
      downloadVideoTimeout: val.CRAWLER_VIDEO_DOWNLOAD_TIMEOUT_SEC,
      enableAdblocker: val.CRAWLER_ENABLE_ADBLOCKER,
      ytDlpArguments: val.CRAWLER_YTDLP_ARGS,
      monolithTimeoutSec: val.CRAWLER_MONOLITH_TIMEOUT_SEC,
      monolithArguments: val.CRAWLER_MONOLITH_ARGS,
      parserMemLimitMb: val.CRAWLER_PARSER_MEM_LIMIT_MB,
      parseTimeoutSec: val.CRAWLER_PARSE_TIMEOUT_SEC,
      screenshotTimeoutSec: val.CRAWLER_SCREENSHOT_TIMEOUT_SEC,
      htmlContentSizeThreshold: val.HTML_CONTENT_SIZE_INLINE_THRESHOLD_BYTES,
      ipValidation: {
        dnsResolverTimeoutSec:
          val.CRAWLER_IP_VALIDATION_DNS_RESOLVER_TIMEOUT_SEC,
      },
      domainRatelimiting:
        val.CRAWLER_DOMAIN_RATE_LIMIT_WINDOW_MS !== undefined &&
        val.CRAWLER_DOMAIN_RATE_LIMIT_MAX_REQUESTS !== undefined
          ? {
              windowMs: val.CRAWLER_DOMAIN_RATE_LIMIT_WINDOW_MS,
              maxRequests: val.CRAWLER_DOMAIN_RATE_LIMIT_MAX_REQUESTS,
            }
          : null,
      preflightUserAgent: val.CRAWLER_PREFLIGHT_USER_AGENT,
    },
    ocr: {
      langs: val.OCR_LANGS,
      cacheDir: val.OCR_CACHE_DIR,
      confidenceThreshold: val.OCR_CONFIDENCE_THRESHOLD,
      useLLM: val.OCR_USE_LLM,
    },
    search: {
      numWorkers: val.SEARCH_NUM_WORKERS,
      jobTimeoutSec: val.SEARCH_JOB_TIMEOUT_SEC,
    },
    logLevel: val.LOG_LEVEL,
    logNoColor: val.NO_COLOR,
    demoMode: val.DEMO_MODE
      ? {
          email: val.DEMO_MODE_EMAIL,
          password: val.DEMO_MODE_PASSWORD,
        }
      : undefined,
    dataDir: val.DATA_DIR,
    assetsDir: val.ASSETS_DIR ?? path.join(val.DATA_DIR, "assets"),
    maxAssetSizeMb: val.MAX_ASSET_SIZE_MB,
    legal: {
      termsOfServiceUrl: val.TERMS_OF_SERVICE_URL,
      privacyPolicyUrl: val.PRIVACY_POLICY_URL,
    },
    serverVersion: val.SERVER_VERSION,
    changelogVersion: val.CHANGELOG_VERSION,
    disableNewReleaseCheck: val.DISABLE_NEW_RELEASE_CHECK,
    usingLegacySeparateContainers: val.USING_LEGACY_SEPARATE_CONTAINERS,
    webhook: {
      timeoutSec: val.WEBHOOK_TIMEOUT_SEC,
      retryTimes: val.WEBHOOK_RETRY_TIMES,
      numWorkers: val.WEBHOOK_NUM_WORKERS,
      maxWebhooksPerUser: val.MAX_WEBHOOKS_PER_USER,
    },
    feeds: {
      maxRssFeedsPerUser: val.MAX_RSS_FEEDS_PER_USER,
    },
    proxy: {
      httpProxy: val.CRAWLER_HTTP_PROXY,
      httpsProxy: val.CRAWLER_HTTPS_PROXY,
      noProxy: val.CRAWLER_NO_PROXY,
    },
    allowedInternalHostnames: val.CRAWLER_ALLOWED_INTERNAL_HOSTNAMES,
    assetPreprocessing: {
      numWorkers: val.ASSET_PREPROCESSING_NUM_WORKERS,
      jobTimeoutSec: val.ASSET_PREPROCESSING_JOB_TIMEOUT_SEC,
    },
    ruleEngine: {
      numWorkers: val.RULE_ENGINE_NUM_WORKERS,
    },
    assetStore: {
      type: val.ASSET_STORE_S3_ENDPOINT
        ? ("s3" as const)
        : ("filesystem" as const),
      s3: {
        endpoint: val.ASSET_STORE_S3_ENDPOINT,
        region: val.ASSET_STORE_S3_REGION,
        bucket: val.ASSET_STORE_S3_BUCKET,
        accessKeyId: val.ASSET_STORE_S3_ACCESS_KEY_ID,
        secretAccessKey: val.ASSET_STORE_S3_SECRET_ACCESS_KEY,
        forcePathStyle: val.ASSET_STORE_S3_FORCE_PATH_STYLE,
      },
    },
    prometheus: {
      metricsToken:
        val.PROMETHEUS_AUTH_TOKEN ?? crypto.randomBytes(64).toString("hex"),
    },
    rateLimiting: {
      enabled: val.RATE_LIMITING_ENABLED,
    },
    redis: {
      url: val.REDIS_URL,
    },
    stripe: {
      secretKey: val.STRIPE_SECRET_KEY,
      publishableKey: val.STRIPE_PUBLISHABLE_KEY,
      webhookSecret: val.STRIPE_WEBHOOK_SECRET,
      priceId: val.STRIPE_PRICE_ID,
      yearlyPriceId: val.STRIPE_YEARLY_PRICE_ID,
      isConfigured: !!val.STRIPE_SECRET_KEY && !!val.STRIPE_PUBLISHABLE_KEY,
    },
    quotas: {
      free: {
        bookmarkLimit: val.FREE_QUOTA_BOOKMARK_LIMIT ?? null,
        assetSizeBytes: val.FREE_QUOTA_ASSET_SIZE_BYTES ?? null,
        browserCrawlingEnabled: val.FREE_BROWSER_CRAWLING_ENABLED ?? null,
      },
      paid: {
        bookmarkLimit: val.PAID_QUOTA_BOOKMARK_LIMIT ?? null,
        assetSizeBytes: val.PAID_QUOTA_ASSET_SIZE_BYTES ?? null,
        browserCrawlingEnabled: val.PAID_BROWSER_CRAWLING_ENABLED ?? null,
      },
    },
    database: {
      walMode: val.DB_WAL_MODE,
    },
    tracing: {
      enabled: val.OTEL_TRACING_ENABLED,
      otlpTracesEndpoint: val.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
      serviceName: val.OTEL_SERVICE_NAME,
      sampleRate: val.OTEL_SAMPLE_RATE,
    },
    eventLogs: {
      enabled: val.EVENT_LOGS_ENABLED,
      otlpExport: {
        enabled: val.OTEL_EVENT_LOGS_EXPORT_ENABLED,
        endpoint: val.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT,
      },
    },
  };
  if (obj.auth.emailVerificationRequired && !obj.email.smtp) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "To enable email verification, SMTP settings must be configured",
      fatal: true,
    });
    return z.NEVER;
  }
  if (obj.auth.turnstile.enabled && !obj.auth.turnstile.secretKey) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "TURNSTILE_SECRET_KEY is required when TURNSTILE_SITE_KEY is set",
      fatal: true,
    });
    return z.NEVER;
  }
  if (obj.eventLogs.otlpExport.enabled && !obj.eventLogs.otlpExport.endpoint) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT is required when OTEL_EVENT_LOGS_EXPORT_ENABLED is true",
      fatal: true,
    });
    return z.NEVER;
  }
  return obj;
});

const serverConfig: Readonly<z.infer<typeof serverConfigSchema>> =
  serverConfigSchema.parse(process.env);

// Always explicitly pick up stuff from server config to avoid accidentally leaking stuff
export const clientConfig = {
  publicUrl: serverConfig.publicUrl,
  publicApiUrl: serverConfig.publicApiUrl,
  demoMode: serverConfig.demoMode,
  auth: {
    disableSignups: serverConfig.auth.disableSignups,
    disablePasswordAuth: serverConfig.auth.disablePasswordAuth,
    oauthAutoRedirect: serverConfig.auth.oauth.autoRedirect,
  },
  turnstile:
    serverConfig.auth.turnstile.enabled && serverConfig.auth.turnstile.siteKey
      ? {
          siteKey: serverConfig.auth.turnstile.siteKey,
        }
      : null,
  inference: {
    isConfigured: serverConfig.inference.isConfigured,
    inferredTagLang: serverConfig.inference.inferredTagLang,
    enableAutoTagging: serverConfig.inference.enableAutoTagging,
    enableAutoSummarization: serverConfig.inference.enableAutoSummarization,
  },
  chat: {
    enabled: serverConfig.chat.enabled,
  },
  stripe: {
    isConfigured: serverConfig.stripe.isConfigured,
  },
  legal: {
    termsOfServiceUrl: serverConfig.legal.termsOfServiceUrl,
    privacyPolicyUrl: serverConfig.legal.privacyPolicyUrl,
  },
  serverVersion: serverConfig.serverVersion,
  disableNewReleaseCheck: serverConfig.disableNewReleaseCheck,
};
export type ClientConfig = typeof clientConfig;

export default serverConfig;
