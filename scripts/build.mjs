// One small bundle per Lambda (the AWS SDK v3 ships with the nodejs22.x runtime, so it stays external).
import { build } from 'esbuild';

for (const name of ['ingest', 'query', 'admin']) {
  await build({
    entryPoints: [`src/handlers/${name}.ts`],
    outfile: `dist/${name}/index.mjs`,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    minify: true,
    sourcemap: true,
    external: ['@aws-sdk/*'],
    banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
  });
  console.log(`dist/${name}/index.mjs`);
}
