/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    // API is private inside container (default 4000 in Docker; 3000 in local dev).
    // Do NOT use process.env.PORT — Next overwrites it with the web listen port.
    const apiPort = process.env.API_PORT || process.env.BACKEND_PORT || 3000;
    return [
      {
        source: '/api/:path*',
        destination: `http://127.0.0.1:${apiPort}/api/:path*`,
      },
    ];
  },
};

module.exports = nextConfig;
