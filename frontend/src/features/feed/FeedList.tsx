import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'

import { ApiError } from '@/api/client'
import {
  getFeed,
  getGetFeedQueryKey,
  type getFeedResponse,
} from '@/api/generated/queries/feed-controller/feed-controller'
import type {
  PostListResponse,
  PostResponse,
} from '@/api/generated/queries/openAPIDefinition.schemas'
import { Button } from '@/components/ui/button'

import { PostCard } from '../posts/PostCard'

function extractPage(response: getFeedResponse): PostListResponse | null {
  if (response.status === 200) {
    return response.data
  }
  return null
}

export function FeedList() {
  const queryClient = useQueryClient()
  const query = useInfiniteQuery({
    queryKey: getGetFeedQueryKey(),
    queryFn: ({ pageParam }) => {
      const params = pageParam ? { cursor: pageParam as string } : undefined
      return getFeed(params)
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      extractPage(lastPage)?.nextCursor ?? undefined,
  })

  const onFeedItemDeleted = () =>
    queryClient.invalidateQueries({ queryKey: getGetFeedQueryKey() })

  if (query.isLoading) {
    return (
      <section aria-label="Feed" aria-busy="true">
        <p className="text-sm text-muted-foreground">Loading feed…</p>
      </section>
    )
  }

  if (query.isError) {
    const message =
      query.error instanceof ApiError
        ? (query.error.detail ?? query.error.title ?? query.error.message)
        : 'Could not load feed.'
    return (
      <section aria-label="Feed">
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
      <section aria-label="Feed">
        <p className="text-sm text-muted-foreground">No posts yet.</p>
      </section>
    )
  }

  return (
    <section aria-label="Feed" className="flex flex-col gap-3">
      {items.map((post) => (
        <PostCard
          key={post.id}
          post={post}
          onDeleteSuccess={onFeedItemDeleted}
        />
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
