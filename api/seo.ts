import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { createPublicQuestionSeoHandler, publicSupabaseConfiguration } from '../server/publicQuestionSeo.js'

export default createPublicQuestionSeoHandler({
  loadTemplate: () => readFile(join(process.cwd(), 'dist/index.html'), 'utf8'),
  loadQuestion: async id => {
    const configuration = publicSupabaseConfiguration(process.env)
    if (!configuration) throw new Error('PUBLIC_SEO_UNAVAILABLE')
    const client = createClient(configuration.url, configuration.key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(5000) }) },
    })
    // Always anonymous RLS. Never select author identity, uploads, tokens or private study data.
    return client.from('questions').select('id, content, category, created_at').eq('id', id).maybeSingle()
  },
})
