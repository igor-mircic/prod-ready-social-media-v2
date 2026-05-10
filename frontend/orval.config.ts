import { defineConfig } from 'orval'

const SPEC = '../openapi/openapi.json'

const MUTATOR = {
  path: './src/api/client.ts',
  name: 'apiFetch',
  default: true,
} as const

export default defineConfig({
  queries: {
    input: SPEC,
    output: {
      mode: 'tags-split',
      target: './src/api/generated/queries',
      client: 'react-query',
      override: {
        mutator: MUTATOR,
        query: {
          useQuery: true,
          useMutation: true,
          signal: true,
        },
      },
      clean: true,
    },
  },
  schemas: {
    input: SPEC,
    output: {
      mode: 'tags-split',
      target: './src/api/generated/schemas',
      client: 'zod',
      fileExtension: '.zod.ts',
      clean: true,
    },
  },
  mocks: {
    input: SPEC,
    output: {
      mode: 'tags-split',
      target: './src/api/generated/msw',
      client: 'react-query',
      mock: {
        type: 'msw',
        useExamples: false,
      },
      override: {
        mutator: MUTATOR,
      },
      clean: true,
    },
  },
})
