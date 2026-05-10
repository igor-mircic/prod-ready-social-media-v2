import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useNavigate } from 'react-router-dom'
import { z } from 'zod'

import { ApiError } from '../../api/client'
import { useLogin, me } from '../../api/generated/queries/auth-controller/auth-controller'
import { LoginBody } from '../../api/generated/schemas/auth-controller/auth-controller.zod'
import { useAuth } from '../auth/AuthContext'

type LoginFormValues = z.infer<typeof LoginBody>

export function LoginForm() {
  const navigate = useNavigate()
  const auth = useAuth()

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginFormValues>({
    resolver: zodResolver(LoginBody),
    mode: 'onSubmit',
  })

  const mutation = useLogin({
    mutation: {
      onSuccess: async (result) => {
        if (result.status !== 200) return
        const token = result.data.accessToken
        auth.setAccessToken(token)
        const meResult = await me()
        if (meResult.status === 200 && meResult.data) {
          auth.login(token, {
            id: meResult.data.id,
            email: meResult.data.email,
            displayName: meResult.data.displayName,
            createdAt: meResult.data.createdAt,
          })
          navigate('/home')
        }
      },
    },
  })

  const onSubmit = handleSubmit((values) => {
    mutation.mutate({ data: values })
  })

  const apiErrorMessage =
    mutation.error instanceof ApiError
      ? (mutation.error.detail ?? mutation.error.title ?? mutation.error.message)
      : null

  return (
    <form onSubmit={onSubmit} noValidate>
      <h2>Log in</h2>

      <label>
        Email
        <input type="email" autoComplete="email" {...register('email')} />
      </label>
      {errors.email && <p role="alert">{errors.email.message}</p>}

      <label>
        Password
        <input type="password" autoComplete="current-password" {...register('password')} />
      </label>
      {errors.password && <p role="alert">{errors.password.message}</p>}

      <button type="submit" disabled={isSubmitting || mutation.isPending}>
        Log in
      </button>

      {apiErrorMessage && <p role="alert">{apiErrorMessage}</p>}
    </form>
  )
}
