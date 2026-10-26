ALTER TABLE recipes
  ADD COLUMN IF NOT EXISTS instructions text NOT NULL DEFAULT '';

ALTER TABLE recipes
  DROP CONSTRAINT IF EXISTS recipes_instructions_length_check;

ALTER TABLE recipes
  ADD CONSTRAINT recipes_instructions_length_check CHECK (length(instructions) <= 12000);
