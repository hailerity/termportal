import {
  API_BASE_PATH,
  apiErrorResponseSchema,
  listSessionsResponseSchema,
  terminalSessionResponseSchema,
  type CreateSessionRequest,
  type ErrorCode,
  type TerminalSessionResponse,
} from '@termportal/api-contract';

/** A failed API call, carrying the server's stable error code when there was one. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode | 'NETWORK_ERROR' | 'UNEXPECTED_RESPONSE',
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface SessionApi {
  create(request?: CreateSessionRequest): Promise<TerminalSessionResponse>;
  list(): Promise<TerminalSessionResponse[]>;
  get(id: string): Promise<TerminalSessionResponse>;
  terminate(id: string): Promise<void>;
}

/** REST client for the control plane. `baseUrl` is empty when the API is same-origin. */
export function createSessionApi(baseUrl = '', fetchFn: typeof fetch = fetch): SessionApi {
  const root = `${baseUrl}${API_BASE_PATH}/sessions`;

  async function request(url: string, init?: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchFn(url, init);
    } catch {
      throw new ApiError(0, 'NETWORK_ERROR', 'The terminal server is unreachable.');
    }
    if (response.status === 204) return undefined;
    const body: unknown = await response.json().catch(() => undefined);
    if (response.ok) return body;
    const error = apiErrorResponseSchema.safeParse(body);
    if (error.success) {
      throw new ApiError(response.status, error.data.error.code, error.data.error.message);
    }
    throw new ApiError(
      response.status,
      'UNEXPECTED_RESPONSE',
      `Request failed (${response.status}).`,
    );
  }

  function parse<T>(
    schema: { safeParse(v: unknown): { success: boolean; data?: T } },
    body: unknown,
  ) {
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(200, 'UNEXPECTED_RESPONSE', 'The server sent an unexpected response.');
    }
    return parsed.data as T;
  }

  return {
    async create(body = {}) {
      const response = await request(root, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return parse(terminalSessionResponseSchema, response);
    },
    async list() {
      return parse(listSessionsResponseSchema, await request(root)).sessions;
    },
    async get(id) {
      return parse(
        terminalSessionResponseSchema,
        await request(`${root}/${encodeURIComponent(id)}`),
      );
    },
    async terminate(id) {
      await request(`${root}/${encodeURIComponent(id)}`, { method: 'DELETE' });
    },
  };
}
