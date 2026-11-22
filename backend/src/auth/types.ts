import "@fastify/jwt";

/** What the login cookie's JWT carries: admin id and the session version at login. */
export interface SessionClaims {
  sub: string;
  sv: number;
}

export interface CurrentAdmin {
  id: string;
  email: string;
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: SessionClaims;
    user: SessionClaims & { iat?: number; exp?: number };
  }
}

declare module "fastify" {
  interface FastifyRequest {
    /** Set by app.authenticate; null on public routes. */
    admin: CurrentAdmin | null;
  }
  interface FastifyInstance {
    /** preHandler for protected routes: verifies the session cookie or throws 401. */
    authenticate: (request: FastifyRequest) => Promise<void>;
  }
}
