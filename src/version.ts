// Injected by tsup at build time via define: { '__SERVICE_VERSION__': '...' }
// typeof guard makes it safe in dev mode (tsx) where the define replacement doesn't run
declare const __SERVICE_VERSION__: string;
export const VERSION: string =
  typeof __SERVICE_VERSION__ !== 'undefined'
    ? __SERVICE_VERSION__
    : (process.env.npm_package_version ?? '0.0.0-dev');
