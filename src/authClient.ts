import { createAuthClient } from 'better-auth/react'
import { twoFactorClient } from 'better-auth/client/plugins'

// Auth is served by the same local RecipeList server as the app and its data.
export const authClient = createAuthClient({
  plugins: [twoFactorClient()],
})

export type AuthUser = {
  id: string
  email: string
  name?: string
}
