export function parseBearerCredential(
  rawHeaders: readonly string[],
): string | undefined {
  const authorizationValues: string[] = [];

  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === 'authorization') {
      authorizationValues.push(rawHeaders[index + 1] ?? '');
    }
  }

  if (authorizationValues.length !== 1) {
    return undefined;
  }

  const match = /^Bearer ([^\s]+)$/i.exec(authorizationValues[0]);
  return match?.[1];
}
