import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: '/s3-proxy/:path*',
        destination: 'https://s3.onepiece-index.com/:path*',
      },
    ];
  },
};
export default nextConfig;
