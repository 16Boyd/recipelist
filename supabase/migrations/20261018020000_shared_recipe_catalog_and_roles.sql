-- Roles are assigned by trusted project administrators. Browser clients can
-- only read their own role; account creation always starts as a member.
create table if not exists public.user_roles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  role text not null default 'member' check (role in ('member', 'admin')),
  created_at timestamptz not null default now()
);

alter table public.user_roles enable row level security;
revoke all on table public.user_roles from public, anon, authenticated;
grant select on table public.user_roles to authenticated;
drop policy if exists "Users can read their own role" on public.user_roles;
create policy "Users can read their own role" on public.user_roles
  for select to authenticated using (auth.uid() = user_id);

create or replace function public.create_member_role_for_auth_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.user_roles (user_id, role) values (new.id, 'member')
  on conflict (user_id) do nothing;
  return new;
end;
$$;
drop trigger if exists create_member_role_after_auth_user_insert on auth.users;
create trigger create_member_role_after_auth_user_insert after insert on auth.users
  for each row execute function public.create_member_role_for_auth_user();
revoke all on function public.create_member_role_for_auth_user() from public, anon, authenticated, service_role;
insert into public.user_roles (user_id, role)
select id, 'member' from auth.users on conflict (user_id) do nothing;

-- This helper is in a non-API schema. The policy can call it, but clients
-- cannot choose a user id or invoke an exposed admin-role endpoint.
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
create or replace function private.is_recipe_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.user_roles r
    where r.user_id = (select auth.uid()) and r.role = 'admin'
  );
$$;
grant usage on schema private to authenticated;
revoke all on function private.is_recipe_admin() from public, anon, service_role;
grant execute on function private.is_recipe_admin() to authenticated;

create table if not exists public.recipes (
  id text primary key check (length(trim(id)) between 1 and 120),
  title text not null check (length(trim(title)) between 1 and 200),
  source text not null,
  category text not null,
  time integer not null check (time > 0),
  servings integer not null check (servings > 0),
  image text not null,
  description text not null,
  ingredients jsonb not null check (case when jsonb_typeof(ingredients) = 'array' then jsonb_array_length(ingredients) > 0 else false end),
  created_at timestamptz not null default now()
);
alter table public.recipes enable row level security;
revoke all on table public.recipes from public, anon, authenticated;
grant select, insert on table public.recipes to authenticated;
drop policy if exists "AAL2 TOTP users can read shared recipes" on public.recipes;
create policy "AAL2 TOTP users can read shared recipes" on public.recipes
  for select to authenticated
  using (
    (select auth.jwt() ->> 'aal') = 'aal2'
    and ((select auth.jwt() -> 'amr') @> '[{"method":"totp"}]'::jsonb
      or (select auth.jwt() -> 'amr') @> '["totp"]'::jsonb)
  );
drop policy if exists "AAL2 TOTP admins can add shared recipes" on public.recipes;
create policy "AAL2 TOTP admins can add shared recipes" on public.recipes
  for insert to authenticated
  with check (
    (select auth.jwt() ->> 'aal') = 'aal2'
    and ((select auth.jwt() -> 'amr') @> '[{"method":"totp"}]'::jsonb
      or (select auth.jwt() -> 'amr') @> '["totp"]'::jsonb)
    and (select private.is_recipe_admin())
  );

