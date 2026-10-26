# Install RecipeList in a Debian LXC

RecipeList runs directly in a Debian LXC with PostgreSQL and systemd; Docker is not required. The repository includes one script for a fresh install and for updating an existing install.

Use an unprivileged Debian 12 or 13 LXC with network access and persistent storage. Allocate enough disk for PostgreSQL data and backups. Run the commands below inside the guest as an administrator with `sudo`; if already logged in as root, omit `sudo`.

## Requirements

For a fresh install, the script installs the current supported Node.js LTS release (22 or newer), PostgreSQL, Git, build tools, and other required packages. It supports Debian 12 or 13 on amd64 and arm64. For updates, run the script as root: it installs missing Debian prerequisites and PostgreSQL client utilities, then installs the current supported Node.js LTS release if Node.js is missing, below version 22, or npm is missing or unusable. An existing Node.js 22-or-newer runtime with working npm is kept, whether or not it is still an LTS release. Updates do not install or initialize a PostgreSQL server. Keep PostgreSQL bound to loopback.

The root-run installer requires `/usr/local`, `/usr/local/bin`, and `/usr/local/lib` to be protected from writes by non-root users. Debian's optional `root:staff` group-writable `/usr/local` setup is unsupported; the installer stops if it detects unsafe permissions. Do not loosen these paths to work around that check.

## Fresh install

From a fresh Debian LXC, download the installer and run it as root:

```sh
sudo apt-get update
sudo apt-get install -y ca-certificates curl
curl --fail --location --proto '=https' --proto-redir '=https' https://raw.githubusercontent.com/16Boyd/recipelist/main/scripts/recipelist-lxc.sh -o /tmp/recipelist-lxc.sh
sudo bash /tmp/recipelist-lxc.sh install
```

The script installs and configures PostgreSQL and the systemd service, creates the application database and credentials, builds RecipeList under `/opt/recipelist`, and starts the service. It stores application configuration in root-owned `/etc/recipelist/recipelist.env`; secrets are not printed. Preserve a secure backup of this file because it contains the credentials required to run the app.

If a fresh install fails before `recipelist.service` is created, it may have left some setup artifacts behind, such as the `recipelist` user or group, PostgreSQL role or database, `/etc/recipelist/recipelist.env`, or `/opt/recipelist`. Inspect each artifact and the reported error before deciding how to recover or retry. Do not automatically remove these paths or drop the database; the database may contain data. If the service unit was created, use the service status and journal diagnostics below instead of treating the failure as pre-unit cleanup.

By default, RecipeList is local-only: it uses `http://localhost:3000` and listens on `127.0.0.1`. This is suitable when a reverse proxy runs in the same LXC. For a public HTTPS hostname, provide the intended origin at installation:

```sh
sudo bash /tmp/recipelist-lxc.sh install --url https://recipes.example.net
```

Non-local origins must use HTTPS. If a TLS reverse proxy runs in the same guest, enable trusted proxy handling with `--trust-proxy true`:

```sh
sudo bash /tmp/recipelist-lxc.sh install --url https://recipes.example.net --trust-proxy true
```

When the reverse proxy runs in a separate LXC or host, explicitly bind the app to all interfaces and restrict port 3000 in the guest and host firewalls to that proxy's address:

```sh
sudo bash /tmp/recipelist-lxc.sh install --url https://recipes.example.net --bind-address 0.0.0.0 --trust-proxy true
```

Configure the proxy to forward the original host and protocol and to overwrite `Host`, `X-Forwarded-Host`, and `X-Forwarded-Proto`. Only use `--trust-proxy true` when requests pass through a trusted proxy that sets those headers. Do not expose the app directly over plain HTTP to other devices. When changing settings later, edit `/etc/recipelist/recipelist.env` as root and restart with `sudo systemctl restart recipelist`.

## Verify and troubleshoot

Check the service and its health endpoint from inside the guest:

```sh
sudo systemctl status recipelist
curl --fail http://127.0.0.1:3000/api/healthz
sudo journalctl -u recipelist -b
```

The health endpoint should return `{"status":"ok"}`. The service runs database migrations before starting the app. If startup fails with systemd status `226/NAMESPACE`, inspect the journal and the host LXC/AppArmor policy for a denied namespace operation.

The app migration set keeps its Better Auth user and session references as PostgreSQL `uuid` columns. On an existing installation, migration `0003_auth_foreign_keys_uuid` converts the earlier text columns after checking that values are valid UUIDs and point to existing auth rows. A malformed or orphaned value stops startup with a diagnostic; inspect the database and take a backup before correcting the row and restarting. Recipe identifiers remain text. Migration `0005_recipe_instruction_backfill` fills instructions for the six seeded demo recipes only when the stored field is blank or whitespace-only, preserving nonblank entries. PostgreSQL integration coverage is opt-in and destructive: run `TEST_DATABASE_URL=... TEST_DATABASE_ALLOW_SCHEMA_RESET=1 npm test -- tests/server/migrations.postgres.test.ts` only against a dedicated disposable database whose name includes `test` as a delimited word (for example, `recipelist_migration_test`). The suite recreates that database's `public` schema.

