/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  transpilePackages: ['@rag/contracts'],
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
