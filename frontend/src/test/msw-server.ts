// Node MSW server used by vitest. Imports the generated request handlers and
// exposes a `server` whose `use()` lets tests override individual handlers.

import { setupServer } from 'msw/node'
import { getAuthControllerMock } from '../api/generated/msw/auth-controller/auth-controller.msw'
import { getFollowsControllerMock } from '../api/generated/msw/follows-controller/follows-controller.msw'
import { getPostsControllerMock } from '../api/generated/msw/posts-controller/posts-controller.msw'

export const server = setupServer(
  ...getAuthControllerMock(),
  ...getPostsControllerMock(),
  ...getFollowsControllerMock(),
)
