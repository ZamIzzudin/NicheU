/** @type {import('next').NextConfig} */
// IMPORTANT: rewrites() is evaluated at BUILD time for `next start`.
// Docker image MUST bake API_PORT=4000 during `npm run build`.
// Local default: API usually on 3000, web on 3001.
const apiPort = process.env.API_PORT || process.env.BACKEND_PORT || '3000';

console.log(`[next.config] API rewrite target -> http://127.0.0.1:${apiPort}/api/*`);

const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: `http://127.0.0.1:${apiPort}/api/:path*`,
      },
    ];
  },
};

module.exports = nextConfig;
