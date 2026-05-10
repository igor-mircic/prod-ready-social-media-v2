import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'

import { ApiError } from '@/api/client'
import { useSignup } from '@/api/generated/queries/auth-controller/auth-controller'
import { SignupBody } from '@/api/generated/schemas/auth-controller/auth-controller.zod'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'

type SignupFormValues = z.infer<typeof SignupBody>

export function SignupForm() {
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SignupFormValues>({
    resolver: zodResolver(SignupBody),
    mode: 'onSubmit',
  })

  const mutation = useSignup()

  const onSubmit = handleSubmit((values) => {
    mutation.mutate({ data: values })
  })

  if (mutation.isSuccess && mutation.data.status === 201) {
    const created = mutation.data.data
    return (
      <div className="flex min-h-svh items-center justify-center p-6">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>
              <h2 className="m-0 text-base font-medium leading-snug">Account created</h2>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <section aria-live="polite">
              <p className="text-sm text-muted-foreground">Welcome, {created.displayName}.</p>
            </section>
          </CardContent>
        </Card>
      </div>
    )
  }

  const apiErrorMessage =
    mutation.error instanceof ApiError
      ? (mutation.error.detail ?? mutation.error.title ?? mutation.error.message)
      : null

  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>
            <h2 className="m-0 text-base font-medium leading-snug">Create account</h2>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} noValidate>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="signup-email">Email</FieldLabel>
                <Input
                  id="signup-email"
                  type="email"
                  autoComplete="email"
                  aria-invalid={errors.email ? true : undefined}
                  {...register('email')}
                />
                <FieldError errors={errors.email ? [{ message: errors.email.message }] : []} />
              </Field>

              <Field>
                <FieldLabel htmlFor="signup-password">Password</FieldLabel>
                <Input
                  id="signup-password"
                  type="password"
                  autoComplete="new-password"
                  aria-invalid={errors.password ? true : undefined}
                  {...register('password')}
                />
                <FieldError
                  errors={errors.password ? [{ message: errors.password.message }] : []}
                />
              </Field>

              <Field>
                <FieldLabel htmlFor="signup-display-name">Display name</FieldLabel>
                <Input
                  id="signup-display-name"
                  type="text"
                  autoComplete="nickname"
                  aria-invalid={errors.displayName ? true : undefined}
                  {...register('displayName')}
                />
                <FieldError
                  errors={
                    errors.displayName ? [{ message: errors.displayName.message }] : []
                  }
                />
              </Field>

              <Button type="submit" disabled={isSubmitting || mutation.isPending}>
                Sign up
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
