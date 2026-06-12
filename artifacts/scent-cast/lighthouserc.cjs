module.exports = {
  ci: {
    collect: {
      startServerCommand: 'node ./scripts/lhci-preview.cjs',
      startServerReadyPattern: 'LHCI preview ready',
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
        'total-blocking-time': ['error', { maxNumericValue: 1200 }],
        'cumulative-layout-shift': ['error', { maxNumericValue: 0.12 }],
        'resource-summary:script:size': ['error', { maxNumericValue: 525000 }],
      },
    },
    upload: {
      target: 'filesystem',
      outputDir: '.local/lighthouse-ci',
    },
  },
};
