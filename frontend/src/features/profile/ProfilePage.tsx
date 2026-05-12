import { useParams } from 'react-router-dom'

import { ApiError } from '@/api/client'
import { useGetUser } from '@/api/generated/queries/users-controller/users-controller'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

import { PostList } from '../posts/PostList'

export function ProfilePage() {
  const { userId } = useParams<{ userId: string }>()
  const safeUserId = userId ?? ''
  const userQuery = useGetUser(safeUserId)

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
        </Card>
        <PostList userId={safeUserId} />
      </div>
    </div>
  )
}
