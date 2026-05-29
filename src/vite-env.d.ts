/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_FINNHUB_TOKEN?: string;
  readonly VITE_QUOTE_POLL_MS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
