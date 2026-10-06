import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  typedRoutes: true,
  // Required by the Dockerfile in .pipeline/infra-spec.md:70. Without it the
  // image has no server.js and the container will not start (finding S9).
  output: 'standalone',
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'Content-Security-Policy',
            // No third-party origins in this app. 'unsafe-inline' on
            // style-src is required by Tailwind v4's runtime style
            // injection.
            //
            // 'unsafe-inline' on script-src (finding B1, fix pass 2): the
            // App Router serves its RSC bootstrap payload
            // ((self.__next_f=self.__next_f||[]).push(...)) as inline
            // <script> tags with no src and no nonce. A strict script-src
            // with neither 'unsafe-inline' nor a nonce blocks every one of
            // them, React never hydrates, and the app renders as static,
            // unresponsive HTML. A nonce via middleware.ts is the stricter
            // fix, but it forces every route (including the currently
            // static /rules, /history, /profile, /offline) to render
            // dynamically per request, which this app does not need. The
            // threat model here is a handful of friends on a LAN/Tailscale
            // game night, not a hostile multi-tenant surface, so the
            // weaker-but-honest, app-actually-works option is the right
            // call. Verified empirically against the standalone server,
            // see .pipeline/changes.md, fix pass 2.
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data:",
              "connect-src 'self'",
              "font-src 'self'",
              "frame-ancestors 'none'",
              "base-uri 'none'",
              "form-action 'self'",
              "object-src 'none'",
            ].join('; '),
          },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
          },
          // cloudflared terminates TLS at the edge, so the pod only ever
          // sees plain HTTP and will not emit this header on its own.
          { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
        ],
      },
    ];
  },
};

export default nextConfig;
