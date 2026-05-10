import { defineConfig } from 'orval'

const SPEC = '../openapi/openapi.json'

export default defineConfig({
  api: {
    input: SPEC,
    output: {
      mode: 'tags-split',
      target: './src/api/generated',
      client: 'fetch',
      baseUrl: '',
      clean: true,
      override: {
        fetch: {
          includeHttpResponseReturnType: true,
        },
      },
    },
  },
})
