import type { NimbusApi } from './index'

declare global {
  interface Window {
    nimbus: NimbusApi
  }
}
