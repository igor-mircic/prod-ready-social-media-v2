import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'

import { ApiError } from '@/api/client'
import { useCreatePost } from '@/api/generated/queries/posts-controller/posts-controller'
import { CreatePostBody } from '@/api/generated/schemas/posts-controller/posts-controller.zod'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'

import { useAuth } from '../auth/AuthContext'
import { postsByAuthorListKeyPrefix } from './postQueryKeys'

// The generated zod schema only enforces `min(0)`; tighten it to
// `@NotBlank` so the form blocks empty/whitespace bodies before they reach
// the server.
const ComposerSchema = CreatePostBody.extend({
  body: CreatePostBody.shape.body.refine((s) => s.trim().length > 0, {
    message: 'Body is required',
  }),
})

type ComposerFormValues = z.infer<typeof ComposerSchema>

interface PostComposerProps {
  authorUserId: string
}

export function PostComposer({ authorUserId }: PostComposerProps) {
  const auth = useAuth()
  const queryClient = useQueryClient()
  const ownerId = authorUserId ?? auth.currentUser?.id

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting, isValid },
  } = useForm<ComposerFormValues>({
    resolver: zodResolver(ComposerSchema),
    mode: 'onChange',
    defaultValues: { body: '' },
  })

  const mutation = useCreatePost({
    mutation: {
      onSuccess: () => {
        if (ownerId) {
          queryClient.invalidateQueries({ queryKey: postsByAuthorListKeyPrefix(ownerId) })
        }
        reset({ body: '' })
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
    <Card className="w-full max-w-xl">
      <CardHeader>
        <CardTitle>
          <h2 className="m-0 text-base font-medium leading-snug">New post</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} noValidate aria-label="New post">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="post-body">Body</FieldLabel>
              <textarea
                id="post-body"
                rows={3}
                maxLength={500}
                aria-invalid={errors.body ? true : undefined}
                className="flex min-h-[80px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                placeholder="What's on your mind?"
                {...register('body')}
              />
              <FieldError errors={errors.body ? [{ message: errors.body.message }] : []} />
            </Field>

            <Button type="submit" disabled={!isValid || isSubmitting || mutation.isPending}>
              Post
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
  )
}
