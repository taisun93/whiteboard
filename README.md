# Whiteboard (barebone)

Real-time sync with **server-authoritative ordering** and **optimistic UI**. Auth via **Google Sign-In** only.

## Setup

1. Create [Google OAuth 2.0 credentials](https://console.cloud.google.com/apis/credentials) (Web application).
2. Add authorized redirect URI: `http://localhost:3000/api/auth/google/callback` (use your production URL in prod).
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
   - **BASE_URL** — your app URL, e.g. `https://your-app-name.onrender.com` (no trailing slash). Required so Google redirects back to the right host.
   - **OPENAI_API_KEY** — optional; only if you use AI commands.
3. **Google Cloud Console**: In your OAuth 2.0 client, add an **Authorized redirect URI**:  
   `https://your-app-name.onrender.com/api/auth/google/callback`  
   (replace with your real Render URL.)

After deploy, the app will create the DB tables on first run. Sessions and board state persist across restarts.

## How it works

- **Server**: Assigns a sequence number to each stroke and broadcasts `STROKE_ADDED` to all clients. New clients get full `STATE` on connect.
- **Client**: Draws your stroke locally (pending) and sends `ADD_STROKE`. When the server echoes it back with a `seq`, the stroke moves from pending to the ordered list. Other clients only apply server messages, so everyone sees the same order.
