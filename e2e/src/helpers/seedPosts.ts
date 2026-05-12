import type { ApiClient } from './apiClient.ts'
import type { PostResponse } from '../api/generated/openAPIDefinition.schemas.ts'

export type BodyAt = (i: number) => string

const defaultBodyAt: BodyAt = (i) => `Seeded post ${i.toString().padStart(2, '0')}`

export async function seedPosts(
  apiClient: ApiClient,
  token: string,
  count: number,
  bodyAt: BodyAt = defaultBodyAt,
): Promise<PostResponse[]> {
  const created: PostResponse[] = []
  for (let i = 1; i <= count; i++) {
    const body = bodyAt(i)
    const result = await apiClient.createPost(token, { body })
    if (result.status !== 201) {
      throw new Error(
        `seedPosts: createPost ${i} expected 201 but got ${result.status}: ${JSON.stringify(result.body)}`,
      )
    }
    created.push(result.body as PostResponse)
  }
  return created
}
