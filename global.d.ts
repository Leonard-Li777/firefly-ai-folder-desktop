declare global {
  const __APP_VERSION__: string
  const VITE_POSTHOG_HOST: string
  const VITE_POSTHOG_KEY: string
  const IS_DEV: boolean
  const IS_PROD: boolean
  interface Window {
    __APP_VERSION__: string
    VITE_POSTHOG_HOST: string
    VITE_POSTHOG_KEY: string
    IS_DEV: boolean
    IS_PROD: boolean
  }
}
