/** Switch only after installation completes; restore the running binary on failure. */
export async function switchServer(
  client: { stop(): Promise<void>; start(): Promise<void> },
  options: { command: string },
  command: string,
  select: (command: string) => Promise<void>,
  remove?: (command: string) => Promise<void>,
): Promise<void> {
  const previous = options.command
  try {
    await client.stop()
    await select(command)
    options.command = command
    await client.start()
  } catch (error) {
    options.command = previous
    if (!previous || previous === command) {
      if (remove && command !== previous) await remove(command).catch(() => {})
      throw error
    }
    try {
      await client.stop()
      await select(previous)
      await client.start()
    } catch (recoveryError) {
      if (remove && command !== previous) await remove(command).catch(() => {})
      throw new Error(`Server switch failed: ${String(error)}. Recovery failed: ${String(recoveryError)}`)
    }
    if (remove && command !== previous) await remove(command).catch(() => {})
    throw new Error(`Server switch failed: ${String(error)}. Previous server restored.`)
  }
}
