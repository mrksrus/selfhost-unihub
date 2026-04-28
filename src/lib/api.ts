// API client for UniHub backend

const API_URL = import.meta.env.VITE_API_URL || '/api';

interface ApiResponse<T> {
  data?: T;
  error?: string;
  status?: number;
  [key: string]: unknown;
}

interface BlobResponse {
  blob: Blob;
  filename?: string;
  contentType?: string;
}

function isBrowserOffline() {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

function getNetworkErrorMessage(error: unknown) {
  if (isBrowserOffline()) {
    return 'No network connection. Check Wi-Fi, mobile data, or local network access, then try again.';
  }

  if (error instanceof DOMException && error.name === 'AbortError') {
    return 'The server was reached, but it did not respond before the request timed out.';
  }

  const message = error instanceof Error ? error.message : '';
  if (/failed to fetch|load failed|networkerror|network error/i.test(message)) {
    return 'Could not reach the UniHub API. The browser is online, but the server did not respond.';
  }

  return message || 'Network request failed before the server returned a response.';
}

function getHttpErrorMessage(status: number, statusText: string) {
  if (status === 401) return 'Session expired or authentication is required. Sign in again.';
  if (status === 403) return 'Request rejected by the server. Refresh the app and try again.';
  if (status === 404) return 'The requested API endpoint was not found.';
  if (status === 408 || status === 504) return `The server or proxy did not respond in time (${status}).`;
  if (status === 502 || status === 503) return `The API is temporarily unavailable (${status}). Check that the server is running.`;
  if (status >= 500) return `The server returned an internal error (${status}).`;
  if (status >= 400) return `Request failed (${status}${statusText ? ` ${statusText}` : ''}).`;
  return `Unexpected response (${status}${statusText ? ` ${statusText}` : ''}).`;
}

function getUnexpectedResponseMessage(response: Response, contentType: string) {
  const received = contentType || 'no content type';
  if (response.ok) {
    return `The server responded, but not with JSON (${received}). Check proxy or server routing.`;
  }
  return `${getHttpErrorMessage(response.status, response.statusText)} The response was not JSON (${received}).`;
}

class ApiClient {
  private baseUrl: string;
  private csrfToken: string | null = null;

  constructor(baseUrl: string = API_URL) {
    this.baseUrl = baseUrl;
  }

  setCsrfToken(token: string | null) {
    this.csrfToken = token;
  }

  private resolveUrl(endpoint: string): string {
    if (/^https?:\/\//i.test(endpoint)) {
      throw new Error('Absolute API URLs are not allowed.');
    }
    return `${this.baseUrl}${endpoint}`;
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<ApiResponse<T>> {
    let url: string;
    try {
      url = this.resolveUrl(endpoint);
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : 'Invalid API endpoint',
      };
    }
    
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
      ...options.headers,
    };

    // Add CSRF token for state-changing requests (POST, PUT, DELETE)
    const method = options.method?.toUpperCase() || 'GET';
    if (this.csrfToken && ['POST', 'PUT', 'DELETE'].includes(method)) {
      headers['X-CSRF-Token'] = this.csrfToken;
    }

    try {
      const response = await fetch(url, {
        ...options,
        headers,
        credentials: 'include',
      });

      const contentType = response.headers.get('content-type') || '';
      const isJson = contentType.includes('application/json');

      if (!isJson) {
        const text = await response.text();
        const preview = text.slice(0, 80).replace(/\s+/g, ' ');
        return {
          status: response.status,
          error: getUnexpectedResponseMessage(response, contentType),
          details: preview,
        };
      }

      let data: Record<string, unknown>;
      try {
        data = await response.json();
      } catch {
        return {
          status: response.status,
          error: 'The server responded with invalid JSON. Check the API logs or proxy configuration.',
        };
      }

      if (!response.ok) {
        return {
          ...data,
          status: response.status,
          error: typeof data.error === 'string' ? data.error : getHttpErrorMessage(response.status, response.statusText),
          details: data.details,
        };
      }

      return { data };
    } catch (error) {
      return {
        error: getNetworkErrorMessage(error),
      };
    }
  }

  async get<T>(endpoint: string): Promise<ApiResponse<T>> {
    return this.request<T>(endpoint, { method: 'GET' });
  }

  async getBlob(endpoint: string): Promise<BlobResponse> {
    const url = this.resolveUrl(endpoint);
    const headers: HeadersInit = {};

    const response = await fetch(url, {
      method: 'GET',
      headers,
      credentials: 'include',
    });

    if (!response.ok) {
      const contentType = response.headers.get('content-type') || '';
      let message = `Request failed (${response.status})`;

      try {
        if (contentType.includes('application/json')) {
          const data = await response.json();
          message = data.error || message;
        } else {
          const text = await response.text();
          if (text) message = text;
        }
      } catch {
        // Keep fallback message
      }

      const err = new Error(message) as Error & { status?: number };
      err.status = response.status;
      throw err;
    }

    const blob = await response.blob();
    const contentDisposition = response.headers.get('content-disposition') || '';
    let filename: string | undefined;

    const utf8Match = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i);
    if (utf8Match?.[1]) {
      try {
        filename = decodeURIComponent(utf8Match[1]);
      } catch {
        filename = utf8Match[1];
      }
    } else {
      const basicMatch = contentDisposition.match(/filename="?([^"]+)"?/i);
      if (basicMatch?.[1]) filename = basicMatch[1];
    }

    return {
      blob,
      filename,
      contentType: response.headers.get('content-type') || undefined,
    };
  }

  async post<T>(endpoint: string, body?: unknown): Promise<ApiResponse<T>> {
    return this.request<T>(endpoint, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async put<T>(endpoint: string, body?: unknown): Promise<ApiResponse<T>> {
    return this.request<T>(endpoint, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
  }

  async delete<T>(endpoint: string): Promise<ApiResponse<T>> {
    return this.request<T>(endpoint, { method: 'DELETE' });
  }
}

export const api = new ApiClient();