For failures after the service unit exists, inspect `sudo systemctl status recipelist` and `sudo journalctl -u recipelist -b` before attempting recovery. Application SQL migrations run as one transaction, so a failed app migration rolls back that app-migration batch and its version records. Better Auth schema migrations run before that transaction and may already have been applied. Preserve the configuration and any database backup while investigating a startup failure.

## Update an existing install

An update keeps the existing database and `/etc/recipelist/recipelist.env` configuration. Download the updater and run it as root:

```sh
curl --fail --location --proto '=https' --proto-redir '=https' https://raw.githubusercontent.com/16Boyd/recipelist/main/scripts/recipelist-lxc.sh -o /tmp/recipelist-lxc.sh
sudo bash /tmp/recipelist-lxc.sh update
```

Downloading the script requires `curl` and CA certificates. If they are missing, use the bootstrap commands in the Fresh install section (`sudo apt-get update` and `sudo apt-get install -y ca-certificates curl`) before downloading. Once the script is downloaded, running it as root handles the other required Debian packages and Node.js/npm setup. It requests only missing Debian packages, without a broad upgrade, and does not install or initialize a PostgreSQL server. It checks that the installed PostgreSQL client is compatible with the running server before stopping RecipeList; it installs a matching client package if available, otherwise it aborts.

The updater validates the architecture and ref syntax before package changes, then provisions prerequisites and resolves the ref before explicitly stopping RecipeList. Apt hooks can still restart system services during package installation. An existing Node.js 22-or-newer runtime with working npm is retained regardless of its LTS status. If Node.js is missing or below 22, or npm is missing or unusable, the updater stages and verifies the current supported LTS runtime before switching the `node`, `npm`, and `npx` command links. npm may need network access to download dependencies during the build, after RecipeList has stopped.

By default, the script updates to `main`. To select a branch, tag, or commit, use `--ref`:

```sh
sudo bash /tmp/recipelist-lxc.sh update --ref v1.2.3
```

After provisioning prerequisites and checking runtime/database compatibility, the updater fetches and resolves the requested ref before explicitly stopping the app. It then stops the app to create and validate a private PostgreSQL custom-format dump under `/var/backups/recipelist`, before checking out or building any code. If dump creation or archive-list verification fails, the updater best-effort restarts and health-checks the unchanged app if it was active before the stop; an app that was already inactive stays inactive. The app stays stopped for checkout, build, and startup migrations. If the repository's systemd unit changed, the updater stages it and publishes it with a daemon reload only after the build succeeds, before starting the app. Copy backups off the guest regularly. A successful archive listing checks that the dump can be read; it is not a restore test. Some migration failures may require manual recovery or restoring a backup. Failures after checkout begins do not roll back code or the database automatically and may leave the service stopped. Review the service journal and health endpoint after each update.

The installer and updater refuse to proceed when the service has systemd drop-ins. Drop-ins can override the managed service user and security settings; review and remove them before retrying. On a fresh install this check happens after the unit is written, but before the service is enabled or started. The updater also refuses an application checkout with uncommitted changes; commit or discard intended checkout changes before updating.

## Back up and restore

Accounts, MFA setup, pantry data, shopping lists, and recipes are stored in PostgreSQL. Regularly copy database backups off the LXC and securely preserve `/etc/recipelist/recipelist.env` separately. The update script keeps its validated dumps in `/var/backups/recipelist`, but these local copies do not replace off-container backups.

To create a manual custom-format dump:

```sh
sudo install -d -o postgres -g postgres -m 0700 /var/backups/recipelist
sudo -u postgres sh -c 'umask 077; pg_dump -Fc recipelist -f "/var/backups/recipelist/recipelist-$(date +%F-%H%M%S).dump"'
```

To restore, place the dump in `/var/backups/recipelist`, stop RecipeList, and restore into the existing database. This replaces its objects and data. `--role=recipelist` assigns restored objects to the app role; `--single-transaction` prevents a partial restore:

```sh
sudo systemctl stop recipelist
sudo -u postgres pg_restore --clean --if-exists --no-owner --role=recipelist --single-transaction --dbname=recipelist /var/backups/recipelist/recipelist-backup.dump && sudo systemctl start recipelist
```

If `pg_restore` fails, the service remains stopped. Inspect the error and database before starting it again. Test backups by restoring them in a separate environment.

## Promote an administrator

Sign up through the running app and complete authenticator-app TOTP setup. Then promote that existing account using its email address:

```sh
sudo sh -c 'cd /opt/recipelist && set -a && . /etc/recipelist/recipelist.env && set +a && exec node dist-server/server/promote-admin.js admin@example.com'
```

Replace the example address with the exact account email. The command changes that account's role in PostgreSQL; it does not create an account. Keep the environment file private while running administrative commands.
