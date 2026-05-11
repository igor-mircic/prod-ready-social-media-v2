import { getMeUrl } from '../api/generated/auth-controller/auth-controller.ts'
import type { ApiClient, LoginResult } from './apiClient.ts'
import type {
  LoginRequest,
  LoginResponse,
  UserResponse,
} from '../api/generated/openAPIDefinition.schemas.ts'

export async function loginViaApi(
  client: ApiClient,
  input: LoginRequest,
): Promise<{ accessToken: string; userId: string }> {
  const result: LoginResult = await client.login(input)
  if (result.status !== 200) {
    throw new Error(
      `loginViaApi expected 200 but got ${result.status}: ${JSON.stringify(result.body)}`,
    )
  }
  const { accessToken } = result.body as LoginResponse

  const meRes = await fetch(`${client.baseURL}${getMeUrl()}`, {
    method: 'GET',
    headers: {
      Accept: 'application/json, application/problem+json',
      Authorization: `Bearer ${accessToken}`,
    },
  })
  if (meRes.status !== 200) {
    throw new Error(
      `loginViaApi: GET /me expected 200 but got ${meRes.status}: ${await meRes.text()}`,
    )
  }
  const me = (await meRes.json()) as UserResponse
  if (!me.id) {
    throw new Error(`loginViaApi: /me response missing id: ${JSON.stringify(me)}`)
  }
  return { accessToken, userId: me.id }
}
