import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";

const securityHeaders = [
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      // Next.js needs inline scripts for hydration; tighten with nonces later.
      `script-src 'self' 'unsafe-inline'${isProd ? "" : " 'unsafe-eval'"}`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "object-src 'none'",
    ].join("; "),
  },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Keeps one-time invitation links out of other sites' logs.
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  ...(isProd ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" }] : []),
];

/**
 * Google Drive's file picker page only (Phase 9.2b): Google's picker and sign-in scripts, its picker frame
 * and its sign-in window. Every other page keeps the strict policy above. Listed after it, so it replaces
 * those two headers on this one path.
 */
const pickerHeaders = [
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      `script-src 'self' 'unsafe-inline'${isProd ? "" : " 'unsafe-eval'"} https://apis.google.com https://accounts.google.com/gsi/client https://www.gstatic.com`,
      "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style",
      "img-src 'self' data: https://*.googleusercontent.com https://www.gstatic.com https://ssl.gstatic.com",
      "font-src 'self'",
      "frame-src https://docs.google.com https://drive.google.com https://accounts.google.com https://content.googleapis.com",
      "connect-src 'self' https://accounts.google.com/gsi/ https://www.googleapis.com https://content.googleapis.com",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "object-src 'none'",
    ].join("; "),
  },
  // Google's sign-in window reports back to the page that opened it.
  { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  serverExternalPackages: ["pg"],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }, { source: "/integrations/:id/pick", headers: pickerHeaders }];
  },
};

export default nextConfig;
