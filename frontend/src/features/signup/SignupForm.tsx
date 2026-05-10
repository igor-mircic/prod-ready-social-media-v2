import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'

import { useSignup } from '../../api/generated/queries/auth-controller/auth-controller'
import { SignupBody } from '../../api/generated/schemas/auth-controller/auth-controller.zod'
import { ApiError } from '../../api/client'

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
      <section aria-live="polite">
        <h2>Account created</h2>
        <p>Welcome, {created.displayName}.</p>
      </section>
    )
  }

  const apiErrorMessage =
    mutation.error instanceof ApiError
      ? (mutation.error.detail ?? mutation.error.title ?? mutation.error.message)
      : null

  return (
    <form onSubmit={onSubmit} noValidate>
      <h2>Create account</h2>

      <label>
        Email
        <input type="email" autoComplete="email" {...register('email')} />
      </label>
      {errors.email && <p role="alert">{errors.email.message}</p>}

      <label>
        Password
        <input type="password" autoComplete="new-password" {...register('password')} />
      </label>
      {errors.password && <p role="alert">{errors.password.message}</p>}

      <label>
        Display name
        <input type="text" autoComplete="nickname" {...register('displayName')} />
      </label>
      {errors.displayName && <p role="alert">{errors.displayName.message}</p>}

      <button type="submit" disabled={isSubmitting || mutation.isPending}>
        Sign up
      </button>

      {apiErrorMessage && <p role="alert">{apiErrorMessage}</p>}
    </form>
  )
}
