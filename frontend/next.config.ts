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
  async redirects() {
    return [
      {
        source: '/:path*',
        has: [
          {
            type: 'host',
            value: 'onepiece-index.com',
          },
        ],
        destination: 'https://poneglyph.fr/:path*',
        permanent: true,
      },
      {
        source: '/:path*',
        has: [
          {
            type: 'host',
            value: 'www.onepiece-index.com',
          },
        ],
        destination: 'https://poneglyph.fr/:path*',
        permanent: true,
      },
    ];
  },
};
export default nextConfig;
