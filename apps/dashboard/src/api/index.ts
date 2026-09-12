/**
 * Single entry point for the dashboard's network layer.
 *
 * Views import from `@/api` and never from a deeper path, so the transport can
 * be reorganised without touching call sites.
 */
export * from "./client";
export * as api from "./client";
