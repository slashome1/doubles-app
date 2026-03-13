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
- auto-resume unfinished round after login
- start a round and add players fast
- reuse previous players or create new ones
- club member vs guest handling
- greens / CTP / Ace / payout contributions per player
- random CTP hole selection from admin-approved holes
- team randomization with Cali support
- completed round history page
- end-of-round payouts for ace / CTP / winners
- persistent running ACE pot across rounds
- admin settings for CTP holes + ACE pot adjustment
- admin stats dashboard
- admin round correction basics:
  - edit contributions
  - mark dropouts
  - remove player from active round
  - manual team override
  - cancel unfinished round

## Security note

PINs are stored using `scrypt` hashing. Older plaintext PIN rows are automatically migrated to hashed values on startup.

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
  auth.js
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

- force PIN rotation on first production login
- completed-round detail screens with edit history
- audit log for admin corrections
- export CSV / payout history
- more robust team editor UI
- per-player lifetime payout totals
