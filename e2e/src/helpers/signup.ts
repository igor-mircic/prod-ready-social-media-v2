import { randomUUID } from 'node:crypto'
import type { ApiClient, SignupResult } from './apiClient.ts'
import type { SignupRequest, UserResponse } from '../api/generated/openAPIDefinition.schemas.ts'

export function randomSignupInput(overrides: Partial<SignupRequest> = {}): SignupRequest {
  return {
    email: `user-${randomUUID()}@example.test`,
    password: 'CorrectHorse9!',
    displayName: 'Test User',
    ...overrides,
  }
}

export async function signupViaApi(
  client: ApiClient,
  input: SignupRequest,
): Promise<UserResponse> {
  const result: SignupResult = await client.signup(input)
  if (result.status !== 201) {
    throw new Error(
      `signupViaApi expected 201 but got ${result.status}: ${JSON.stringify(result.body)}`,
    )
  }
  return result.body as UserResponse
}
