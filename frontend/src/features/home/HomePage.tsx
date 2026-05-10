import { useNavigate } from 'react-router-dom'

import { useLogout, useMe } from '../../api/generated/queries/auth-controller/auth-controller'
import { useAuth } from '../auth/AuthContext'

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
    return <p>Loading…</p>
  }

  if (meQuery.isError || !meQuery.data || meQuery.data.status !== 200) {
    return (
      <section>
        <p role="alert">Could not load your profile.</p>
        <button type="button" onClick={() => logoutMutation.mutate()}>
          Log out
        </button>
      </section>
    )
  }

  const user = meQuery.data.data

  return (
    <section>
      <h1>Hello, {user.displayName}</h1>
      <button type="button" onClick={() => logoutMutation.mutate()}>
        Log out
      </button>
    </section>
  )
}
