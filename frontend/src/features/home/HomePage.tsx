import { useNavigate } from 'react-router-dom'

import { useLogout, useMe } from '@/api/generated/queries/auth-controller/auth-controller'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useAuth } from '../auth/AuthContext'
import { PostComposer } from '../posts/PostComposer'
import { PostList } from '../posts/PostList'

export function HomePage() {
  const navigate = useNavigate()
  const auth = useAuth()
  const meQuery = useMe()
  const logoutMutation = useLogout({
    mutation: {
      onSettled: () => {
        auth.logout()
        navigate('/login')
      },
    },
  })

  if (meQuery.isLoading) {
    return (
      <div className="flex min-h-svh items-center justify-center p-6">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    )
  }

  if (meQuery.isError || !meQuery.data || meQuery.data.status !== 200) {
    return (
      <div className="flex min-h-svh items-center justify-center p-6">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>
              <h2 className="m-0 text-base font-medium leading-snug">Profile unavailable</h2>
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p role="alert" className="text-sm text-destructive">
              Could not load your profile.
            </p>
            <Button
              type="button"
              variant="outline"
              onClick={() => logoutMutation.mutate()}
              disabled={logoutMutation.isPending}
            >
              Log out
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  const user = meQuery.data.data
  const userId = user.id ?? ''

  return (
    <div className="flex min-h-svh justify-center p-6">
      <div className="flex w-full max-w-xl flex-col gap-6">
        <Card className="w-full">
          <CardHeader>
            <CardTitle>
              <h1 className="m-0 text-lg font-medium leading-snug">
                Hello, {user.displayName}
              </h1>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Button
              type="button"
              variant="outline"
              onClick={() => logoutMutation.mutate()}
              disabled={logoutMutation.isPending}
            >
              Log out
            </Button>
          </CardContent>
        </Card>
        <PostComposer authorUserId={userId} />
        <PostList userId={userId} />
      </div>
    </div>
  )
}
