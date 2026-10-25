<img src="assets/icon.svg" width="48" height="48" alt="RecipeList">

# RecipeList

RecipeList is a recipe and pantry planner. Browse the shared recipe catalog, track ingredients on hand, see which dinners are closest to ready, and turn missing ingredients into a shopping list. Accounts, pantry data, and shopping lists are stored in PostgreSQL on the server; the browser does not store app data.

## Deployment options

- **Docker Compose:** follow the guide below to run the app and PostgreSQL together in containers.
- **Debian LXC:** follow the [native LXC installation guide](docs/lxc-install.md) to install PostgreSQL and run the app as a systemd service inside a Debian container.

## Self-host with Docker Compose

The Compose setup runs the RecipeList app and PostgreSQL on one server. It automatically waits for PostgreSQL, applies the Better Auth and RecipeList database migrations, then starts the app. PostgreSQL is only available to the app over the Compose network. Its data is kept in the named `recipelist-data` volume.

You need Docker with the Compose plugin. To run the app on the same machine, open `http://localhost:3000`. Do not expose the default HTTP setup to other devices or the internet: use a TLS reverse proxy for LAN or remote access (see [LAN access and TLS](#lan-access-and-tls)).

From the repository root, create a private environment file and set strong, unique secrets:

```sh
cp .env.example .env
openssl rand -hex 32
```

Generate a value for both `POSTGRES_PASSWORD` and `BETTER_AUTH_SECRET` (run the command twice), and replace the placeholders in `.env`. Keep `.env` private and out of version control. The example file documents all supported settings:

- `POSTGRES_PASSWORD` sets the database password.
- `BETTER_AUTH_SECRET` signs authentication data and must contain at least 32 characters.
- `BETTER_AUTH_URL` is the exact origin users open, such as `http://localhost:3000` for same-machine use or `https://recipes.example.net` behind a TLS proxy.
- `APP_PORT` selects the host port exposed by Compose (default `3000`).
- `APP_BIND_ADDRESS` controls which host interface receives that port; it defaults to `127.0.0.1`, so the app is reachable only from the server itself and a reverse proxy on that host.
- `TRUST_PROXY` is `false` by default; set it to `true` only when the app is behind your trusted TLS reverse proxy.
- `DATABASE_URL` is used by host-run development and administration commands. Compose configures the app container to connect to its internal database service.
- `PORT` is the app's internal listening port (default `3000`).

Start the self-hosted service:

```sh
docker compose up -d --build
```

Check that the services are running with `docker compose ps`. To see app logs, use `docker compose logs -f app`. After changing configuration or pulling an update, run `docker compose up -d --build` again.

## LAN access and TLS

The default `http://localhost:3000` address is for use on the server itself. For access from phones or other computers, put a TLS reverse proxy (for example, Caddy, nginx, or Traefik) in front of the app. A proxy on the same host can forward to `127.0.0.1:3000`; a proxy in another container on the same Docker network can connect to `app:3000`. Configure it to forward HTTPS requests, set `BETTER_AUTH_URL` to the public HTTPS origin users will visit, and set `TRUST_PROXY=true` only when that proxy is trusted and forwards the original protocol and host headers. Keep `APP_BIND_ADDRESS` at `127.0.0.1` unless the proxy must reach a host-published port through another interface; if you change it to `0.0.0.0`, use firewall rules to allow only the proxy to connect. Restart with `docker compose up -d` after changing `.env`.

Use a private network or firewall rules to restrict access as appropriate. Do not publish PostgreSQL port `5432` to the network; the Compose file does not publish it.

## Accounts, MFA, and roles

- Users create their own accounts from the sign-up screen with an email and password. Passwords must be 12–128 characters and include a lowercase letter, an uppercase letter, a number, and a symbol. Registration creates exactly one profile and a `member` role for each account.
- Authenticator-app TOTP MFA is mandatory. New users enroll and verify an authenticator during setup. The server records which session completed TOTP verification and permits profile and recipe access only for that verified session. Users can sign in with a current TOTP code or a one-use backup code. Sessions use an HttpOnly cookie; the server keeps session cookie caching disabled.
- Members can manage their own pantry, shopping list, and private recipes. Signed-in users can read the shared recipe catalog. Only admins can add shared recipes.
- There is no in-app administrator or invitation screen. To make your first admin, sign up through the app, complete TOTP setup and sign in, then run this on the server from the project checkout after `npm install` and `npm run build`:

  ```sh
  npm run admin:promote -- admin@example.com
  ```

  For an already running Docker deployment, run the same command inside the app container:

  ```sh
  docker compose exec app npm run admin:promote -- admin@example.com
  ```

  Replace the example address with the exact email of the account to promote. The command fails if no matching RecipeList account exists. Promotion is a server-side database operation; it is not available to browser clients.

## Development without Dockerizing the app

The app can run on the host while PostgreSQL runs in Compose. Install Node.js 22 or newer and npm, and configure `.env` as above. Start only the database, then migrate it and run the development servers:

```sh
npm install
docker compose up -d db
npm run db:migrate
npm run dev
```

Open `http://localhost:5173`. The Vite development server proxies API requests to the local Express server. For this workflow, `DATABASE_URL` in `.env` must point to the database on `localhost:5432`, as in `.env.example`. To build the production app, use `npm run build`.

## Tests

Run the repository test suite with `npm test`. The default suite covers client utilities, storage, UI and authentication flows, plus server validation, auth policy, migrations, admin operations, and HTTP routes. It uses offline fakes and does not require `.env` or a PostgreSQL service.

The Better Auth/PostgreSQL migration integration suite is opt-in. Run it only against a dedicated disposable database whose name includes `test` as a delimited word; it recreates that database's `public` schema:

```sh
TEST_DATABASE_URL=postgres://.../recipelist_migration_test \
TEST_DATABASE_ALLOW_SCHEMA_RESET=1 \
npm test -- tests/server/migrations.postgres.test.ts
```

For related checks, use `npm run test:watch` while developing, `npm run test:types` to type-check the tests, or `npm run test:coverage` to generate a coverage report.

## Backups and persistence

The named Docker volume survives container rebuilds and restarts, but it is not a backup. Create regular PostgreSQL dumps and copy them off the server:

```sh
docker compose exec -T db pg_dump -U recipelist -d recipelist --clean --if-exists > recipelist-backup.sql
```

Restore a dump while the app is stopped. This command replaces the database objects from the dump, so confirm the file and target first:

```sh
docker compose stop app
docker compose exec -T db psql -U recipelist -d recipelist --set ON_ERROR_STOP=on < recipelist-backup.sql
docker compose start app
```

Keep encrypted backups somewhere separate from the server. Removing the Compose volume (for example, with `docker compose down -v`) permanently deletes the database, including accounts, MFA enrollment, profiles, and recipes.

## Existing Supabase data

This version runs entirely on the self-hosted PostgreSQL database and has no Supabase dependency or Supabase setup path. It does not automatically import Supabase data or credentials. If you already have Supabase accounts, export/import application data separately; users need to create accounts on this server and enroll TOTP again. Password hashes, active sessions, and authenticator secrets are not transferred.

The included recipes are short demo entries for exploring the matching flow; RecipeList is not affiliated with any meal service.