-- The stable IDs also let the client collapse legacy private demo copies.
insert into public.recipes (id,title,source,category,time,servings,image,description,ingredients)
select x.id,x.title,x.source,x.category,x.time,x.servings,x.image,x.description,x.ingredients
from jsonb_to_recordset($recipes$
[
 {"id":"tomato-orzo","title":"Creamy Sun-Dried Tomato Orzo","source":"HelloFresh","category":"Pasta","time":25,"servings":2,"image":"https://images.unsplash.com/photo-1473093295043-cdd812d0e601?auto=format&fit=crop&w=1100&q=85","description":"A silky one-pan orzo with bright tomato, greens, and a little parmesan.","ingredients":[{"name":"orzo","amount":"1 cup"},{"name":"sun-dried tomatoes","amount":"⅓ cup"},{"name":"spinach","amount":"2 cups"},{"name":"heavy cream","amount":"½ cup"},{"name":"garlic","amount":"2 cloves"},{"name":"vegetable stock","amount":"2 cups"},{"name":"parmesan","amount":"¼ cup"}]},
 {"id":"chickpea-bowls","title":"Crispy Chickpea Green Bowls","source":"Home Chef","category":"Vegetarian","time":30,"servings":2,"image":"https://images.unsplash.com/photo-1512621776951-a57141f2eefd?auto=format&fit=crop&w=1100&q=85","description":"Herby couscous, crunchy chickpeas, and cool cucumber yogurt.","ingredients":[{"name":"chickpeas","amount":"1 can"},{"name":"couscous","amount":"1 cup"},{"name":"cucumber","amount":"1"},{"name":"plain yogurt","amount":"½ cup"},{"name":"lemon","amount":"1"},{"name":"dill","amount":"2 tbsp"}]},
 {"id":"miso-salmon","title":"Miso-Glazed Salmon & Rice","source":"Blue Apron","category":"Seafood","time":35,"servings":2,"image":"https://images.unsplash.com/photo-1519708227418-c8fd9a32b7a2?auto=format&fit=crop&w=1100&q=85","description":"Sweet-salty miso salmon with fluffy rice and quick pickled cucumber.","ingredients":[{"name":"salmon","amount":"2 fillets"},{"name":"white rice","amount":"1 cup"},{"name":"white miso","amount":"2 tbsp"},{"name":"honey","amount":"1 tbsp"},{"name":"cucumber","amount":"1"},{"name":"rice vinegar","amount":"2 tbsp"}]},
 {"id":"lemon-chicken","title":"Lemony Chicken & Crispy Potatoes","source":"Marley Spoon","category":"Chicken","time":40,"servings":2,"image":"https://images.unsplash.com/photo-1532550907401-a500c9a57435?auto=format&fit=crop&w=1100&q=85","description":"Golden chicken, smashed potatoes, and a fresh lemon pan sauce.","ingredients":[{"name":"chicken breast","amount":"2"},{"name":"baby potatoes","amount":"1 lb"},{"name":"lemon","amount":"1"},{"name":"green beans","amount":"8 oz"},{"name":"chicken stock","amount":"½ cup"},{"name":"butter","amount":"2 tbsp"}]},
 {"id":"mushroom-tacos","title":"Smoky Mushroom Tacos","source":"Dinnerly","category":"Vegetarian","time":20,"servings":2,"image":"https://images.unsplash.com/photo-1551500566-9c6f5f7cbb6a?auto=format&fit=crop&w=1100&q=85","description":"Quick charred mushrooms with avocado, lime, and a smoky spice blend.","ingredients":[{"name":"mushrooms","amount":"8 oz"},{"name":"corn tortillas","amount":"6"},{"name":"avocado","amount":"1"},{"name":"lime","amount":"1"},{"name":"smoked paprika","amount":"1 tsp"},{"name":"red onion","amount":"½"}]},
 {"id":"sausage-peppers","title":"Sausage, Pepper & Tomato Skillet","source":"HelloFresh","category":"One-pan","time":30,"servings":4,"image":"https://images.unsplash.com/photo-1547592180-85f173990554?auto=format&fit=crop&w=1100&q=85","description":"A weeknight skillet with browned sausage, peppers, and warm spices.","ingredients":[{"name":"Italian sausage","amount":"1 lb"},{"name":"bell pepper","amount":"2"},{"name":"crushed tomatoes","amount":"1 can"},{"name":"yellow onion","amount":"1"},{"name":"garlic","amount":"2 cloves"},{"name":"couscous","amount":"1 cup"}]}
]
$recipes$::jsonb) as x(id text,title text,source text,category text,time integer,servings integer,image text,description text,ingredients jsonb)
on conflict (id) do nothing;
