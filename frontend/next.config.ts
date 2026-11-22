import type { NextConfig } from "next";

/**
 * The browser only ever calls /api/v1 on this website. Next forwards those
 * requests to the backend (Render), so the login cookie stays same-site.
 * BACKEND_URL is read at build/start time: http://127.0.0.1:4000 locally,
 * https://<service>.onrender.com on Vercel.
 */
const backendUrl = (process.env.BACKEND_URL ?? "http://127.0.0.1:4000").replace(/\/+$/, "");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  experimental: {
    // The free backend sleeps and can need up to a minute to wake up.
    proxyTimeout: 120_000,
  },
  async rewrites() {
    return [{ source: "/api/v1/:path*", destination: `${backendUrl}/api/v1/:path*` }];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
