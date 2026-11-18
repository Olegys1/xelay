interface ImportMeta {
  readonly hot?: { dispose(cleanup: () => void): void }
  readonly env: {
    readonly DEV: boolean
    readonly PROD: boolean
    readonly MODE: string
    readonly VITE_SUPABASE_URL: string
    readonly VITE_SUPABASE_ANON_KEY: string
    readonly VITE_GOOGLE_AUTH_ENABLED?: string
  }
}
declare module '*?url' {
  const url: string
  export default url
}
declare module '*?worker-url' {
  const url: string
  export default url
}
declare module '*.css' {}
declare module '*.mp4' {
  const url: string
  export default url
}
declare module '*.webp' {
  const url: string
  export default url
}
declare module '*.png' {
  const url: string
  export default url
}
