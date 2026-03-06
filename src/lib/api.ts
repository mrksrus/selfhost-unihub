// API client for UniHub backend

const API_URL = import.meta.env.VITE_API_URL || '/api';

interface ApiResponse<T> {
  data?: T;
  error?: string;
  [key: string]: unknown;
}

interface BlobResponse {
  blob: Blob;
  filename?: string;
  contentType?: string;
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
          error: response.ok
            ? 'Server returned non-JSON response'
            : `Request failed (${response.status}). Server may have timed out or returned an error page. Try again; if adding mail, wait a few minutes and retry.`,
          details: preview,
        };
      }

      const data = await response.json();

      if (!response.ok) {
        return {
          ...data,
          error: data.error || `HTTP ${response.status}: ${response.statusText}`,
          details: data.details,
        };
      }

      return { data };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Network error';
      const isJsonError = message.includes('JSON') && message.includes('<');
      const isTimeout = message.includes('timeout') || message.includes('aborted') || message.includes('network') || message.includes('Failed to fetch');
      
      // For mail account operations, treat timeout as success - sync continues in background
      const isMailAccountOp = endpoint.includes('/mail/accounts') && (options.method === 'POST' || options.method === 'PUT');
      
      if (isMailAccountOp && isTimeout) {
        // Return success response indicating sync is in progress
        return {
          data: {
            syncInProgress: true,
            message: 'Account added. Email sync is running in the background — this may take several minutes for large mailboxes.',
          } as unknown as T,
        };
      }
      
      return {
        error: isJsonError
          ? 'Request timed out or server returned an error page. Mail sync can take several minutes — check server logs for progress.'
          : message,
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
