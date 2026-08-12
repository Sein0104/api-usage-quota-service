interface RequestTarget {
  method: string;
  originalUrl: string;
}

const bootstrapPaths = new Set(['/v1/admin/projects', '/v1/admin/projects/']);

export function isSystemAdminProjectBootstrapRequest(
  request: RequestTarget,
): boolean {
  const path = request.originalUrl.split('?', 1)[0].toLowerCase();
  return request.method === 'POST' && bootstrapPaths.has(path);
}
