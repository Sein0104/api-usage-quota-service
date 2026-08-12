export interface RequestContext {
  receivedAt: Date;
  requestId: string;
}

declare global {
  namespace Express {
    interface Request {
      requestContext?: RequestContext;
    }
  }
}

export {};
