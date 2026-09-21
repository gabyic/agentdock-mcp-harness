export async function gracefulServiceShutdown({
  runtime,
  signal,
  beginShutdown,
  closeTransport,
  processGraceMs = 5000,
  processKillWaitMs = 1000,
  logger = (message) => console.error(message),
} = {}) {
  if (!runtime?.processService) {
    throw new TypeError("runtime.processService is required.");
  }

  logger("AgentDock received " + signal + "; shutting down.");

  let acceptingStopped = false;
  try {
    if (beginShutdown) {
      await beginShutdown();
      acceptingStopped = true;
    }

    const processResult = await runtime.processService.shutdownOwned({
      graceMs: processGraceMs,
      killWaitMs: processKillWaitMs,
    });

    if (closeTransport) {
      await closeTransport();
    }

    return {
      signal,
      accepting_stopped: acceptingStopped,
      process_shutdown: processResult,
    };
  } catch (error) {
    logger(
      "AgentDock shutdown failed: " +
        (error?.message ?? String(error)),
    );
    throw error;
  }
}

export function installSignalHandlers({
  runtime,
  beginShutdown,
  closeTransport,
  processGraceMs = 5000,
  processKillWaitMs = 1000,
  logger,
  exit = (code) => process.exit(code),
} = {}) {
  let shuttingDown = false;

  const handle = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;

    try {
      await gracefulServiceShutdown({
        runtime,
        signal,
        beginShutdown,
        closeTransport,
        processGraceMs,
        processKillWaitMs,
        logger,
      });
      exit(0);
    } catch {
      exit(1);
    }
  };

  const onSigint = () => void handle("SIGINT");
  const onSigterm = () => void handle("SIGTERM");

  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  return {
    handle,
    dispose() {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    },
  };
}
