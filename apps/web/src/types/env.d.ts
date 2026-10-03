// What Vite puts in import.meta.env at build time. Only the variables the app reads are listed.
interface ImportMetaEnv {
  /** The commit this build is from (apps/web/Dockerfile), for error reports. */
  readonly VITE_PURRLOR_VERSION?: string;
}

interface ImportMeta {
  readonly env?: ImportMetaEnv;
}
