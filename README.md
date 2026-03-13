# Doubles App

A simple, mobile-friendly web app for running local disc golf doubles rounds.

## Stack

- Node.js + Express
- EJS server-rendered UI
- SQLite (`better-sqlite3`)
- Session auth with PIN login
- Docker-ready for self-hosting behind a reverse proxy

## Why this stack?

It keeps the app small, fast, and easy to maintain:
- one process
- one SQLite database file
- no frontend build pipeline
- easy backups
- easy to run on a small home server

## Features in this MVP

- Admin + standard user PIN login
- Auto-resume unfinished round after login
- Start a round and add players fast
- Reuse previous players or create new ones
- Club member vs guest handling
- Greens / CTP / Ace / payout contributions per player
- Random CTP hole selection from admin-approved holes
- Team randomization with Cali support for odd player counts
- End-of-round payouts for ace / CTP / winners
- Persistent running ACE pot across rounds
- Admin settings for CTP holes + ACE pot adjustment
- Admin stats dashboard
- Admin round correction basics:
  - edit contributions
  - mark dropouts
  - remove player from active round
  - manual team override
  - cancel unfinished round

## ACE pot rule implemented

- If **no ace happens**, every player who opted into the Ace Pot adds `$1` to the running ACE pot.
- If **one or more aces happen**, the **entire current ACE pot** is split evenly across all selected ace hitters.
- After an ace payout, the ACE pot resets to `$0.00`.

This rule is explicit, simple, and easy to explain during league play.

## Default login

Change these for production.

- Admin: `admin` / `1234`
- User: `user` / `1111`

## Local run

```bash
npm install
npm start
```

Then open <http://localhost:3000>

## Docker run

```bash
docker compose up --build -d
```

The SQLite DB and session data live in `./data`.

## Reverse proxy

Intended hostname:
- `https://doubles.slashome.duckdns.org`

Proxy incoming HTTPS traffic to the app container on port `3000`.

## Environment variables

See `.env.example`.

Important production changes:
- set a strong `SESSION_SECRET`
- change both default PINs
- back up the `data/` directory regularly

## Project structure

```text
src/
  db.js
  repo.js
  utils.js
views/
public/
data/
server.js
Dockerfile
docker-compose.yml
```

## Next sensible improvements

- hashed PIN storage instead of plaintext
- round history page and completed round detail view
- audit log for admin corrections
- export CSV / payout history
- stronger validation around round completion forms
- per-player lifetime payout totals
