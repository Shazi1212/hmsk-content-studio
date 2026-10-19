/**
 * Client-side view of the HTTP API (app/api/**).
 * Shared domain types (Brief, GenerationOutput, option catalog) come from @/lib/types;
 * everything here mirrors the server contracts structurally so the UI does not import server modules.
 */
import type { Brief, GenerationOutput, OPTION_GROUPS, TextProviderId } from "@/lib/types";

export type ProviderStatus = {
  text: Record<TextProviderId, { configured: boolean; model?: string; note?: string }>;
  audio: { elevenlabs: { configured: boolean; voiceId?: string } };
  video: { higgsfield: { configured: boolean } };
  image: { configured: boolean; provider?: "openai" | "gemini"; model?: string; note?: string };
  /** The Ideas tab's model; absent on older servers. */
  ideas?: { configured: boolean; model?: string; models: string[]; note?: string };
  /** Hosting of generated media by the app itself; absent or false = images/audio are download-only. */
  storage?: { media: { configured: boolean } };
};

/** Media bytes from /api/audio or /api/image plus the public URL when the server hosted them (X-Asset-Url) and the provider that made them (X-Provider). */
export type MediaResult = { blob: Blob; url: string | null; provider: string | null; references: number | null; productReferences: number | null };

export type BrandOption = {
  id?: string;
  slug: string;
  name: string;
  tagline?: string | null;
  pillars: string[];
  platforms: string[];
  languages: string[];
  audienceSuggestions: string[];
  /** Default product / packaging photos the server sends to the image model for this brand; 0 or absent = none (older servers). */
  productReferenceCount?: number;
  /** Language safety settings of the brand (absent on older servers). */
  bannedPhrases?: string[];
  aiPhraseCheck?: boolean;
  /** Evergreen refresh window in days (0 = off; absent on older servers). */
  refreshAfterDays?: number;
};

export type Voice = { voiceId: string; name: string };

export type OptionsResponse = {
  brands: BrandOption[];
  options: typeof OPTION_GROUPS;
  providers: ProviderStatus;
  elevenlabsVoices?: Voice[];
};

/** Generation row minus id/timestamps: what POST /api/generate returns and POST /api/generations accepts. */
export type DraftGeneration = {
  brandId: string;
  platform: string;
  postType: string;
  status: string;
  brief: Brief;
  systemPrompt: string;
  userPrompt: string;
  provider: string;
  model?: string | null;
  output: GenerationOutput;
  outputText: string;
  referenceIds: string[];
  priorGenIds: string[];
  audioUrl?: string | null;
  audioProvider?: string | null;
  videoUrl?: string | null;
  videoProvider?: string | null;
  imageUrl?: string | null;
  /** Hosted slide images in slide order (carousel, document, story); imageUrl is the first. */
  imageUrls?: string[] | null;
  imageProvider?: string | null;
  score?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  notes?: string | null;
  approvedAt?: string | null;
};

/** Token usage of one run, summed over the first attempt and any retry (null = not reported by the provider). */
export type RunUsage = { inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null };

/** A connected social account as returned by GET /api/connections (never contains tokens). */
export type ConnectionRow = {
  id: string;
  platform: string;
  externalId: string;
  handle: string | null;
  /** ok | needs_reconnect | error */
  status: string;
  expiresAt: string | null;
  scopes: string[];
  lastSyncAt: string | null;
  lastSyncCount: number | null;
  lastError: string | null;
  createdAt: string;
  brandSlug: string;
  brandName: string;
};

export type ConnectorInfo = { platform: string; label: string; configured: boolean; missingEnv: string[]; redirectUri: string };

export type ConnectionsResponse = { connections: ConnectionRow[]; connectors: ConnectorInfo[]; platforms: string[] };

export type SyncReportRow = {
  connectionId: string;
  brandSlug: string;
  platform: string;
  handle: string | null;
  ok: boolean;
  fetched: number;
  created: number;
  updated: number;
  warnings: string[];
  error?: string;
  reconnect?: boolean;
};

export type PerformanceBucket = "exceptional" | "high" | "typical" | "mixed" | "low" | "unknown";

/** One researched post as returned by GET /api/references: the data the strategist learns from. */
export type ReferenceRow = {
  id: string;
  brandSlug: string;
  brandName: string;
  /** Normalised channel: instagram | tiktok | linkedin | linkedin-company | linkedin-showcase | linkedin-founder | linkedin-personal. */
  platform: string;
  postUrl: string;
  date: string | null;
  format: string | null;
  pillar: string | null;
  topic: string | null;
  product: string | null;
  hook: string | null;
  hookType: string | null;
  mainMessage: string | null;
  visualConcept: string | null;
  visualStyle: string | null;
  colors: string | null;
  typography: string | null;
  people: string | null;
  productPlacement: string | null;
  captionStyle: string | null;
  captionStructure: string | null;
  cta: string | null;
  ctaType: string | null;
  views: string | null;
  likes: string | null;
  comments: string | null;
  shares: string | null;
  saves: string | null;
  engagementIndicators: string | null;
  /** The research label as written ("High (views) / Low (interaction)"); `bucket` is its normalised form. */
  performanceLevel: string | null;
  bucket: PerformanceBucket;
  performanceEvidence: string | null;
  audienceReaction: string | null;
  trendReference: string | null;
  storytelling: string | null;
  emotionalDriver: string | null;
  contentMechanism: string | null;
  replicability: string | null;
  observations: string | null;
  confidence: string | null;
  sourceEvidence: string | null;
  /** Dataset origin, e.g. "seed", "import" or "approved-generation". */
  source: string;
};

