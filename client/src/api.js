const TOKEN_KEY = 'codespace_token';

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (token) =>
  token ? localStorage.setItem(TOKEN_KEY, token) : localStorage.removeItem(TOKEN_KEY);

export async function api(path, { method = 'GET', body } = {}) {
  const token = getToken();
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token) {
    setToken(null);
    window.location.assign('/login');
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

export const projectApi = (id) => ({
  get: () => api(`/projects/${id}`),
  tree: () => api(`/projects/${id}/tree`),
  read: (path) => api(`/projects/${id}/file?path=${encodeURIComponent(path)}`),
  write: (path, content) => api(`/projects/${id}/file`, { method: 'PUT', body: { path, content } }),
  create: (path, type) => api(`/projects/${id}/fs`, { method: 'POST', body: { path, type } }),
  rename: (from, to) => api(`/projects/${id}/fs`, { method: 'PATCH', body: { from, to } }),
  remove: (path) => api(`/projects/${id}/fs?path=${encodeURIComponent(path)}`, { method: 'DELETE' }),
});
