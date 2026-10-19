<img src="assets/icon.svg" width="48" height="48" alt="RecipeList">

# RecipeList

RecipeList is a small recipe and pantry planner. Browse a sample recipe library, track ingredients on hand, see which dinners are closest to ready, and turn missing ingredients into a shopping list.

## Run locally

```sh
npm install
npm run dev
```

Create a production build with `npm run build`.

## MVP notes

- Recipes can be added manually and tagged with a meal service or source.
- Pantry, recipe, and shopping list data is saved in this browser using local storage.
- The included recipes are short demo entries for exploring the matching flow; RecipeList is not affiliated with any meal service.
- The sample library and pantry can be restored by clearing the `recipelist.app-data.v1` local storage entry.
