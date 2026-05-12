import {
  getSignupUrl,
  getLoginUrl,
} from '../api/generated/auth-controller/auth-controller.ts'
import { getGetFeedUrl } from '../api/generated/feed-controller/feed-controller.ts'
import {
  getFollowUserUrl,
  getUnfollowUserUrl,
  getGetFollowStatsUrl,
} from '../api/generated/follows-controller/follows-controller.ts'
import {
  getCreatePostUrl,
  getListPostsByAuthorUrl,
  getDeletePostUrl,
} from '../api/generated/posts-controller/posts-controller.ts'
import { getGetUserUrl } from '../api/generated/users-controller/users-controller.ts'
import type {
  SignupRequest,
  UserResponse,
  UserSummary,
  LoginRequest,
  LoginResponse,
  CreatePostRequest,
  PostResponse,
  PostListResponse,
  ListPostsByAuthorParams,
  FollowStatsResponse,
  GetFeedParams,
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

export interface GetUserResult {
  status: number
  body: UserSummary | ProblemDetail
}

export interface FollowResult {
  status: number
  body: ProblemDetail | Record<string, never>
}

export interface UnfollowResult {
  status: number
  body: ProblemDetail | Record<string, never>
}

export interface GetFollowStatsResult {
  status: number
  body: FollowStatsResponse | ProblemDetail
}

export interface GetFeedResult {
  status: number
  body: PostListResponse | ProblemDetail
}

export interface ApiClient {
  baseURL: string
  signup(input: SignupRequest): Promise<SignupResult>
  login(input: LoginRequest): Promise<LoginResult>
  listPostsByAuthor(
    token: string,
    authorId: string,
    params?: ListPostsByAuthorParams,
  ): Promise<ListPostsByAuthorResult>
  createPost(token: string, input: CreatePostRequest): Promise<CreatePostResult>
  deletePost(token: string, postId: string): Promise<DeletePostResult>
  getUser(token: string, userId: string): Promise<GetUserResult>
  follow(token: string, userId: string): Promise<FollowResult>
  unfollow(token: string, userId: string): Promise<UnfollowResult>
  getFollowStats(token: string, userId: string): Promise<GetFollowStatsResult>
  getFeed(token: string, params?: GetFeedParams): Promise<GetFeedResult>
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
    async listPostsByAuthor(
      token: string,
      authorId: string,
      params?: ListPostsByAuthorParams,
    ): Promise<ListPostsByAuthorResult> {
      const res = await fetch(
        `${baseURL}${getListPostsByAuthorUrl(authorId, params)}`,
        {
          method: 'GET',
          headers: {
            Accept: 'application/json, application/problem+json',
            Authorization: `Bearer ${token}`,
          },
        },
      )
      const text = await res.text()
      const body = text.length > 0 ? JSON.parse(text) : {}
      return { status: res.status, body }
    },
    async createPost(
      token: string,
      input: CreatePostRequest,
    ): Promise<CreatePostResult> {
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
    async getUser(token: string, userId: string): Promise<GetUserResult> {
      const res = await fetch(`${baseURL}${getGetUserUrl(userId)}`, {
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
    async follow(token: string, userId: string): Promise<FollowResult> {
      const res = await fetch(`${baseURL}${getFollowUserUrl(userId)}`, {
        method: 'POST',
        headers: {
          Accept: 'application/json, application/problem+json',
          Authorization: `Bearer ${token}`,
        },
      })
      const text = await res.text()
      const body = text.length > 0 ? JSON.parse(text) : {}
      return { status: res.status, body }
    },
    async unfollow(token: string, userId: string): Promise<UnfollowResult> {
      const res = await fetch(`${baseURL}${getUnfollowUserUrl(userId)}`, {
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
    async getFollowStats(
      token: string,
      userId: string,
    ): Promise<GetFollowStatsResult> {
      const res = await fetch(`${baseURL}${getGetFollowStatsUrl(userId)}`, {
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
    async getFeed(
      token: string,
      params?: GetFeedParams,
    ): Promise<GetFeedResult> {
      const res = await fetch(`${baseURL}${getGetFeedUrl(params)}`, {
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
  }
}
