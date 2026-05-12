import { getSignupUrl, getLoginUrl } from '../api/generated/auth-controller/auth-controller.ts'
import {
  getCreatePostUrl,
  getListPostsByAuthorUrl,
  getDeletePostUrl,
} from '../api/generated/posts-controller/posts-controller.ts'
import type {
  SignupRequest,
  UserResponse,
  LoginRequest,
  LoginResponse,
  CreatePostRequest,
  PostResponse,
  PostListResponse,
  ProblemDetail,
} from '../api/generated/openAPIDefinition.schemas.ts'

export interface SignupResult {
  status: number
  body: UserResponse | ProblemDetail
}

export interface LoginResult {
  status: number
  body: LoginResponse | ProblemDetail
}

export interface ListPostsByAuthorResult {
  status: number
  body: PostListResponse | ProblemDetail
}

export interface CreatePostResult {
  status: number
  body: PostResponse | ProblemDetail
}

export interface DeletePostResult {
  status: number
  body: ProblemDetail | Record<string, never>
}

export interface ApiClient {
  baseURL: string
  signup(input: SignupRequest): Promise<SignupResult>
  login(input: LoginRequest): Promise<LoginResult>
  listPostsByAuthor(token: string, authorId: string): Promise<ListPostsByAuthorResult>
  createPost(token: string, input: CreatePostRequest): Promise<CreatePostResult>
  deletePost(token: string, postId: string): Promise<DeletePostResult>
}

export function createApiClient(baseURL: string): ApiClient {
  return {
    baseURL,
    async signup(input: SignupRequest): Promise<SignupResult> {
      const res = await fetch(`${baseURL}${getSignupUrl()}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, application/problem+json',
        },
        body: JSON.stringify(input),
      })
      const text = await res.text()
      const body = text.length > 0 ? JSON.parse(text) : {}
      return { status: res.status, body }
    },
    async login(input: LoginRequest): Promise<LoginResult> {
      const res = await fetch(`${baseURL}${getLoginUrl()}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, application/problem+json',
        },
        body: JSON.stringify(input),
      })
      const text = await res.text()
      const body = text.length > 0 ? JSON.parse(text) : {}
      return { status: res.status, body }
    },
    async listPostsByAuthor(token: string, authorId: string): Promise<ListPostsByAuthorResult> {
      const res = await fetch(`${baseURL}${getListPostsByAuthorUrl(authorId)}`, {
        method: 'GET',
        headers: {
          Accept: 'application/json, application/problem+json',
          Authorization: `Bearer ${token}`,
        },
      })
      const text = await res.text()
      const body = text.length > 0 ? JSON.parse(text) : {}
      return { status: res.status, body }
    },
    async createPost(token: string, input: CreatePostRequest): Promise<CreatePostResult> {
      const res = await fetch(`${baseURL}${getCreatePostUrl()}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, application/problem+json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(input),
      })
      const text = await res.text()
      const body = text.length > 0 ? JSON.parse(text) : {}
      return { status: res.status, body }
    },
    async deletePost(token: string, postId: string): Promise<DeletePostResult> {
      const res = await fetch(`${baseURL}${getDeletePostUrl(postId)}`, {
        method: 'DELETE',
        headers: {
          Accept: 'application/json, application/problem+json',
          Authorization: `Bearer ${token}`,
        },
      })
      const text = await res.text()
      const body = text.length > 0 ? JSON.parse(text) : {}
      return { status: res.status, body }
    },
  }
}
