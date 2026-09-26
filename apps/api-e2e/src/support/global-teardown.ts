module.exports = async function globalTeardown() {
  // The API process is owned by the Nx/CI job, not by Jest. Killing port 3000
  // here could terminate an unrelated local development server.
  console.log(
    (globalThis as { __TEARDOWN_MESSAGE__?: string }).__TEARDOWN_MESSAGE__ ??
      '\nAPI E2E teardown complete.\n',
  );
};
