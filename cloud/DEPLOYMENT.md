# Cloud deployment checkpoint - 2026-08-31

- Controller Actor: `2bqj6wjKHvCUw4tkd`, `jzsedillo03/techies-cot-cloud-pipeline`.
  Private, Limited permissions, Git source is repository root on
  `codex/apify-cot-cloud-pipeline`. 512 MB, timeout 900 seconds, restart off.
- Named state store: `4czysq5SoYvjeJ4m6`, `techies-cot-pipeline-state`.
- Dedicated lock queue: `RPIXcSuQMaZEkFOIj`, `techies-cot-pipeline-lock`.
- Schedule: `C5tvDL78uLqJogZ77`, every minute UTC, exclusive, disabled.
  Its single controller action was saved and read back with latest build,
  512 MB, 900 seconds, and a $0.10 run cap. Saved input:
  `{ "enabled": true, "stateStoreId": "4czysq5SoYvjeJ4m6", "lockQueueId": "RPIXcSuQMaZEkFOIj" }`.
- Four nonsecret Actor environment settings are saved: state ID, queue ID,
  validator base URL, and `PIPELINE_LIVE_ENABLED=false`. Build-time environment
  injection is off. The matching backend `COT_PIPELINE_API_KEY` is saved as a
  secret. Its read-only backend capability check succeeded without validation.
- The original canary SQLite file was read-only. Eight records were uploaded
  with STATE last, and all eight JSON values were independently read back and
  matched to the migration bundle. No duplicate search or validation was run.
  Preserved: 3 leads, 1 search, 1 validation, 0 ready, 2 review, 1 rejected.
  Snapshot hash: `640e9aae0d3ea9968b2990a0010d551a3268014c0b6cc3e70ef118cd83f7c8bd`.
- Controller build `0.0.2` (`oyexRx247f0kkL1WS`) succeeded. Cloned branch:
  `codex/apify-cot-cloud-pipeline`; cloned commit:
  `e79c0c9391a990a42e247b9a35508b7ee55b44e3`. Console build cost rounded to
  $0.001. Earlier build `0.0.1` cost $0.002 and passed all ten cloud tests;
  build 0.0.2 reused those identical Docker layers after the secret update.
- Exactly one status-only run, `xylnDouTmwgpwNokh`, succeeded with limited
  permissions, enabled=false, 512 MB, 180-second timeout, restart off, and a
  $0.10 cap. Duration 3.923 seconds; Console cost rounded to $0.000.
  OUTPUT.status=disabled; 0 ready, 2 review, 1 rejected, 0 pending.
  STATE advanced only its metadata chunk for lastTick. Lead, run-history,
  and daily-counter chunk hashes remain identical to the verified migration.
  No new search or validation ran; the existing lifetime limits remain consumed.
- Frontend commit `b7d6c4dd98b0ec68e81aeefe961acb28f0480e22` is READY as a
  Vercel preview: https://techies-validator-frontend-2026-ghmkmuai7.vercel.app
  Deployment: `dpl_ApH6P9s17StTTNCNniyyQPqvBAU3`. The three server-only dashboard
  variables are scoped only to Preview branch `codex/apify-cot-cloud-results`.
  The new read token grants only Read on the dedicated store, no account-wide
  permissions, no run-storage permissions, and no permission to run Actors.
  Password unlock, all three saved rows, Review filtering, and refresh were
  verified in the deployed browser UI. CSV upload is not required.
- The generated dashboard password is in the ignored local file
  `pipeline/data/dashboard-password`; never commit or print its contents.
- Security limitation: Apify's existing account configuration allows anonymous
  storage reads by ID. The dashboard password does not protect direct storage
  URLs under that account setting. No account-wide access setting was changed.
  Review impact on existing consumers before changing General resource access
  to Restricted. No credentials are stored in the cloud state or this document.
- Recurring activation and new paid search/validation remain unapproved.
  Live validation of the newer backend identity/contact fixes remains separate;
  this disabled controller test does not prove those fixes are deployed.
  Main branches and production frontend were not changed.

Do not reset STATE or counters, enable the schedule, or change main to resume.
The verified runtime build predates this documentation-only checkpoint commit.
Recheck source code changes and approval limits before a future live canary.

## Source-page repair follow-up - 2026-08-31

The schedule was subsequently enabled outside the preceding deployment work
and changed to every five minutes. Observed scheduler runs at 09:28, 09:30, and
09:35 Manila time completed without processing; RESULTS still reported disabled,
1 historical search and 1 historical validation. Both CONFIG.enabled and the
Actor's PIPELINE_LIVE_ENABLED remained false, despite Allow processing being on.
The schedule was paused during diagnosis; its five-minute interval is retained.

The source repair adds a terminal Console status message naming the disabled
gates, an HTML output report with cumulative counts and lifetime allowances,
and an explicit output schema plus controller-specific README. It preserves
all three gates, spending limits, and state history. This repair needs a new
approved Actor build before it is live; build 0.0.2 remains the tested runtime.
