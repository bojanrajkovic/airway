import pg from "pg";

/** Runs `run` with a connected client, and closes it whether `run` returns or throws. */
export async function withClient<T>(
  url: string,
  run: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client(url);
  await client.connect();

  try {
    return await run(client);
  } finally {
    await client.end();
  }
}
