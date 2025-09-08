# Techies Validator Backend (OpenAI + Express)

Secure backend for lead validation using OpenAI Chat Completions.

## Deploy on Render

1) Create a new **Web Service** from this folder/repo.
2) Environment:
   - `PORT=10000` (Render default for Node is auto; we also set a default in code)
   - `OPENAI_API_KEY=sk-...`
   - `ALLOWED_ORIGINS=https://your-frontend.vercel.app,http://localhost:3000`
   - `MODEL=gpt-4o-mini` (or any chat-capable model in your account)
   - `MAX_CONCURRENCY=2`
   - `PER_REQUEST_DELAY_MS=1200`
   - `DEBUG=false`
3) Build & Start Command: Render will install and run `npm start` by default.

## Endpoints

- `GET /health` → `{ ok: true, model }`
- `POST /test-openai` → `{ ok: true }` if your API key works.
- `POST /analyze` → body: `{ lead: {...} }` returns validation JSON.
- `POST /analyze-batch` → body: `{ leads: [ {...}, ... ] }` returns batch results.

