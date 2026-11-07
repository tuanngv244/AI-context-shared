export default {
  poweredByHeader: false,
  distDir: process.env.SCE_NEXT_DIST_DIR ?? '.next',
  typescript: { tsconfigPath: process.env.SCE_NEXT_TSCONFIG ?? 'tsconfig.json' },
  experimental: { cpus: 2 },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};
