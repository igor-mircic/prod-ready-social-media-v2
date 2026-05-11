import { useInfiniteQuery } from '@tanstack/react-query'

import { ApiError } from '@/api/client'
import {
  getListPostsByAuthorQueryKey,
  listPostsByAuthor,
  type listPostsByAuthorResponse,
} from '@/api/generated/queries/posts-controller/posts-controller'
import type {
  PostListResponse,
  PostResponse,
} from '@/api/generated/queries/openAPIDefinition.schemas'
import { Button } from '@/components/ui/button'

import { PostCard } from './PostCard'

interface PostListProps {
  userId: string
}

function extractPage(response: listPostsByAuthorResponse): PostListResponse | null {
  if (response.status === 200) {
    return response.data
  }
  return null
}

export function PostList({ userId }: PostListProps) {
  const query = useInfiniteQuery({
    queryKey: getListPostsByAuthorQueryKey(userId),
    queryFn: ({ pageParam }) => {
      const params = pageParam ? { cursor: pageParam as string } : undefined
      return listPostsByAuthor(userId, params)
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => extractPage(lastPage)?.nextCursor ?? undefined,
  })

  if (query.isLoading) {
    return (
      <section aria-label="Posts" aria-busy="true">
        <p className="text-sm text-muted-foreground">Loading posts…</p>
      </section>
    )
  }

  if (query.isError) {
    const message =
      query.error instanceof ApiError
        ? (query.error.detail ?? query.error.title ?? query.error.message)
        : 'Could not load posts.'
    return (
      <section aria-label="Posts">
        <p role="alert" className="text-sm text-destructive">
          {message}
        </p>
      </section>
    )
  }

  const items: PostResponse[] =
    query.data?.pages.flatMap((p) => extractPage(p)?.items ?? []) ?? []

  if (items.length === 0) {
    return (
      <section aria-label="Posts">
        <p className="text-sm text-muted-foreground">No posts yet.</p>
      </section>
    )
  }

  return (
    <section aria-label="Posts" className="flex flex-col gap-3">
      {items.map((post) => (
        <PostCard key={post.id} post={post} listOwnerId={userId} />
      ))}
      {query.hasNextPage && (
        <Button
          type="button"
          variant="outline"
          onClick={() => query.fetchNextPage()}
          disabled={query.isFetchingNextPage}
        >
          {query.isFetchingNextPage ? 'Loading…' : 'Load more'}
        </Button>
      )}
    </section>
  )
}
