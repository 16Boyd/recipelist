UPDATE recipes
SET instructions = '1. Dry-toast the orzo in a dry nonstick skillet for 1 minute, then stir in minced garlic and chopped sun-dried tomatoes.
2. Add vegetable stock, bring to a simmer, and cook, stirring often, until the orzo is tender and most liquid is absorbed.
3. Stir in cream and spinach until the spinach wilts; finish with parmesan and serve.'
WHERE id = 'tomato-orzo' AND btrim(instructions, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') = '';

UPDATE recipes
SET instructions = '1. Drain and dry the chickpeas; toast in a dry skillet over medium heat, stirring often, until golden and crisp.
2. Cover couscous with boiling water, cover, and let stand 5 minutes; fluff with a fork.
3. Mix yogurt with lemon juice and chopped dill. Serve couscous and chickpeas with diced cucumber and lemon-dill yogurt.'
WHERE id = 'chickpea-bowls' AND btrim(instructions, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') = '';

UPDATE recipes
SET instructions = '1. Cook the rice according to its package directions. Thinly slice the cucumber and toss with rice vinegar; set aside.
2. Stir miso and honey together, then spread over the salmon fillets.
3. Bake at 400°F until the thickest part of each fillet reaches 145°F, about 10–15 minutes. Serve with rice and pickled cucumber.'
WHERE id = 'miso-salmon' AND btrim(instructions, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') = '';

UPDATE recipes
SET instructions = '1. Heat the oven to 425°F. Halve the potatoes and roast cut-side down until crisp and tender, about 25 minutes. Gently press each half with a fork, then roast 5 minutes more to crisp the edges.
2. Melt 1 tablespoon butter in a skillet and sear the chicken until golden on both sides. Add chicken stock, cover, and cook gently until the center reaches 165°F; transfer to a plate to rest.
3. Simmer green beans in the same skillet until tender-crisp. Stir in lemon juice and the remaining butter, then simmer briefly to reduce the pan sauce. Serve with the chicken and smashed potatoes.'
WHERE id = 'lemon-chicken' AND btrim(instructions, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') = '';

UPDATE recipes
SET instructions = '1. Thinly slice the mushrooms and red onion. Cook in a hot dry skillet until the mushrooms brown and release their moisture.
2. Stir in smoked paprika and a squeeze of lime; cook 1 minute more.
3. Warm the tortillas in a dry skillet. Fill with mushrooms, sliced avocado, and red onion; finish with more lime.'
WHERE id = 'mushroom-tacos' AND btrim(instructions, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') = '';

UPDATE recipes
SET instructions = '1. Heat a large skillet over medium heat. Brown the sausage, breaking it into bite-size pieces; drain excess fat if needed.
2. Add sliced onion and bell pepper and cook until softened. Stir in minced garlic for 30 seconds, then add crushed tomatoes and simmer until the sausage is cooked through.
3. Prepare couscous according to its package directions and serve the tomato-sausage skillet over it.'
WHERE id = 'sausage-peppers' AND btrim(instructions, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') = '';
