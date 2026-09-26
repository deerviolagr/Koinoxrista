import { waitForPortOpen } from '@nx/node/utils';

import { API_HOST, API_PORT, apiUrl } from './config';

/* eslint-disable */
var __TEARDOWN_MESSAGE__: string;

module.exports = async function globalSetup() {
  console.log('\nSetting up API E2E dependencies...\n');
  await waitForPortOpen(API_PORT, { host: API_HOST, retries: 60, retryDelay: 1_000 });

  const healthUrl = apiUrl('/');
  const deadline = Date.now() + 30_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(healthUrl);
      if (response.ok) {
        (globalThis as { __TEARDOWN_MESSAGE__?: string }).__TEARDOWN_MESSAGE__ =
          '\nAPI E2E dependencies are ready.\n';
        return;
      }
      lastError = new Error(`health check returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `API did not become ready at ${healthUrl}: ${String(lastError)}`,
  );
};
