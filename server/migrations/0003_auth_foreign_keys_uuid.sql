-- Convert app references left as text by earlier CREATE TABLE IF NOT EXISTS runs.
-- Validate the complete expected shape before changing any columns.
DO $$
DECLARE
  expected record;
  actual_type text;
  invalid_value text;
BEGIN
  FOR expected IN
    SELECT * FROM (VALUES
      ('user_roles', 'user_id', 'user'),
      ('user_profiles', 'user_id', 'user'),
      ('user_mfa_sessions', 'session_id', 'session'),
      ('user_mfa_sessions', 'user_id', 'user'),
      ('recipes', 'created_by', 'user')
    ) AS expected(table_name, column_name, target_table)
  LOOP
    SELECT c.data_type INTO actual_type FROM information_schema.columns c
      WHERE c.table_schema='public' AND c.table_name=expected.table_name AND c.column_name=expected.column_name;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Cannot apply UUID auth reference migration: expected column public.%.% is missing', expected.table_name, expected.column_name;
    END IF;
    IF actual_type NOT IN ('text', 'uuid') THEN
      RAISE EXCEPTION 'Cannot apply UUID auth reference migration: public.%.% has unsupported type %, expected text or uuid', expected.table_name, expected.column_name, actual_type;
    END IF;
  END LOOP;

  -- Check syntax before casts; compare against parent UUIDs after casting so
  -- canonical uppercase spellings are accepted as the same UUID value.
  IF (SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='user_roles' AND column_name='user_id') = 'text' THEN
    SELECT user_id INTO invalid_value FROM user_roles WHERE user_id IS NOT NULL AND user_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' LIMIT 1;
    IF FOUND THEN RAISE EXCEPTION 'Cannot convert user_roles.user_id to uuid: invalid value %', invalid_value; END IF;
    SELECT r.user_id INTO invalid_value FROM user_roles r WHERE NOT EXISTS (SELECT 1 FROM "user" u WHERE u.id = r.user_id::uuid) LIMIT 1;
    IF FOUND THEN RAISE EXCEPTION 'Cannot convert user_roles.user_id to uuid: orphaned value %', invalid_value; END IF;
  END IF;
  IF (SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='user_profiles' AND column_name='user_id') = 'text' THEN
    SELECT user_id INTO invalid_value FROM user_profiles WHERE user_id IS NOT NULL AND user_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' LIMIT 1;
    IF FOUND THEN RAISE EXCEPTION 'Cannot convert user_profiles.user_id to uuid: invalid value %', invalid_value; END IF;
    SELECT r.user_id INTO invalid_value FROM user_profiles r WHERE NOT EXISTS (SELECT 1 FROM "user" u WHERE u.id = r.user_id::uuid) LIMIT 1;
    IF FOUND THEN RAISE EXCEPTION 'Cannot convert user_profiles.user_id to uuid: orphaned value %', invalid_value; END IF;
  END IF;
  IF (SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='user_mfa_sessions' AND column_name='session_id') = 'text' THEN
    SELECT session_id INTO invalid_value FROM user_mfa_sessions WHERE session_id IS NOT NULL AND session_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' LIMIT 1;
    IF FOUND THEN RAISE EXCEPTION 'Cannot convert user_mfa_sessions.session_id to uuid: invalid value %', invalid_value; END IF;
    SELECT m.session_id INTO invalid_value FROM user_mfa_sessions m WHERE NOT EXISTS (SELECT 1 FROM "session" s WHERE s.id = m.session_id::uuid) LIMIT 1;
    IF FOUND THEN RAISE EXCEPTION 'Cannot convert user_mfa_sessions.session_id to uuid: orphaned value %', invalid_value; END IF;
  END IF;
  IF (SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='user_mfa_sessions' AND column_name='user_id') = 'text' THEN
    SELECT user_id INTO invalid_value FROM user_mfa_sessions WHERE user_id IS NOT NULL AND user_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' LIMIT 1;
    IF FOUND THEN RAISE EXCEPTION 'Cannot convert user_mfa_sessions.user_id to uuid: invalid value %', invalid_value; END IF;
    SELECT m.user_id INTO invalid_value FROM user_mfa_sessions m WHERE NOT EXISTS (SELECT 1 FROM "user" u WHERE u.id = m.user_id::uuid) LIMIT 1;
    IF FOUND THEN RAISE EXCEPTION 'Cannot convert user_mfa_sessions.user_id to uuid: orphaned value %', invalid_value; END IF;
  END IF;
  IF (SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='recipes' AND column_name='created_by') = 'text' THEN
    SELECT created_by INTO invalid_value FROM recipes WHERE created_by IS NOT NULL AND created_by !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' LIMIT 1;
    IF FOUND THEN RAISE EXCEPTION 'Cannot convert recipes.created_by to uuid: invalid value %', invalid_value; END IF;
    SELECT r.created_by INTO invalid_value FROM recipes r WHERE r.created_by IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "user" u WHERE u.id = r.created_by::uuid) LIMIT 1;
    IF FOUND THEN RAISE EXCEPTION 'Cannot convert recipes.created_by to uuid: orphaned value %', invalid_value; END IF;
  END IF;
