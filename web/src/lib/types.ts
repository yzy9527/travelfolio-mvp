export type User = { id: string; email: string; role: 'admin' | 'user' }
export type Constraints = { destination: string; departure: string; startDate: string; endDate: string; people: number; budget: number; currency: string; preferences: string; exclusions: string }
export type Trip = { id: string; title: string; constraints: Constraints; currentVersionId: string | null; revision: number; createdAt: string; updatedAt: string }
export type Source = { id: string; title: string; url: string; retrievedAt: string }
export type Activity = { time: string; title: string; description: string; location: string; transport: string; estimatedCost: number; bookingNote: string; sourceIds: string[] }
export type Content = { title: string; summary: string; days: { date: string; title: string; summary: string; activities: Activity[] }[]; budget: { category: string; amount: number; note: string }[]; packing: string[]; notes: string[]; sources: Source[]; verification: { mode: 'not_live_verified' | 'live_search' | 'demo'; notice: string; researchedAt: string | null } }
export type Outline = { title: string; summary: string; days: { date: string; title: string; focus: string; pace: string; areas: string[] }[]; assumptions: string[]; openQuestions: string[]; changedPacks: string[] }
export type ReviewChecks = { desktop: boolean; mobile: boolean; content: boolean; maps: boolean }
export type ArtifactReview = { artifactHash: string; checks: ReviewChecks; note: string; reviewedAt: string; acceptance?: 'preview_only' | 'handoff' }
export type CompiledGuide = { profile: Record<string, unknown>; provenance: Record<string, unknown>; qa: Record<string, unknown>; assets: Record<string, unknown>[]; sources: Record<string, unknown>[] }
export type Version = { id: string; number: number; status: 'candidate' | 'adopted' | 'discarded'; baseVersionId: string | null; createdAt: string; request: string; content: Content; schemaVersion?: 1 | 2; artifactHash?: string | null; qaStatus?: 'pending' | 'passed' | null; review?: ArtifactReview | null; guide?: CompiledGuide | null }
export type Job = { id: string; tripId: string; status: 'queued' | 'running' | 'awaiting_outline' | 'succeeded' | 'failed' | 'cancelled'; mode: 'live' | 'demo'; request: string; versionId: string | null; errorCode: string | null; errorMessage: string | null; createdAt: string; updatedAt: string; stage?: 'outline' | 'research' | 'assets' | 'maps' | 'compile' | 'validate' | 'candidate'; outline?: Outline | null; outlineHash?: string | null; outlineVersion?: number; checkpoints?: {stage: string; status: 'complete'; updatedAt: string}[]; recoveryRequired?: boolean; possibleCharge?: boolean }
export type TripDetail = { trip: Trip; versions: Version[]; jobs: Job[] }
export type Settings = { provider: 'openai' | 'deepseek' | 'custom'; baseUrl: string; model: string; hasApiKey: boolean; searchAvailable: boolean; demoEnabled: boolean }
export type AdminUser = User & { status: 'active' | 'disabled'; createdAt: string }
export type AdminOverview = { counts: { users: number; trips: number; queued: number; running: number; failed: number }; failures: { id: string; userId: string; errorCode: string; createdAt: string }[] }

