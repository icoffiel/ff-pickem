// TEMPORARY — verifies the CI gate catches a lint failure. Reverted next commit.
async function ciRedtest(): Promise<number> {
  return 1;
}

ciRedtest(); // no-floating-promises: intentional violation