END;
$$;

DO $$
DECLARE
  old_fk record;
BEGIN
  -- PostgreSQL requires dependent FKs to be removed for type changes. Keep the
  -- table and name together because constraint names are only table-unique.
  FOR old_fk IN
    SELECT conrelid::regclass AS table_name, conname
    FROM pg_constraint
    WHERE contype='f'
      AND conrelid IN (to_regclass('public.user_roles'), to_regclass('public.user_profiles'), to_regclass('public.user_mfa_sessions'), to_regclass('public.recipes'))
      AND confrelid IN (to_regclass('public.user'), to_regclass('public.session'))
      AND cardinality(conkey)=1
      AND (SELECT attname FROM pg_attribute WHERE attrelid=conrelid AND attnum=conkey[1]) IN ('user_id','session_id','created_by')
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', old_fk.table_name, old_fk.conname);
  END LOOP;

  IF (SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='user_roles' AND column_name='user_id') = 'text' THEN ALTER TABLE user_roles ALTER COLUMN user_id TYPE uuid USING user_id::uuid; END IF;
  IF (SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='user_profiles' AND column_name='user_id') = 'text' THEN ALTER TABLE user_profiles ALTER COLUMN user_id TYPE uuid USING user_id::uuid; END IF;
  IF (SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='user_mfa_sessions' AND column_name='session_id') = 'text' THEN ALTER TABLE user_mfa_sessions ALTER COLUMN session_id TYPE uuid USING session_id::uuid; END IF;
  IF (SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='user_mfa_sessions' AND column_name='user_id') = 'text' THEN ALTER TABLE user_mfa_sessions ALTER COLUMN user_id TYPE uuid USING user_id::uuid; END IF;
  IF (SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='recipes' AND column_name='created_by') = 'text' THEN ALTER TABLE recipes ALTER COLUMN created_by TYPE uuid USING created_by::uuid; END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.user_roles') AND contype='f' AND conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=to_regclass('public.user_roles') AND attname='user_id')]::smallint[] AND confrelid=to_regclass('public.user')) THEN ALTER TABLE user_roles ADD CONSTRAINT user_roles_user_id_fkey FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.user_profiles') AND contype='f' AND conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=to_regclass('public.user_profiles') AND attname='user_id')]::smallint[] AND confrelid=to_regclass('public.user')) THEN ALTER TABLE user_profiles ADD CONSTRAINT user_profiles_user_id_fkey FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.user_mfa_sessions') AND contype='f' AND conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=to_regclass('public.user_mfa_sessions') AND attname='session_id')]::smallint[] AND confrelid=to_regclass('public.session')) THEN ALTER TABLE user_mfa_sessions ADD CONSTRAINT user_mfa_sessions_session_id_fkey FOREIGN KEY (session_id) REFERENCES "session"(id) ON DELETE CASCADE; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.user_mfa_sessions') AND contype='f' AND conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=to_regclass('public.user_mfa_sessions') AND attname='user_id')]::smallint[] AND confrelid=to_regclass('public.user')) THEN ALTER TABLE user_mfa_sessions ADD CONSTRAINT user_mfa_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES "user"(id) ON DELETE CASCADE; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.recipes') AND contype='f' AND conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=to_regclass('public.recipes') AND attname='created_by')]::smallint[] AND confrelid=to_regclass('public.user')) THEN ALTER TABLE recipes ADD CONSTRAINT recipes_created_by_fkey FOREIGN KEY (created_by) REFERENCES "user"(id) ON DELETE SET NULL; END IF;
END;
$$;
