create policy "Require AAL2 for user profile access"
  on public.user_profiles
  as restrictive
  for all
  to authenticated
  using (
    (select auth.jwt() ->> 'aal') = 'aal2'
    and (
      (select auth.jwt() -> 'amr') @> '[{"method":"totp"}]'::jsonb
      or (select auth.jwt() -> 'amr') @> '["totp"]'::jsonb
    )
  )
  with check (
    (select auth.jwt() ->> 'aal') = 'aal2'
    and (
      (select auth.jwt() -> 'amr') @> '[{"method":"totp"}]'::jsonb
      or (select auth.jwt() -> 'amr') @> '["totp"]'::jsonb
    )
  );

-- Every Auth user has exactly one profile row. The auth.users trigger creates
-- a placeholder; the application conditionally initializes it after AAL2.
create or replace function public.create_user_profile_for_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.user_profiles (user_id, app_data, schema_version)
  values (new.id, '{}'::jsonb, 0)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists create_user_profile_after_auth_user_insert on auth.users;
create trigger create_user_profile_after_auth_user_insert
  after insert on auth.users
  for each row execute function public.create_user_profile_for_auth_user();

revoke all on function public.create_user_profile_for_auth_user() from public, anon, authenticated, service_role;

-- Install the trigger before backfilling. This makes user creation safe whether
-- migrations run statement-by-statement or in one transaction: inserts before
-- trigger installation are covered by the backfill; later inserts use trigger.
insert into public.user_profiles (user_id, app_data, schema_version)
select id, '{}'::jsonb, 0
from auth.users
on conflict (user_id) do nothing;

-- Profile row lifecycle belongs to the Auth trigger, never to browser clients.
drop policy if exists "Users can create their own profile" on public.user_profiles;
drop policy if exists "Users can delete their own profile" on public.user_profiles;
revoke insert, delete on table public.user_profiles from authenticated;
