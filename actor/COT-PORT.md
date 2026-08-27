# COT HTTP engine

Baseline: zachary3111/Techies-fbscraper, branch codex/fix-unavailable-page-classification,
commit 9b5dd4bf3a764717b0f21153919cd256f9f7441d.

This directory is the deployable COT Actor. It uses the reference logged-out HTTP
transport without supplied Facebook account cookies or Puppeteer/OCR.
Anonymous visitor state returned by public HTTP responses is not an account login.

COT adaptation: cotProof.js emits cot-data-batch-v1 with target-post provenance.
Only an exact object-ID match with a consistent story-scoped server timestamp is
trusted. Page activity, missing targets, unresolved share links, and conflicting
timestamps never substitute for the submitted proof. The backend retains the
24-hour deterministic freshness and AI review rules. A target outside the bounded
public timeline sample remains review-only; private/login-only content is not accessed.

Build context: actor/ within the backend repository. Run npm test here; the image
build also runs tests and a syntax check. The old workspace-level actor/ directory
is a legacy backup and is not the deployment source.
