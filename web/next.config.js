/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    // Do NOT use process.env.PORT here: Next sets PORT to the web port (3001).
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
