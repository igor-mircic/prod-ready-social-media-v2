import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useNavigate } from 'react-router-dom'
import { z } from 'zod'

import { ApiError } from '@/api/client'
import { useLogin, me } from '@/api/generated/queries/auth-controller/auth-controller'
import { LoginBody } from '@/api/generated/schemas/auth-controller/auth-controller.zod'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
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
    <div className="flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>
            <h2 className="m-0 text-base font-medium leading-snug">Log in</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} noValidate>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="login-email">Email</FieldLabel>
                <Input
                  id="login-email"
                  type="email"
                  autoComplete="email"
                  aria-invalid={errors.email ? true : undefined}
                  {...register('email')}
                />
                <FieldError errors={errors.email ? [{ message: errors.email.message }] : []} />
              </Field>

              <Field>
                <FieldLabel htmlFor="login-password">Password</FieldLabel>
                <Input
                  id="login-password"
                  type="password"
                  autoComplete="current-password"
                  aria-invalid={errors.password ? true : undefined}
                  {...register('password')}
                />
                <FieldError
                  errors={errors.password ? [{ message: errors.password.message }] : []}
                />
              </Field>

              <Button type="submit" disabled={isSubmitting || mutation.isPending}>
                Log in
              </Button>

              {apiErrorMessage && (
                <p role="alert" className="text-sm text-destructive">
                  {apiErrorMessage}
                </p>
              )}
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
