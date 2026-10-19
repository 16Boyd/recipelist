<img src="assets/icon.svg" width="48" height="48" alt="RecipeList">

# RecipeList

RecipeList is a recipe and pantry planner. Browse a sample recipe library, track ingredients on hand, see which dinners are closest to ready, and turn missing ingredients into a shopping list. Your recipes, pantry, and shopping list are stored in your signed-in Supabase profile.

## Run with local Supabase

The local setup runs the Supabase Auth and Postgres services in a Docker-backed local stack. RecipeList data is saved in that local database, not in browser storage. You need Node.js 22 or newer, Docker Desktop (or another Docker-compatible container runtime), and enough disk space for the Supabase service images. Keep this development stack on your machine; it is not configured for public exposure.

Install project dependencies, then start the local services from the repository root:

```sh
npm install
npx supabase start
```

The checked-in [`supabase/config.toml`](supabase/config.toml) configures the local project, and `supabase start` applies the checked-in migrations. To rebuild the local database and reapply migrations from a clean state, run:

```sh
npx supabase db reset
```

Use `npx supabase status` to see the local API URL and keys. Copy the API URL and the **publishable/anon key** into `.env.local` (never the secret/service-role key):

```sh
cp .env.example .env.local
```

Set `VITE_SUPABASE_URL` to the local API URL and `VITE_SUPABASE_ANON_KEY` to the local publishable/anon key, then run the app:

```sh
npm run dev
```

Local confirmation emails are disabled in `supabase/config.toml`, so local sign-up can continue without checking an inbox. If you enable confirmations, Supabase's local Mailpit inbox is available from the service URLs printed by `supabase status`.

## Use hosted Supabase

Create a hosted Supabase project. Apply the checked-in migrations (including the role and shared-catalog migration) by linking the CLI and pushing migrations. Local `supabase start` and `supabase db reset` apply those same migrations for local development:

```sh
npx supabase login
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase db push
```

Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in your local `.env.local` or deployment environment to the hosted project URL and its publishable/anon key. Configure allowed site URLs, email confirmation, the password policy, and authenticator-app TOTP in the hosted project's Authentication settings. Match the password requirements and enabled TOTP factor settings in `supabase/config.toml`; hosted projects do not inherit local Auth settings. RecipeList requires the session's TOTP authentication method and AAL2 claim, including when other MFA methods are enabled. Local and hosted modes use the same Supabase Auth + Postgres API and the same migration; there is no separate SQLite backend.

The browser uses only the URL and publishable/anon key. Never put a secret/service-role key in a frontend environment variable (including any `VITE_` variable) or commit any real keys. `.env.local` is ignored by Git; `.env.example` contains placeholders only.

Create a production build with `npm run build`.

## Data and sign-in

- Anyone can create an account from RecipeList with an email address and password. The local policy requires at least 12 characters with mixed character types. Hosted projects may require the user to confirm their email before signing in; local email confirmation is disabled by default.
- RecipeList requires an authenticator-app TOTP factor. On first sign-in, a user enrolls an authenticator app and verifies its code. On later sign-ins, the user enters a current code from that app. Profile data is only loaded or saved after Supabase confirms the session has completed MFA (AAL2).
- A `user_profiles` row is created automatically when the Supabase Auth account is created. After sign-in and MFA, RecipeList initializes that row with the user's pantry and shopping list, or loads the existing profile data. Demo recipes load from the shared `public.recipes` catalog. Row-level security restricts each profile to its owner and requires the MFA-authenticated session.
- Each account has one role in the protected `public.user_roles` table: `member` or `admin`. New accounts default to `member`, and the migration backfills existing accounts. Browser clients cannot change their own role.
- Members can manage their own pantry, shopping list, and private recipes in their one-to-one profile. Authenticated users can read the shared published recipe catalog. Only admins can write shared catalog recipes; when adding a recipe, an admin can choose to keep it personal or publish it to the shared catalog. Recipes, pantry items, and shopping lists in a user's profile remain private.
- To promote a trusted account, a trusted project operator can run this in the Supabase SQL Editor after the role migration has been applied. Replace the example address and confirm that exactly one row was updated:

  ```sql
  update public.user_roles ur
  set role = 'admin'
  from auth.users u
  where ur.user_id = u.id
    and lower(u.email) = lower('admin@example.com');
  ```

  Role assignment is a database-operator action; it is not exposed to frontend clients.
- To invite a user administratively, use the Supabase project's Authentication user management. The invitation link confirms the invitee's email and returns them to RecipeList to set a password before enrolling an authenticator app. There is no in-app admin user manager. If a user loses access to their authenticator, a project administrator must help restore account access; backup-factor management is not provided by RecipeList.
- Recipe, pantry, and shopping-list app data is not saved in browser storage. Supabase Auth may remember the sign-in session in browser storage; RecipeList also keeps a user-scoped pending-invitation marker there until the invitee sets a password.
- If a cloud save fails, RecipeList keeps the current edits visible, shows an error, and offers a retry. Sign out and sign back in to use the profile on another device.
- The included recipes are short demo entries for exploring the matching flow; RecipeList is not affiliated with any meal service.
