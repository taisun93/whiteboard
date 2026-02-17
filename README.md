# Whiteboard (barebone)

Real-time sync with **server-authoritative ordering** and **optimistic UI**.

## Run

```bash
npm install
npm start
```

Open http://localhost:3000 in two (or more) browser windows/tabs and draw. Strokes sync in server order; your own strokes show immediately (optimistic), then get a sequence number from the server and stay in sync with others.

## How it works

- **Server**: Assigns a sequence number to each stroke and broadcasts `STROKE_ADDED` to all clients. New clients get full `STATE` on connect.
- **Client**: Draws your stroke locally (pending) and sends `ADD_STROKE`. When the server echoes it back with a `seq`, the stroke moves from pending to the ordered list. Other clients only apply server messages, so everyone sees the same order.
