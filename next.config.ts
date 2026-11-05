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
 * Google Drive's file picker page (Integration Hub) is the one page that loads Google's scripts and shows
 * Google's picker in a frame. Its policy allows exactly those Google hosts, and lets Google's sign-in window
 * answer the page (same-origin-allow-popups); every other page keeps the strict policy above.
 */
const googlePickerHeaders = [
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      `script-src 'self' 'unsafe-inline'${isProd ? "" : " 'unsafe-eval'"} https://apis.google.com https://accounts.google.com`,
      "style-src 'self' 'unsafe-inline' https://accounts.google.com",
      "img-src 'self' data: https://*.googleusercontent.com https://ssl.gstatic.com https://www.gstatic.com",
      "font-src 'self'",
      "connect-src 'self' https://accounts.google.com https://apis.google.com https://content.googleapis.com https://www.googleapis.com",
      "frame-src https://docs.google.com https://drive.google.com https://accounts.google.com https://content.googleapis.com",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "object-src 'none'",
    ].join("; "),
  },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
  // Google's picker checks which site opened it; the address of this page carries nothing private.
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  serverExternalPackages: ["pg"],
  async headers() {
    // Later entries replace earlier ones for the same header, so the picker page's policy comes last.
    return [
      { source: "/:path*", headers: securityHeaders },
      { source: "/integrations/:id/pick", headers: googlePickerHeaders },
    ];
  },
};

export default nextConfig;
