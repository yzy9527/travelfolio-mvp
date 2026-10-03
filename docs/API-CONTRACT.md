# Travelfolio API contract (v1)

All API routes prefix `/api`. Same-origin browser requests: HttpOnly `tf_session` cookie; fetch with credentials. `GET /auth/me` returns `{user,csrfToken}`; `POST /auth/login` and `/auth/register` return same. All other writes require `X-CSRF-Token`. Login/register require exact Origin configured APP_ORIGIN. JSON errors `{error:{code,message}}`; status 400/401/403/404/409/429/502.

Auth: POST /auth/login `{email,password}`; POST /auth/register `{email,password,inviteCode}`; POST /auth/logout. User `{id,email,role:'admin'|'user'}`. Invite-only registration. No demo password.

GET /settings -> `{provider:'openai'|'deepseek'|'custom',baseUrl,model,hasApiKey,searchAvailable,demoEnabled}`. PUT /settings `{provider,baseUrl?,model,apiKey?}`. Empty/omitted key preserves ONLY for unchanged provider/base URL; DELETE /settings/key erases. Never returns key. Explicitly advise destination provider receives trip information. Supported bases HTTPS public addresses only. Demo may run with no settings if deployment enables it.

GET /trips -> `{trips: [{id,title,constraints,currentVersionId,revision,createdAt,updatedAt}]}`
POST /trips `{title?,destination,departure,startDate,endDate,people,budget,currency,preferences,exclusions}` -> `{trip}`
Trip constraints: destination and departure strings; dates ISO YYYY-MM-DD inclusive (1–14 days); people 1–20; budget positive total whole party; currency 3 uppercase letters; preferences and exclusions strings.
GET /trips/:id -> `{trip,versions,jobs}`. Version `{id,number,status:'candidate'|'adopted'|'discarded',baseVersionId,createdAt,request,content}`. Trip.currentVersionId points at adopted version, not automatically changed by generation.
POST /trips/:id/jobs `{request,mode:'live'|'demo',idempotencyKey}` -> `{job}`. request may empty for first generation; regenerate requires adopted current version and new request. mode live calls user's configured LLM; search server optional. No external call before click. Key UUID generated client once per submitted intention. Pending/running repeated click returns same active job. Job `{id,tripId,status:'queued'|'running'|'succeeded'|'failed'|'cancelled',mode,request,versionId,errorCode,errorMessage,createdAt,updatedAt}`.
GET /jobs/:id -> `{job}` poll every 2s; POST /jobs/:id/cancel -> `{job}`. Queued/running can cancel; running provider spend may already occur. Failed job retry is a new POST jobs with fresh idempotencyKey (do not auto retry paid requests).
POST /trips/:id/versions/:vid/adopt `{expectedRevision}` -> `{trip}`. CAS conflicts return 409; refreshing required. Works for candidate and old adopted version (rollback). POST .../:vid/discard `{}` -> `{version}` only candidate. Old/current retained.
GET /trips/:id/export?format=json|html&versionId=... downloads sanitized selected or current version plus constraints, no settings, key, prompt, user data. HTML is self-contained, no scripts, map links; print to PDF optional.

Content schema:
```
{title,summary,days:[{date,title,summary,activities:[{time,title,description,location,transport,estimatedCost,bookingNote,sourceIds:[]}]}],budget:[{category,amount,note}],packing:[],notes:[],sources:[{id,title,url,retrievedAt}],verification:{mode:'not_live_verified'|'live_search'|'demo',notice,researchedAt:null|string}}
```
All rendered text escaped (Vue default). URLs only HTTP(S). Map links built client with encodeURIComponent. Live_search means web results retrieved, NEVER inventory/weather/tickets confirmed. Cite sources via sourceIds, labels say search evidence, verify critical items manually.

Admin GET /admin/users -> `{users:[{id,email,role,status:'active'|'disabled',createdAt}]}`; PATCH /admin/users/:id `{status}`; no self-disable. POST /admin/invites `{}` -> `{inviteCode,expiresAt}` only display once. GET /admin/overview -> `{counts:{users,trips,queued,running,failed},failures:[{id,userId,errorCode,createdAt}]}` no trip text, keys or raw errors. Admin normal routes owner-only, not broad trip access.


## v2 Skill pipeline (additive)

New jobs use schema v2. `POST /trips/:id/jobs` queues only `outline`. Status additionally includes `awaiting_outline`; stage is outline/research/assets/maps/compile/validate/candidate. Returned job includes outline, outlineHash, outlineVersion, completed checkpoint summaries, recoveryRequired and possibleCharge. No source packs, credentials, operation responses or work-directory paths are exposed in a job view.

`POST /jobs/:id/approve-outline {outlineHash,outlineVersion}` binds approval to the outline, exact constraints, request, base version and version number. A changed outline or current version returns 409. Successful duplicate approval is idempotent. Live research needs the server search capability. Waiting for outline approval creates no research calls.

`POST /jobs/:id/resume {acknowledgePossibleCharge:boolean}` resumes a failed v2 job only. Completed operation results/packs are reused. Ambiguous network calls require true after checking provider billing; calls are not promised exactly-once by upstream. A new attempt has distinct HTTP idempotency identity, and immutable ledger rows fence stale workers. Cancelled jobs remain cancelled; create a new intention instead.

`POST /trips/:id/versions/:vid/review {artifactHash,checks:{desktop:true,mobile:true,content:true,maps:true},note}` persists a human report (note 10–2000 characters) bound to exact artifact bytes. It does not adopt, manufacture source truth, or convert guide QA statuses. `adopt` additionally requires this review for v2 candidates. Old adopted v1 versions remain rollback-compatible.

`GET /trips/:id/versions/:vid/artifact` returns authenticated download-only UTF-8 HTML and X-Artifact-Sha256. v2 `export?format=html` returns those exact stored bytes. v1 export remains legacy HTML. The frontend verifies bytes with SHA-256 before showing an iframe sandbox with allow-scripts only, no same-origin permission. The document contains a CSP permitting only its fixed trusted script hash; model strings are data, never executable DOM.

Version views append schemaVersion, guide, artifactHash, qaStatus, review; content remains a compatible itinerary projection. Guide contains full 8-module profile, source provenance, image/map receipts and separate automatic/pending/fixture QA. Fixtures always have handoffAllowed=false. Network and model research evidence is never implied by fixture/test status.

The v1 text above describes legacy records; live v2 search is required, full generation is gated by outline approval, and v2 HTML contains a reviewed fixed script runtime rather than legacy no-script rendering.

`POST /trips/:id/versions/:vid/review-assets` accepts `{artifactHash,idempotencyKey,coverAssetId?,reviews:[{assetId,sha256,sourcePage,identity:true,visual:true,watermark:true,note}]}` for an unadopted, current-base candidate. These are actual human reports, never preset checkboxes. Each raster hash, source page and identity must match stored decoded bytes. Selecting a cover requires a reviewed place-image receipt. The endpoint creates a new compile-only job using the already approved outline/packs, preserving the original candidate bytes. It makes no paid call; the new artifact receives fresh browser/export QA and requires its own general review/adoption. Duplicate requests compare canonical content hashes; changing version, cover or reviews with the same key returns 409.

v2 candidate adoption with incomplete `guide.qa.handoffAllowed` requires `{expectedRevision,acknowledgePartial:true}`. The stored guide gates remain pending/fixture. This is explicit preview adoption, not original Skill full handoff. Media review authority is invalidated when its owning research pack changes, even if identical downloaded bytes can be reused.
