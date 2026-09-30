import express from 'express';
import { basename } from 'node:path';

/** Keep model/runtime failures as HTTP errors, rather than a successful HTML page. */
export function siteAssets(folder: string) {
  return express.static(folder, {
    fallthrough: false,
    maxAge: 0,
    setHeaders(response, file) {
      const hashed = /-[A-Z0-9]{8}\.(?:js|css)$/.test(basename(file));
      response.setHeader('Cache-Control', hashed ? 'public, max-age=31536000, immutable' : 'no-cache');
    }
  });
}

/** IPv6 loopback includes colons and may arrive bracketed with a port. */
export function normalizeHost(host: string | undefined): string {
  const value = (host ?? '').split(',')[0].trim().toLowerCase();
  if (!value || value === '::1') return value;
  try { return new URL(`http://${value}`).hostname.replace(/^\[|\]$/g, ''); }
  catch { return value; }
}
