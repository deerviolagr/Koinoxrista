const apiUrl =
  process.env['E2E_API_URL'] ??
  `http://${process.env['E2E_HOST'] ?? '127.0.0.1'}:${process.env['E2E_PORT'] ?? '3000'}/api`;

async function waitForApi(): Promise<void> {
  const deadline = Date.now() + 60_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(apiUrl);
      if (response.ok) return;
      lastError = new Error(`API health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`API did not become ready at ${apiUrl}: ${String(lastError)}`);
}

export default async function globalSetup(): Promise<void> {
  await waitForApi();
}
