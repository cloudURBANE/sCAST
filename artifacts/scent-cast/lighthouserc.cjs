module.exports = {
  ci: {
    collect: {
      startServerCommand: 'corepack pnpm --filter @workspace/scent-cast exec vite preview --config vite.config.ts --host 0.0.0.0 --port 4177',
      startServerReadyPattern: 'Local:',
      startServerReadyTimeout: 60000,
      url: [
        'http://127.0.0.1:4177/',
        'http://127.0.0.1:4177/community',
        'http://127.0.0.1:4177/arena',
      ],
      numberOfRuns: 1,
      settings: {
        preset: 'desktop',
        onlyCategories: ['performance'],
        maxWaitForLoad: 35000,
      },
    },
    assert: {
      assertions: {
        'categories:performance': ['warn', { minScore: 0.5 }],
        'total-blocking-time': ['warn', { maxNumericValue: 1200 }],
        'cumulative-layout-shift': ['warn', { maxNumericValue: 0.12 }],
        'resource-summary:script:size': ['warn', { maxNumericValue: 525000 }],
      },
    },
    upload: {
      target: 'filesystem',
      outputDir: '.local/lighthouse-ci',
    },
  },
};
