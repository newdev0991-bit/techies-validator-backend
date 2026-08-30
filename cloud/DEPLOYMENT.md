# Cloud preparation checkpoint - 2026-08-31

- Controller Actor: `2bqj6wjKHvCUw4tkd`, `jzsedillo03/techies-cot-cloud-pipeline`.
  Private, Limited permissions, Git source is repository root on
  `codex/apify-cot-cloud-pipeline`. 512 MB, timeout 900 seconds, restart off.
- Named state store: `4czysq5SoYvjeJ4m6`, `techies-cot-pipeline-state`.
- Dedicated lock queue: `RPIXcSuQMaZEkFOIj`, `techies-cot-pipeline-lock`.
- Schedule: `C5tvDL78uLqJogZ77`, every minute UTC, exclusive, disabled.
  Apify Console refuses to attach the controller until its first build exists.
  The schedule currently has no actions; attach only this Actor after building:
  `{ "enabled": true, "stateStoreId": "4czysq5SoYvjeJ4m6", "lockQueueId": "RPIXcSuQMaZEkFOIj" }`.
- Four nonsecret Actor environment settings are saved: state ID, queue ID,
  validator base URL, and `PIPELINE_LIVE_ENABLED=false`. Build-time environment
  injection is off. The matching backend `COT_PIPELINE_API_KEY` is not yet set.
- The original canary SQLite file was read-only. Eight records were uploaded
  with STATE last, and all eight JSON values were independently read back and
  matched to the migration bundle. No duplicate search or validation was run.
  Preserved: 3 leads, 1 search, 1 validation, 0 ready, 2 review, 1 rejected.
  Snapshot hash: `640e9aae0d3ea9968b2990a0010d551a3268014c0b6cc3e70ef118cd83f7c8bd`.
- Frontend commit `b7d6c4dd98b0ec68e81aeefe961acb28f0480e22` is READY as a
  Vercel preview: https://techies-validator-frontend-2026-hl1wsvhcj.vercel.app
  It still needs its server-only storage ID/read credential configured.
- No controller build or run has occurred yet. No recurring activation or
  new paid search/validation has been authorized. Next: secure credential setup,
  one reviewed build and one disabled-input status test, then verify the source
  commit, schedule input, frontend read, and only later approve a live canary.

Do not reset STATE or counters, enable the schedule, or change main to resume.
The build's cloned commit must be checked against the current feature-branch
commit, not against this documentation checkpoint's earlier hashes.
