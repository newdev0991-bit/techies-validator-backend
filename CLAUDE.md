# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Node.js Express backend API that validates business leads using OpenAI's Chat Completions API. It serves as the backend for a UK-based B2B lead validation system, determining whether business leads are good prospects based on timing, business type, location, and contact information.

## Commands

### Development
```bash
npm install          # Install dependencies
npm start           # Start the server (production and dev)
npm run dev         # Same as npm start (no hot-reload)
```

The server runs on port 4000 by default (or PORT env variable).

### Testing API Endpoints
```bash
# Health check
curl http://localhost:4000/health

# Analyze single lead
curl -X POST http://localhost:4000/analyze \
  -H "Content-Type: application/json" \
  -d '{"lead": {"Company Name": "Test Ltd", "Industry Type": "Restaurant", ...}}'

# Same endpoint is also available at /validate
curl -X POST http://localhost:4000/validate \
  -H "Content-Type: application/json" \
  -d '{"lead": {...}}'

# Fetch Facebook post date from Lead Proof URL
curl -X POST http://localhost:4000/fetch-results \
  -H "Content-Type: application/json" \
  -d '{"lead": {"Company Name": "Cub Cafe Wigan", "Lead Proof URL": "https://www.facebook.com/permalink.php?story_fbid=..."}}'
```

## Architecture

### Single-File Express API ([server.js](server.js))

The entire backend is contained in a single ESM module (`server.js`). This is intentional for simplicity and ease of deployment.

**Key components:**

1. **CORS Configuration** ([server.js:9-24](server.js#L9-L24))
   - Allowlist-based origin validation
   - Configured via `ALLOWED_ORIGINS` or `FRONTEND_ORIGIN` env vars
   - Always allows localhost:3000 for local development
   - Rejects requests from non-allowlisted origins

2. **Lead Validation Prompt** ([server.js:29-80](server.js#L29-L80))
   - `buildPrompt()` constructs the OpenAI prompt from lead data
   - Maps CSV-style lead fields (e.g., "Company Name", "Post Code (Please Put The Full Postcode, Example: CH41 5LH)")
   - Enforces strict UK B2B validation rules:
     - GOOD: New businesses, relocations, expansions, ownership changes
     - BAD: Education sector, established businesses, non-UK locations (Ireland, Northern Ireland, Isle of Man, etc.)
   - Returns structured JSON with verdict, reasoning, confidence score, and recommendations

3. **Analysis Handler** ([server.js:82-131](server.js#L82-L131))
   - Single handler serves both `/analyze` and `/validate` endpoints
   - Uses OpenAI's JSON mode (`response_format: { type: 'json_object' }`)
   - System message enforces lowercase "json" keyword to satisfy JSON mode policy
   - Returns response in format: `{ content: [{ text: "<json_string>" }] }` for frontend compatibility

4. **Apify Integration** ([server.js:137-225](server.js#L137-L225))
   - `/fetch-results` endpoint scrapes Facebook post dates via Apify
   - Accepts full lead object and extracts `lead['Lead Proof URL']`
   - Uses actor ID: `cE441Keduu5udSFbY` (slim_sky/facebook-post-date-scraper---development)
   - Requires Facebook authentication cookies passed as JSON array in environment
   - Cookie format: JSON array of objects with fields like `domain`, `name`, `value`, `secure`, `httpOnly`, etc.
   - Server parses and validates the JSON format before passing to Apify
   - Waits for actor completion synchronously using `.call()`
   - Returns post date, text, and previous posts from the Facebook page
   - Comprehensive error logging with `[fetch-results]` prefix

5. **Environment Configuration**
   - `OPENAI_API_KEY` - Required for OpenAI API access
   - `ALLOWED_ORIGINS` - Comma-separated list of allowed frontend origins
   - `MODEL` - Defaults to 'gpt-4o-mini'
   - `PORT` - Server port (default: 4000, Render uses 10000)
   - `APIFY_API_TOKEN` - Required for Apify actor execution
   - `FACEBOOK_COOKIES` - JSON array string of Facebook cookies for authentication. Format: `[{"domain":".facebook.com","name":"c_user","value":"123456","secure":true,"httpOnly":false},...]`
   - `MAX_CONCURRENCY` and `PER_REQUEST_DELAY_MS` - Documented but not yet implemented
   - `DEBUG` - Reserved for future use

### Lead Data Structure

Leads use verbose CSV-style field names from a spreadsheet import system:
- `"Company Name"`
- `"Industry Type"`
- `"Phone Number"`
- `"Address 1 (Road/Street/Lane/Park/Industrial Estate)"`
- `"Address 2 (Village/Town/City)"`
- `"Post Code (Please Put The Full Postcode, Example: CH41 5LH)"`
- `"County"`
- `"Lead Statement"`
- `"Lead Proof URL"`
- `"Old Address? (For relocation, new branch, and moving premises only with no given address)"`

When modifying prompt or validation logic, maintain these exact field names as they match the frontend's data format.

### Deployment

Designed for Render deployment:
- Set `PORT=10000` (Render's default)
- Configure all environment variables in Render dashboard
- No build step required - runs directly with `node server.js`
- Frontend typically deployed on Vercel (add to ALLOWED_ORIGINS)