export type ReferenceSummary = {
  id: string;
  platform: string;
  hook?: string | null;
  performanceLevel?: string | null;
  postUrl?: string | null;
  pillar?: string | null;
};

export type PriorSummary = { id: string; createdAt: string; hook?: string | null };

/** hints: evergreen-refresh notes (absent on older results). */
export type Repetition = { warnings: string[]; maxSimilarity: number; hints?: string[] };

export type GenerateResponse = {
  draft: DraftGeneration;
  /** Absent on results reopened from history; the draft carries the same counts. */
  usage?: RunUsage;
  /** Wall-clock time of the generation in milliseconds (fresh results only). */
  durationMs?: number;
  references: ReferenceSummary[];
  priorApproved: PriorSummary[];
  repetition: Repetition;
  retrievalNotes?: string[];
  /** Parser lint codes (compliance + format), non-blocking; `health_claim_term:` / `forbidden_string:` gate approval. */
  lint?: string[];
  /** Language safety warnings (lib/language-safety.ts): mixed language, banned and AI-sounding phrases, hashtag and emoji limits. Never block. */
  safety?: string[];
  /** JSON repairs the parser applied. */
  repaired?: string[];
  /** Pipeline notices such as truncated output or a retry. */
  warnings?: string[];
  raw?: string;
};

export type GenerationStatus = "draft" | "approved" | "rejected";

/** Row as returned by GET /api/generations (minimal fields + output) and POST /api/generations. */
export type HistoryItem = {
  id: string;
  brandId?: string;
  brandSlug?: string;
  brand?: { slug: string; name: string } | null;
  platform: string;
  postType: string;
  status: string;
  createdAt: string;
  updatedAt?: string;
  approvedAt?: string | null;
  score?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  notes?: string | null;
  provider?: string;
  model?: string | null;
  output: GenerationOutput;
  outputText?: string;
  brief?: Brief | null;
  systemPrompt?: string;
  userPrompt?: string;
  referenceIds?: string[];
  priorGenIds?: string[];
  audioUrl?: string | null;
  videoUrl?: string | null;
  imageUrl?: string | null;
  imageUrls?: string[] | null;
};

export type VideoJobStatus = {
  status: "queued" | "processing" | "completed" | "failed";
  url?: string;
  error?: string;
};

/** Frame for generated media. The video model renders 9:16, 1:1 and 16:9 only; images also take the Instagram feed's 4:5. */
export type AspectRatio = "9:16" | "4:5" | "1:1" | "16:9";
export type VideoAspectRatio = Exclude<AspectRatio, "4:5">;

export type ToastKind = "success" | "error" | "info";
export type ToastMessage = { id: number; kind: ToastKind; text: string };

export type BusyAction = "approve" | "draft" | "reject";

/** Top-level tabs of the studio: the brief form + result, brainstormed ideas, the brand's reference photos, or the browsable research data. */
export type StudioView = "create" | "ideas" | "brands" | "assets" | "research";

/** What a brand reference photo shows; the server orders the default selection by kind. */
export type AssetKind = "product" | "packaging" | "logo" | "person" | "mood" | "other";

/** "upload" = added here; "website" = imported from the brand's site (behaves like any other asset). */
export type AssetSource = "upload" | "website";

/** One reference photo of a brand as returned by /api/brands/{slug}/assets. */
export type BrandAsset = {
  id: string;
  kind: AssetKind;
  label: string;
  /** Default photos are sent to the image model for every key visual, slide and video start frame unless a post picks others. */
  isDefault: boolean;
  position: number;
  /** Public image URL. */
  url: string;
  mime: string;
  size: number;
  source: AssetSource;
  createdAt: string;
};

export type AssetPatch = { kind?: AssetKind; label?: string; isDefault?: boolean; position?: number };

/** Editable brand fields (Brands tab, POST/PUT /api/brands). */
export type BrandInput = {
  name: string;
  tagline: string;
  websiteUrl: string;
  description: string;
  audience: string;
  voice: string;
  visual: string;
  offers: string;
  guardrails: string;
  categoryRules: string;
  languages: string[];
  platforms: string[];
  pillars: string[];
  forbiddenTerms: string[];
  claimTerms: string[];
  claimSensitive: boolean;
  complianceReview: boolean;
  bannedPhrases: string[];
  aiPhraseCheck: boolean;
  refreshAfterDays: number;
};

/** A brand as GET /api/brands returns it. */
export type BrandRecord = Omit<BrandInput, "tagline" | "websiteUrl"> & {
  id: string;
  slug: string;
  tagline: string | null;
  websiteUrl: string | null;
  createdAt: string;
  updatedAt: string;
};
