import { Link } from 'react-router-dom'

import { ApiError } from '@/api/client'
import { useDeletePost } from '@/api/generated/queries/posts-controller/posts-controller'
import type { PostResponse } from '@/api/generated/queries/openAPIDefinition.schemas'
import { Button } from '@/components/ui/button'

import { useAuth } from '../auth/AuthContext'

interface PostCardProps {
  post: PostResponse
  onDeleteSuccess: () => void
}

function formatCreatedAt(value: string | undefined): string {
  if (!value) return ''
  try {
    return new Date(value).toLocaleString()
  } catch {
    return value
  }
}

export function PostCard({ post, onDeleteSuccess }: PostCardProps) {
  const auth = useAuth()
  const isOwnPost = !!post.author?.id && post.author.id === auth.currentUser?.id

  const deleteMutation = useDeletePost({
    mutation: {
      onSuccess: () => {
        onDeleteSuccess()
      },
    },
  })

  const handleDelete = () => {
    if (!post.id) return
    deleteMutation.mutate({ id: post.id })
  }

  const apiErrorMessage =
    deleteMutation.error instanceof ApiError
      ? (deleteMutation.error.detail ??
        deleteMutation.error.title ??
        deleteMutation.error.message)
      : null

  return (
    <article
      data-post-id={post.id}
      aria-label="Post"
      className="flex flex-col gap-2 rounded-md border border-input bg-card p-4 shadow-xs"
    >
      <header className="flex items-baseline justify-between gap-3">
        <p className="text-sm font-medium leading-snug">
          {post.author?.id ? (
            <Link
              to={`/users/${post.author.id}`}
              className="underline-offset-4 hover:underline"
            >
              {post.author.displayName ?? 'Unknown'}
            </Link>
          ) : (
            (post.author?.displayName ?? 'Unknown')
          )}
        </p>
        <time
          className="text-xs text-muted-foreground"
          dateTime={post.createdAt}
        >
          {formatCreatedAt(post.createdAt)}
        </time>
      </header>
      <p className="whitespace-pre-wrap break-words text-sm">
        {post.body ?? ''}
      </p>
      {isOwnPost && (
        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleDelete}
            disabled={deleteMutation.isPending}
            aria-label={`Delete post`}
          >
            Delete
          </Button>
          {apiErrorMessage && (
            <p role="alert" className="text-sm text-destructive">
              {apiErrorMessage}
            </p>
          )}
        </div>
      )}
    </article>
  )
}
