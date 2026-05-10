import { getSignupUrl } from '../api/generated/auth-controller/auth-controller.ts'
import type { SignupRequest, UserResponse, ProblemDetail } from '../api/generated/openAPIDefinition.schemas.ts'

export interface SignupResult {
  status: number
  body: UserResponse | ProblemDetail
}

export interface ApiClient {
  baseURL: string
  signup(input: SignupRequest): Promise<SignupResult>
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
  }
}
