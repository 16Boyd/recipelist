# Install RecipeList in a Debian LXC

This guide runs the RecipeList Express server and PostgreSQL directly inside a Debian LXC guest. The app serves its built frontend and API on the same port. It does not require Docker inside the guest.

Use an unprivileged Debian LXC with network access and a persistent root filesystem. Debian 12 and 13 are suitable starting points; allocate enough disk for PostgreSQL data and off-container backups. Keep the database bound to loopback and expose the app through a trusted TLS reverse proxy. This guide assumes a fresh guest and commands run inside it as an administrator with `sudo`.

## 1. Install system packages and Node.js

Install PostgreSQL, Git, build tools, and utilities:

```sh
sudo apt update
sudo apt install -y ca-certificates curl git build-essential postgresql postgresql-client openssl
```

RecipeList requires Node.js 22 or newer. Use an actively supported Node.js LTS release; Node.js 24 LTS is a good choice. Debian's packaged Node version may be older than the application requirement (for example, Debian 13's `nodejs` package is 20.19.2), so check the version instead of assuming `apt install nodejs` is sufficient. Install Node using one of the official methods at [nodejs.org/en/download](https://nodejs.org/en/download), following the supported release guidance at [nodejs.org/en/about/previous-releases](https://nodejs.org/en/about/previous-releases). Do not use an end-of-life release.

Confirm that the selected Node installation is on the system service PATH and meets the minimum before continuing:

```sh
node --version
npm --version
command -v node
```

The Node version must be at least `v22`. The systemd unit invokes `node` through the standard system PATH. If you install Node elsewhere, ensure that path is available to system services or adjust both `ExecStart` entries in the unit file.

## 2. Create the PostgreSQL database

Keep PostgreSQL on loopback. The app and database run in the same guest, so there is no reason to publish port 5432 to the network. Generate a database password containing only URL-safe hexadecimal characters, then use the same value in the SQL command and the environment file:

```sh
openssl rand -hex 32
```

Connect as the PostgreSQL administrator:

```sh
sudo -u postgres psql
```

At the `psql` prompt, replace the password placeholder with the generated value:

```sql
CREATE ROLE recipelist LOGIN PASSWORD 'PASTE_GENERATED_HEX_PASSWORD_HERE';
CREATE DATABASE recipelist OWNER recipelist;
\q
```

The app connects through `127.0.0.1` using this dedicated database role. Debian's default PostgreSQL configuration accepts local TCP connections with password authentication; keep its listener and firewall configuration private to the guest.

## 3. Configure the app secrets

Create a dedicated non-login account for the service and a root-owned configuration directory. The app only needs to read its checkout and configuration:

```sh
sudo adduser --system --group --no-create-home recipelist
sudo install -d -o root -g root -m 0750 /etc/recipelist
sudo install -o root -g root -m 0600 /dev/null /etc/recipelist/recipelist.env
sudoedit /etc/recipelist/recipelist.env
```

Set the following values in the file. Generate a distinct auth secret with `openssl rand -hex 32`; do not reuse the database password. Use the exact public origin users will open for `BETTER_AUTH_URL`:

```dotenv
NODE_ENV=production
DATABASE_URL=postgresql://recipelist:PASTE_GENERATED_HEX_PASSWORD_HERE@127.0.0.1:5432/recipelist
BETTER_AUTH_SECRET=PASTE_A_DIFFERENT_RANDOM_SECRET_OF_AT_LEAST_32_CHARACTERS
BETTER_AUTH_URL=https://recipes.example.net
PORT=3000
HOST=127.0.0.1
TRUST_PROXY=true
```

Use `HOST=127.0.0.1` when a reverse proxy runs inside this guest. Use `HOST=0.0.0.0` only when a proxy on another machine must connect to the guest; in that case, restrict port 3000 with the host and guest firewalls to that proxy's address. Set `TRUST_PROXY=true` only when requests pass through a trusted TLS reverse proxy that sets the original protocol and host headers. For direct local-only use without a proxy, set `BETTER_AUTH_URL=http://localhost:3000`, `HOST=127.0.0.1`, and `TRUST_PROXY=false`. Non-local origins require HTTPS.

The systemd manager reads this root-owned file when it starts the service and passes the values to the app; the app account does not open the file itself. Do not place secrets in the Git checkout or expose this file to the service account or other users. `BETTER_AUTH_SECRET` must contain at least 32 characters.

## 4. Build and install the service

Install the source at the path used by the service unit. Replace the repository URL with the trusted URL for your RecipeList source:

```sh
sudo git clone REPOSITORY_URL /opt/recipelist
```

Build the production frontend and compiled server. Keep `/opt/recipelist` root-owned so the service account cannot replace executable files; the service needs read and directory traversal access only:

```sh
sudo chown -R root:root /opt/recipelist
sudo chmod -R a+rX,go-w /opt/recipelist
cd /opt/recipelist
sudo npm ci
sudo npm run build
sudo npm prune --omit=dev
sudo chown -R root:root /opt/recipelist
sudo chmod -R a+rX,go-w /opt/recipelist
```

The checkout and its parent directories must be traversable by the service account; the standard `/opt` mode is `0755`. The recursive permissions above ensure files created by npm remain readable after builds even when the administrator's umask is restrictive, while keeping the checkout unwritable by group and other users. Repeat them after upgrades. The working directory matters: the migration runner loads SQL from `server/migrations` relative to the project root. The systemd unit runs the compiled migration before each app start, then starts the compiled Express server.

Install and enable the service:

```sh
sudo install -D -o root -g root -m 0644 deploy/lxc/recipelist.service /etc/systemd/system/recipelist.service
sudo systemctl daemon-reload
sudo systemctl enable --now recipelist
sudo systemctl status recipelist
```

Check the health endpoint from inside the guest:

```sh
curl --fail http://127.0.0.1:3000/api/healthz
```

It should return `{"status":"ok"}`. Inspect startup or migration errors with `sudo journalctl -u recipelist -b`.
The unit's mount-namespace hardening depends on the host LXC policy. If startup fails with systemd status `226/NAMESPACE`, inspect the service journal and host LXC/AppArmor policy for the denied namespace operation.

## 5. Put the app behind HTTPS

For LAN or internet access, configure a TLS reverse proxy to forward to `127.0.0.1:3000` when it is in the same guest. A proxy on another machine can reach the app only when you intentionally bind it to `0.0.0.0`; firewall access to port 3000 should then be limited to that proxy. Do not expose the app directly over plain HTTP to other devices.

Set `BETTER_AUTH_URL` to the exact HTTPS origin and configure the proxy to forward the original host and protocol. Leave `TRUST_PROXY=false` unless the proxy is trusted and correctly supplies those headers. Restart the service after changing the environment file:

```sh
sudo systemctl restart recipelist
```

## Upgrade

Back up the database before upgrading. Fetch and check out the desired release in `/opt/recipelist`, then rebuild dependencies and artifacts. Preserve root ownership and do not make the checkout writable by the service account:

```sh
sudo systemctl stop recipelist
sudo git -C /opt/recipelist fetch --tags
sudo git -C /opt/recipelist checkout YOUR_RELEASE_OR_COMMIT
cd /opt/recipelist
sudo npm ci
sudo npm run build
sudo npm prune --omit=dev
sudo chown -R root:root /opt/recipelist
sudo chmod -R a+rX,go-w /opt/recipelist
sudo systemctl start recipelist
sudo systemctl status recipelist
```

The service runs database migrations before starting the app. Check its journal and health endpoint after the upgrade. If startup fails, review the error before restoring the previous code or database; migrations may not be reversible automatically.

## Back up and restore

The app has no local user-data files: accounts, MFA setup, pantry data, shopping lists, and recipes live in PostgreSQL. Create regular database dumps and copy them off the LXC guest. Store them in a PostgreSQL-owned directory with owner-only access so the app account and other users cannot read the backups. A custom-format dump includes the database objects and can be restored with `pg_restore`:

```sh
sudo install -d -o postgres -g postgres -m 0700 /var/backups/recipelist
sudo -u postgres sh -c 'umask 077; pg_dump -Fc recipelist -f "/var/backups/recipelist/recipelist-$(date +%F-%H%M%S).dump"'
```

The command writes the dump directly as `postgres` and propagates `pg_dump` failures without a pipeline. Transfer backups to separate storage while preserving their protection. To restore, make the dump readable by PostgreSQL (for example, place it in `/var/backups/recipelist`), stop the app, and restore into the existing database (this replaces its objects and data). `--role=recipelist` makes the restored objects belong to the app's database role, and `--single-transaction` prevents a partial restore:

```sh
sudo systemctl stop recipelist
sudo -u postgres pg_restore --clean --if-exists --no-owner --role=recipelist --single-transaction --dbname=recipelist /var/backups/recipelist/recipelist-backup.dump && sudo systemctl start recipelist
```

If `pg_restore` fails, the service remains stopped; inspect the error and database before starting it again.

Use a verified backup and confirm the target before restoring. A backup of PostgreSQL does not include `/etc/recipelist/recipelist.env`; preserve that secret configuration separately in a secure backup. Test backups by restoring them in a separate environment.

## Promote an administrator

Sign up through the running app, complete authenticator-app TOTP setup, then run the promotion command from the project checkout. The service environment file provides the database connection:

```sh
sudo sh -c 'cd /opt/recipelist && set -a && . /etc/recipelist/recipelist.env && set +a && exec node dist-server/server/promote-admin.js admin@example.com'
```

Replace the example address with the exact account email. The command changes that existing account's role in PostgreSQL; it does not create an account. Keep the environment file private while running administrative commands.
