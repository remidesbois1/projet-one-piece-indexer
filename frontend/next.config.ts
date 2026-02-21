import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '**',
      },
    ],
  },
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
