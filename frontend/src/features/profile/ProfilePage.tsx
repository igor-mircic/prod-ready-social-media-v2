import { useQueryClient } from '@tanstack/react-query'
import { useParams } from 'react-router-dom'

import { ApiError } from '@/api/client'
import {
  getGetFollowStatsQueryKey,
  useFollowUser,
  useGetFollowStats,
  useUnfollowUser,
} from '@/api/generated/queries/follows-controller/follows-controller'
import { useGetUser } from '@/api/generated/queries/users-controller/users-controller'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

import { useAuth } from '../auth/AuthContext'
import { PostList } from '../posts/PostList'

export function ProfilePage() {
  const { userId } = useParams<{ userId: string }>()
  const safeUserId = userId ?? ''
  const auth = useAuth()
  const queryClient = useQueryClient()
  const userQuery = useGetUser(safeUserId)
  const statsQuery = useGetFollowStats(safeUserId)

  const isOwnProfile =
    !!auth.currentUser?.id && auth.currentUser.id === safeUserId

  const invalidateStats = () =>
    queryClient.invalidateQueries({
      queryKey: getGetFollowStatsQueryKey(safeUserId),
    })

  const followMutation = useFollowUser({
    mutation: { onSuccess: invalidateStats },
  })
  const unfollowMutation = useUnfollowUser({
    mutation: { onSuccess: invalidateStats },
  })

  const isNotFound =
    userQuery.isError &&
    userQuery.error instanceof ApiError &&
    userQuery.error.status === 404

  if (isNotFound) {
    return (
      <div className="flex min-h-svh items-center justify-center p-6">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>
              <h2 className="m-0 text-base font-medium leading-snug">
                User not found
              </h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p role="alert" className="text-sm text-muted-foreground">
              No user exists with that id.
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (userQuery.isError) {
    const message =
      userQuery.error instanceof ApiError
        ? (userQuery.error.detail ??
          userQuery.error.title ??
          userQuery.error.message)
        : 'Could not load this profile.'
    return (
      <div className="flex min-h-svh items-center justify-center p-6">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>
              <h2 className="m-0 text-base font-medium leading-snug">
                Profile unavailable
              </h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p role="alert" className="text-sm text-destructive">
              {message}
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  const headerText =
    userQuery.isLoading || !userQuery.data || userQuery.data.status !== 200
      ? '…'
      : (userQuery.data.data.displayName ?? '')

  const stats =
    statsQuery.data && statsQuery.data.status === 200
      ? statsQuery.data.data
      : null
  const statsError = statsQuery.isError
  const followers = stats?.followers ?? 0
  const following = stats?.following ?? 0
  const viewerFollows = stats?.viewerFollows ?? false
  const isMutating = followMutation.isPending || unfollowMutation.isPending

  const handleToggleFollow = () => {
    if (isMutating) return
    if (viewerFollows) {
      unfollowMutation.mutate({ userId: safeUserId })
    } else {
      followMutation.mutate({ userId: safeUserId })
    }
  }

  return (
    <div className="flex min-h-svh justify-center p-6">
      <div className="flex w-full max-w-xl flex-col gap-6">
        <Card className="w-full">
          <CardHeader>
            <CardTitle>
              <h1 className="m-0 text-lg font-medium leading-snug">
                {headerText}
              </h1>
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {stats ? (
              <p className="text-sm text-muted-foreground">
                <strong>{followers}</strong>{' '}
                {followers === 1 ? 'follower' : 'followers'} ·{' '}
                <strong>{following}</strong> following
              </p>
            ) : (
              <p
                aria-hidden="true"
                className="h-5 w-40 animate-pulse rounded bg-muted"
              />
            )}
            {statsError && (
              <p role="alert" className="text-sm text-destructive">
                Could not load follow stats.
              </p>
            )}
            {!isOwnProfile &&
              (stats ? (
                <div>
                  <Button
                    type="button"
                    variant={viewerFollows ? 'outline' : 'default'}
                    size="sm"
                    onClick={handleToggleFollow}
                    disabled={isMutating}
                  >
                    {viewerFollows ? 'Unfollow' : 'Follow'}
                  </Button>
                </div>
              ) : (
                <span
                  aria-hidden="true"
                  className="inline-block h-8 w-24 animate-pulse rounded bg-muted"
                />
              ))}
          </CardContent>
        </Card>
        <PostList userId={safeUserId} />
      </div>
    </div>
  )
}
