# Whiteboard (barebone)

Real-time sync with **server-authoritative ordering** and **optimistic UI**. Auth via **Google Sign-In** only.

## Setup

1. Create [Google OAuth 2.0 credentials](https://console.cloud.google.com/apis/credentials) (Web application).
2. Add **Authorized redirect URIs** (APIs & Services → Credentials → your OAuth client → Authorized redirect URIs):
   - Local: `http://localhost:3000/api/auth/google/callback`
   - Production: `https://your-production-domain.com/api/auth/google/callback` (exact URL, no trailing slash)
3. Copy `.env.example` to `.env` and set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

## Run

```bash
npm install
npm start
```

Open http://localhost:3000, sign in with Google, then open two (or more) browser windows/tabs to draw. Strokes sync in server order; your own strokes show immediately (optimistic), then get a sequence number from the server and stay in sync with others.

## Deploy to Render

You **don’t** upload a `.env` file. Set everything in the Render dashboard.

1. **Create a Web Service** (connect this repo). Build: `npm install`. Start: `npm start`.
2. **Create a PostgreSQL** instance in the same Render project. In the Web Service → **Environment**, add:
   - **DATABASE_URL** — copy from the Postgres service (Internal Database URL).
   - **GOOGLE_CLIENT_ID** / **GOOGLE_CLIENT_SECRET** — same values you use locally.
   - **BASE_URL** — optional. Your app URL, e.g. `https://your-app-name.onrender.com` (no trailing slash). If unset, the app derives it from the request; set it if you get "This app's request is invalid".
   - **OPENAI_API_KEY** — optional; only if you use AI commands.
3. **Google Cloud Console**: In your OAuth 2.0 client, add an **Authorized redirect URI**:  
   `https://your-app-name.onrender.com/api/auth/google/callback`  
   (replace with your real Render URL.)

After deploy, the app will create the DB tables on first run. Sessions and board state persist across restarts.

### Redis (optional, for multiple instances)

To run more than one Web Service instance (or avoid in-memory session cache being lost on deploy), add a **Key Value** (Redis-compatible) instance:

1. In the Render Dashboard go to **New → Key Value** (or [dashboard.render.com/new/redis](https://dashboard.render.com/new/redis)).
2. Name it (e.g. `whiteboard-cache`), choose the **same region** as your Web Service, then **Create Key Value**.
3. Open your Web Service → **Environment**. From the Key Value instance’s **Connect** menu copy the **Internal Connection URL** and add it as:
   - **REDIS_URL** = that URL (e.g. `redis://red-xxx:6379`).
4. Redeploy the Web Service.

The app uses Redis for the session cache when `REDIS_URL` is set, and falls back to in-memory when it is not. No Redis is required for a single instance.

## Troubleshooting: "Access blocked: This app's request is invalid"

This usually means the **redirect URI** Google received doesn’t match your **Authorized redirect URIs** in Google Cloud Console.

1. **Add the exact redirect URI in Google Console**  
   APIs & Services → Credentials → your OAuth 2.0 Client ID → **Authorized redirect URIs**.  
   Add: `https://<your-live-host>/api/auth/google/callback` (same protocol, host, and path as your app; no trailing slash).

2. **Force a known URL with BASE_URL**  
   If your host sends an unexpected Host/Proto, set **BASE_URL** in your environment to your real app URL (e.g. `https://your-app.onrender.com`). The redirect URI will then be `BASE_URL` + `/api/auth/google/callback`. Add that exact string in Google Console.

3. **App in Testing mode**  
   If the OAuth consent screen is in "Testing", add your Google account under **Test users** so you can sign in.

## How it works

- **Server**: Assigns a sequence number to each stroke and broadcasts `STROKE_ADDED` to all clients. New clients get full `STATE` on connect.
- **Client**: Draws your stroke locally (pending) and sends `ADD_STROKE`. When the server echoes it back with a `seq`, the stroke moves from pending to the ordered list. Other clients only apply server messages, so everyone sees the same order.
