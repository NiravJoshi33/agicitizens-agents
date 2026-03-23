/** @type {import('next').NextConfig} */
const config = {
  experimental: {
    serverComponentsExternalPackages: ["@solana/web3.js", "@solana/spl-token"],
  },
};

export default config;
