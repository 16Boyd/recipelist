ALTER TABLE "user" ADD COLUMN IF NOT EXISTS mfa_enabled_at timestamptz;

CREATE TABLE IF NOT EXISTS user_roles (
  user_id uuid PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_profiles (
  user_id uuid PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  app_data jsonb NOT NULL DEFAULT '{"recipes":[],"pantry":["garlic","spinach","couscous","chickpeas","plain yogurt","lemon","cucumber","dill","olive oil"],"shopping":[{"id":"shop-parmesan","name":"parmesan","checked":false},{"id":"shop-oats","name":"rolled oats","checked":true}]}'::jsonb,
  schema_version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS recipes (
  id text PRIMARY KEY,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  source text NOT NULL CHECK (length(source) BETWEEN 1 AND 100),
  category text NOT NULL CHECK (length(category) BETWEEN 1 AND 80),
  time integer NOT NULL CHECK (time BETWEEN 1 AND 1440),
  servings integer NOT NULL CHECK (servings BETWEEN 1 AND 100),
  image text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  ingredients jsonb NOT NULL CHECK (jsonb_typeof(ingredients) = 'array'),
  created_by uuid REFERENCES "user"(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS recipes_title_idx ON recipes USING gin (to_tsvector('simple', title));

CREATE OR REPLACE FUNCTION create_recipe_list_user_rows()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO user_roles(user_id, role) VALUES (NEW.id, 'member') ON CONFLICT (user_id) DO NOTHING;
  INSERT INTO user_profiles(user_id) VALUES (NEW.id) ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS recipe_list_user_after_insert ON "user";
CREATE TRIGGER recipe_list_user_after_insert
AFTER INSERT ON "user"
FOR EACH ROW EXECUTE FUNCTION create_recipe_list_user_rows();

INSERT INTO user_roles(user_id, role)
SELECT id, 'member' FROM "user"
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO user_profiles(user_id)
SELECT id FROM "user"
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO recipes(id, title, source, category, time, servings, image, description, ingredients)
VALUES
('tomato-orzo', 'Creamy Sun-Dried Tomato Orzo', 'HelloFresh', 'Pasta', 25, 2, 'https://images.unsplash.com/photo-1473093295043-cdd812d0e601?auto=format&fit=crop&w=1100&q=85', 'A silky one-pan orzo with bright tomato, greens, and a little parmesan.', '[{"name":"orzo","amount":"1 cup"},{"name":"sun-dried tomatoes","amount":"⅓ cup"},{"name":"spinach","amount":"2 cups"},{"name":"heavy cream","amount":"½ cup"},{"name":"garlic","amount":"2 cloves"},{"name":"vegetable stock","amount":"2 cups"},{"name":"parmesan","amount":"¼ cup"}]'::jsonb),
('chickpea-bowls', 'Crispy Chickpea Green Bowls', 'Home Chef', 'Vegetarian', 30, 2, 'https://images.unsplash.com/photo-1512621776951-a57141f2eefd?auto=format&fit=crop&w=1100&q=85', 'Herby couscous, crunchy chickpeas, and cool cucumber yogurt.', '[{"name":"chickpeas","amount":"1 can"},{"name":"couscous","amount":"1 cup"},{"name":"cucumber","amount":"1"},{"name":"plain yogurt","amount":"½ cup"},{"name":"lemon","amount":"1"},{"name":"dill","amount":"2 tbsp"}]'::jsonb),
('miso-salmon', 'Miso-Glazed Salmon & Rice', 'Blue Apron', 'Seafood', 35, 2, 'https://images.unsplash.com/photo-1519708227418-c8fd9a32b7a2?auto=format&fit=crop&w=1100&q=85', 'Sweet-salty miso salmon with fluffy rice and quick pickled cucumber.', '[{"name":"salmon","amount":"2 fillets"},{"name":"white rice","amount":"1 cup"},{"name":"white miso","amount":"2 tbsp"},{"name":"honey","amount":"1 tbsp"},{"name":"cucumber","amount":"1"},{"name":"rice vinegar","amount":"2 tbsp"}]'::jsonb),
('lemon-chicken', 'Lemony Chicken & Crispy Potatoes', 'Marley Spoon', 'Chicken', 40, 2, 'https://images.unsplash.com/photo-1532550907401-a500c9a57435?auto=format&fit=crop&w=1100&q=85', 'Golden chicken, smashed potatoes, and a fresh lemon pan sauce.', '[{"name":"chicken breast","amount":"2"},{"name":"baby potatoes","amount":"1 lb"},{"name":"lemon","amount":"1"},{"name":"green beans","amount":"8 oz"},{"name":"chicken stock","amount":"½ cup"},{"name":"butter","amount":"2 tbsp"}]'::jsonb),
('mushroom-tacos', 'Smoky Mushroom Tacos', 'Dinnerly', 'Vegetarian', 20, 2, 'https://images.unsplash.com/photo-1551500566-9c6f5f7cbb6a?auto=format&fit=crop&w=1100&q=85', 'Quick charred mushrooms with avocado, lime, and a smoky spice blend.', '[{"name":"mushrooms","amount":"8 oz"},{"name":"corn tortillas","amount":"6"},{"name":"avocado","amount":"1"},{"name":"lime","amount":"1"},{"name":"smoked paprika","amount":"1 tsp"},{"name":"red onion","amount":"½"}]'::jsonb),
('sausage-peppers', 'Sausage, Pepper & Tomato Skillet', 'HelloFresh', 'One-pan', 30, 4, 'https://images.unsplash.com/photo-1547592180-85f173990554?auto=format&fit=crop&w=1100&q=85', 'A weeknight skillet with browned sausage, peppers, and warm spices.', '[{"name":"Italian sausage","amount":"1 lb"},{"name":"bell pepper","amount":"2"},{"name":"crushed tomatoes","amount":"1 can"},{"name":"yellow onion","amount":"1"},{"name":"garlic","amount":"2 cloves"},{"name":"couscous","amount":"1 cup"}]'::jsonb)
ON CONFLICT (id) DO NOTHING;
